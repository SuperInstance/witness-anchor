// THE FLEET'S OUT-OF-BAND WITNESS ANCHOR.
//
// A Cloudflare Worker with four bindings, and one job: hold the fleet's
// signed witness heads somewhere the log writer does not control, and
// compute the linkage class of each one FROM EVIDENCE.
//
//   KV   -- the published heads, and the refusal to overwrite them
//   R2   -- the witness logs themselves (immutable objects, content-addressed)
//   D1   -- the index: which chains, which heads, which epochs
//   VECTORS (optional) -- semantic retrieval over the published claims
//
// THE HONEST PART IS THE POINT. The fleet spent a year calling its logs
// "tamper-evident" when they were not. This Worker cannot fix that by
// being clever. It fixes it by:
//
//   1. RE-DDERIVING the chain it is given, so leg 1 is measured;
//   2. VERIFYING the head's signature against a trusted key, so leg 2 is
//      measured;
//   3. REFUSING to call anything tamper-evident unless the anchor OBSERVED
//      that the log came from a different account -- an account the
//      publisher merely ASSERTS is not evidence;
//   4. and SAYING, in every response, which of those it actually did.
//
// A Worker on the fleet's own Cloudflare account is NOT out of band. The
// account is the unit of control, and the log writer can push to the
// account. So the class is computed from the two accounts and their
// evidence, and the strong word is earned or not earned -- never
// requested.
//
// AND THE VECTOR STORE. Cloudflare's Vectorize is remote-only: a local
// Worker that touches a VECTORS binding fails with "Binding VECTORS needs
// to be run remotely". So the store has a SECOND implementation over D1
// that is EXACT, and the Worker cannot tell them apart -- same interface,
// same shapes. Every response says which backend served it, so an
// approximate answer is never passed off as an exact one.

import { classify } from './classify.js';
import { detectDialect, DIALECTS, linkageOf, parseChainJsonl } from './dialects.js';
import { makeVectorStore } from './vectorstore.js';
import { embed, EMBEDDER_ID } from './embed.js';

const KEYRING_VAR = 'TRUSTED_KEYS';   // JSON: {keyId: base64}
const ACCOUNT_VAR = 'ACCOUNT_ID';     // this anchor's own Cloudflare account

const enc = new TextEncoder();

async function hmacVerify(keyBytes, head, signatureB64) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = signatureToBytes(signatureB64);
  const msg = new Uint8Array(1 + enc.encode(head).length);
  msg[0] = 0x03;
  msg.set(enc.encode(head), 1);
  return crypto.subtle.verify('HMAC', key, sig, msg);
}

async function ed25519Verify(pubKeyB64, head, signatureB64) {
  const key = await crypto.subtle.importKey(
    'raw', b64ToBytes(pubKeyB64), { name: 'Ed25519' }, false, ['verify']);
  const msg = new Uint8Array(1 + enc.encode(head).length);
  msg[0] = 0x03;
  msg.set(enc.encode(head), 1);
  return crypto.subtle.verify('Ed25519', key, signatureToBytes(signatureB64), msg);
}

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// A SIGNATURE ARRIVES IN WHICHEVER FORM THE SIGNER USED, and the fleet has
// TWO forms in play:
//
//   * recorder.py's sign_head() returns HEX with an "0x" prefix:
//         "0x" + hmac.new(key, b"\x03" + head).hexdigest()
//   * most other signers return BASE64.
//
// The anchor accepts BOTH, because an anchor that only accepts one of them
// is an anchor the fleet's own reference implementation cannot use -- and
// the whole point of the anchor is that the fleet's logs can be published
// to it. The format is detected from the string, not asked for.
function signatureToBytes(sig) {
  const t = String(sig).trim();
  if (/^0x[0-9a-fA-F]+$/.test(t)) {
    const h = t.slice(2);
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  if (/^[0-9a-fA-F]+$/.test(t) && t.length % 2 === 0) {
    const out = new Uint8Array(t.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(i * 2, 2), 16);
    return out;
  }
  return b64ToBytes(t);
}

async function trustedKeys(env) {
  const raw = env[KEYRING_VAR];
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

/**
 * Verify a head's signature against the trusted keyring.
 * recorder.py's sign_head() is HMAC-SHA256 over b"\x03" + head. If the
 * anchor accepts THAT rule, the fleet's existing signed heads verify
 * without being re-signed -- which is the difference between an anchor
 * people adopt and an anchor people admire.
 */
export async function verifySignature(env, head, signature, sigAlg) {
  const keys = await trustedKeys(env);
  if (!signature) return { signed: false, alg: null, keyId: null, why: 'no signature supplied' };
  const alg = sigAlg || 'hmac-sha256';
  for (const [keyId, keyB64] of Object.entries(keys)) {
    try {
      const ok = alg === 'ed25519'
        ? await ed25519Verify(keyB64, head, signature)
        : await hmacVerify(b64ToBytes(keyB64), head, signature);
      if (ok) return { signed: true, alg, keyId, why: 'the signature verifies against a trusted key' };
    } catch (e) { /* try the next key */ }
  }
  return { signed: false, alg, keyId: null, why: 'the signature does not verify against any trusted key' };
}

// ONE LINE PER STATEMENT. miniflare's D1 exec() fails on a MULTI-LINE
// statement ("incomplete input"), which is a local-emulator quirk that
// would have shown up as a confusing error in a place nobody could
// reproduce. Statements are also split on ';' -- none of these contains a
// semicolon inside a string.
const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS heads (chain TEXT PRIMARY KEY, head TEXT NOT NULL, dialect TEXT, linkage TEXT, label TEXT, legs TEXT, why TEXT, refused TEXT, publisher_account TEXT, log_account TEXT, evidence TEXT, sig_alg TEXT, key_id TEXT, r2_key TEXT, published_at TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 1)",
  "CREATE TABLE IF NOT EXISTS attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL, head TEXT, at TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT)",
  "CREATE INDEX IF NOT EXISTS attempts_chain ON attempts(chain)",
];

// D1's exec() prepares ONE statement, so a multi-statement schema string
// is a parse error. One call per statement, and the schema is split on
// ';' -- which is fine because none of these statements contains a
// semicolon inside a string.
async function initDb(env) {
  for (const stmt of SCHEMA_STATEMENTS) await env.DB.exec(stmt);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/whoami') return json(await whoami(request, env));
      if (url.pathname === '/publish' && request.method === 'POST') {
        return json(await publish(request, env));
      }
      if (url.pathname === '/query' && request.method === 'POST') {
        return json(await query(request, env));
      }
      const m = url.pathname.match(/^\/(head|verify|chains)\/?(.*)$/);
      if (m) {
        if (m[1] === 'chains') return json(await listChains(env));
        return json(await readHead(m[1], m[2] ? decodeURIComponent(m[2]) : '', env));
      }
      return json({ error: 'not found', path: url.pathname }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};

function json(o, status = 200) {
  return new Response(JSON.stringify(o, null, 1), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function whoami(request, env) {
  const store = makeVectorStore(env);
  return {
    anchor: 'witness-anchor',
    account: env[ACCOUNT_VAR] || null,
    bindings: { kv: !!env.KV, r2: !!env.BUCKET, d1: !!env.DB, vectorize: !!env.VECTORS },
    vectorBackend: store.backend,
    embedder: EMBEDDER_ID,
    trustedKeyIds: Object.keys(await trustedKeys(env)),
  };
}

async function publish(request, env) {
  await initDb(env);
  const contentType = request.headers.get('content-type') || '';
  let body, chainText = null;

  if (contentType.includes('application/json')) {
    body = await request.json();
    if (typeof body.chainText === 'string') chainText = body.chainText;
  } else {
    chainText = await request.text();
    body = {};
  }
  if (!chainText && Array.isArray(body.records)) {
    chainText = body.records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  }
  if (!chainText) return { ok: false, why: 'no chain supplied' };

  const chainId = String(body.chainId || body.chain || 'unnamed');
  const records = parseChainJsonl(chainText);

  // ---- LEG 1: does it re-derive? ----
  const dialect = body.dialect || await detectDialect(records);
  const rederive = dialect ? await DIALECTS[dialect](records) : { ok: false, why: 'undetectable dialect' };
  const head = rederive.ok ? rederive.head : (body.head || null);
  const linkage = linkageOf(records, dialect);

  // ---- LEG 2: is the head signed? ----
  const sig = await verifySignature(env, head, body.signature, body.sigAlg);

  // ---- LEG 3: the accounts, and the EVIDENCE for the log's account ----
  const publisherAccount = body.publisherAccount || env[ACCOUNT_VAR] || null;
  const logAccount = body.logAccount || null;
  const evidence = body.logAccountEvidence || 'asserted';

  const cls = classify({
    rederives: !!rederive.ok,
    signed: sig.signed,
    publisherAccount,
    logAccount,
    linkage,
    claimedClass: body.claimedClass || null,
    logAccountEvidence: evidence,
  });

  // ---- store the log in R2, named by its head ----
  let r2key = null;
  if (env.BUCKET) {
    r2key = `chains/${chainId}/${head || 'unknown'}.jsonl`;
    await env.BUCKET.put(r2key, chainText, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { chain: chainId, head: head || '', dialect: dialect || '' },
    });
  }

  // ---- the head goes in KV, and the ANCHOR REFUSES TO OVERWRITE IT ----
  // R2 and KV are both writable by the account, so neither is out of band
  // by itself. What the anchor CAN do is make a REWRITE VISIBLE: the first
  // head for a chain is the anchor, and every later publication is an
  // epoch, and the divergence is recorded.
  let kvState = 'skipped';
  if (env.KV) {
    const k = `head:${chainId}`;
    const prior = await env.KV.get(k, 'json');
    if (!prior) {
      await env.KV.put(k, JSON.stringify({
        chain: chainId, head, dialect, linkage, label: cls.label, legs: cls.legs,
        publisherAccount, logAccount, evidence, publishedAt: new Date().toISOString(),
        r2key, epoch: 1,
      }));
      kvState = 'published';
    } else if (prior.head === head) {
      kvState = 'unchanged';
    } else {
      kvState = 'DIVERGED';
    }
  }

  const now = new Date().toISOString();
  const epochRow = await env.DB.prepare('SELECT MAX(epoch) AS e FROM heads WHERE chain = ?')
    .bind(chainId).first();
  const epoch = (epochRow && epochRow.e ? epochRow.e : 0) + 1;

  await env.DB.prepare(
    'INSERT OR REPLACE INTO heads (chain, head, dialect, linkage, label, legs, why, refused,' +
    ' publisher_account, log_account, evidence, sig_alg, key_id, r2_key, published_at, epoch)' +
    ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(chainId, head, dialect, linkage, cls.label, JSON.stringify(cls.legs), cls.why,
          cls.refused, publisherAccount, logAccount, evidence, sig.alg, sig.keyId, r2key, now, epoch)
    .run();

  await env.DB.prepare('INSERT INTO attempts (chain, head, at, outcome, detail) VALUES (?,?,?,?,?)')
    .bind(chainId, head, now, kvState, cls.refused || cls.why).run();

  // ---- index the claims, so the corpus can be SEARCHED ----
  const store = makeVectorStore(env);
  const claims = Array.isArray(body.claims) ? body.claims : [];
  if (claims.length) {
    const docs = claims.map((c, i) => {
      const text = typeof c === 'string' ? c : (c.text || '');
      return {
        id: `${chainId}#${i}`,
        text,
        values: embed(text),
        metadata: {
          chain: chainId, head: head || '', label: cls.label,
          dialect: dialect || '', source: (c && c.source) || '',
        },
      };
    });
    await store.insert(docs);
  }

  return {
    ok: rederive.ok,
    chain: chainId, head, dialect, linkage,
    rederives: {
      ok: !!rederive.ok,
      why: rederive.ok ? 'the chain re-derives from its own bodies' : rederive.why,
    },
    signature: sig,
    class: cls,
    kv: kvState,
    epoch,
    r2key,
    vectorBackend: store.backend,
    embedder: EMBEDDER_ID,
    publishedAt: now,
  };
}

async function readHead(kind, chainId, env) {
  await initDb(env);
  const row = await env.DB.prepare('SELECT * FROM heads WHERE chain = ? ORDER BY epoch DESC LIMIT 1')
    .bind(chainId).first();
  if (!row) return { error: 'no such chain', chain: chainId };
  const attempts = await env.DB.prepare(
    'SELECT at, head, outcome FROM attempts WHERE chain = ? ORDER BY id')
    .bind(chainId).all();

  if (kind === 'head') {
    return {
      chain: chainId, head: row.head, dialect: row.dialect, linkage: row.linkage,
      label: row.label, legs: JSON.parse(row.legs || '{}'), why: row.why, refused: row.refused,
      publisherAccount: row.publisher_account, logAccount: row.log_account,
      evidence: row.evidence, publishedAt: row.published_at, epoch: row.epoch,
      attempts: (attempts.results || []).map((a) => ({ at: a.at, head: a.head, outcome: a.outcome })),
    };
  }

  // kind === 'verify': re-derive the log we STORED and compare it with the
  // head we PUBLISHED. If the log in R2 was rewritten, this says so.
  if (!env.BUCKET || !row.r2_key) return { chain: chainId, error: 'no stored log to verify' };
  const obj = await env.BUCKET.get(row.r2_key);
  if (!obj) return { chain: chainId, error: 'the stored log is gone', r2key: row.r2_key };
  const text = await obj.text();
  const records = parseChainJsonl(text);
  const dialect = await detectDialect(records);
  const v = dialect ? await DIALECTS[dialect](records) : { ok: false, why: 'undetectable dialect' };
  return {
    chain: chainId,
    storedLogRederives: !!v.ok,
    storedHead: v.head,
    publishedHead: row.head,
    matches: !!v.ok && v.head === row.head,
    why: v.ok
      ? (v.head === row.head
        ? 'the stored log re-derives to the published head'
        : 'THE STORED LOG NO LONGER RE-DERIVES TO THE PUBLISHED HEAD')
      : v.why,
    class: row.label,
  };
}

async function listChains(env) {
  await initDb(env);
  const { results } = await env.DB.prepare(
    'SELECT chain, head, dialect, linkage, label, evidence, published_at, epoch' +
    ' FROM heads ORDER BY published_at DESC').all();
  return { count: (results || []).length, chains: results || [] };
}

async function query(request, env) {
  const body = await request.json().catch(() => ({}));
  const text = String(body.q || body.text || '');
  if (!text) return { error: 'no query' };
  const topK = body.topK || 10;
  const store = makeVectorStore(env);
  const t0 = Date.now();
  const res = await store.query(embed(text), { topK, returnMetadata: true });
  return {
    q: text,
    backend: store.backend,
    embedder: EMBEDDER_ID,
    // EXACT or APPROXIMATE. A reader must be able to tell which one they
    // are looking at, because an ANN result and an exact result are not
    // the same kind of object.
    search: store.backend === 'vectorize-ann' ? 'approximate (ANN)' : 'exact (brute-force cosine)',
    ms: Date.now() - t0,
    matches: (res.matches || []).map((m) => ({
      id: m.id, score: Number((m.score ?? 0).toFixed?.(6) ?? m.score), metadata: m.metadata,
    })),
  };
}
