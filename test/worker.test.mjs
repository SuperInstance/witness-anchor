// THE INTEGRATION TEST -- AND IT RUNS WITHOUT A CLOUDFLARE ACCOUNT.
//
// This is the point of the whole exercise. The fleet's Cloudflare code
// (prism's 18 KB Vectorize worker, the papers' indexing scripts) cannot
// be executed by anyone who does not have credentials, because
// Vectorize is remote-only: a local Worker that touches a VECTORS
// binding fails with "Binding VECTORS needs to be run remotely".
//
// So the vector store has a SECOND implementation over D1 with the SAME
// interface, and this test drives the whole Worker through miniflare --
// real KV, real R2, real D1, and the exact D1-backed vector store --
// with NO account, NO token, and NO network.
//
// Which means: anyone can run this. `npm test`. That's the difference
// between a conformance suite and a comment.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { createHmac } from 'node:crypto';

// recorder.py's sign_head(): HMAC-SHA256 over b"\x03" + head.
function signHead(head, key) {
  return createHmac('sha256', key).update(Buffer.concat([Buffer.from([0x03]), Buffer.from(head, 'utf8')])).digest('base64');
}

const KEY = Buffer.from('a-key-the-log-writer-does-not-hold').toString('base64');

async function makeAnchor(extra = {}) {
  const mf = new Miniflare({
    modules: true,
    // The worker and its imports are ES modules. Without this, miniflare
    // parses them as CommonJS and the first `import` is a parse error.
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
    scriptPath: new URL('../src/index.js', import.meta.url).pathname,
    compatibilityDate: '2025-07-18',
    d1Databases: { DB: 'anchor-test' },
    kvNamespaces: { KV: 'anchor-kv' },
    r2Buckets: { BUCKET: 'anchor-r2' },
    // NO vectorize binding. That is the point: the D1-backed exact store
    // takes over, and the Worker cannot tell the difference.
    bindings: {
      TRUSTED_KEYS: JSON.stringify({ 'log-writer-1': KEY }),
      ACCOUNT_ID: 'anchor-account-B',
      ...extra,
    },
  });
  return mf;
}

// ONE miniflare for the whole file. Booting workerd per test is slow, and
// a shared instance is closer to how the thing actually runs.
let MF;
before(async () => { MF = await makeAnchor(); });
after(async () => { if (MF) await MF.dispose(); });

const CHAIN = readFileSync(new URL('./fixtures/example_situation.jsonl', import.meta.url), 'utf8');
// A DIFFERENT log, with a different head -- which is what a rewrite is.
// (A different SIGNATURE does not change the head: the head is computed
// from the chain, so resigning the same log is 'unchanged', correctly.)
const OTHER_CHAIN = readFileSync(new URL('./fixtures/calculator.jsonl', import.meta.url), 'utf8');
const OTHER_HEAD = '0xaaeec5b31c7e1d45';
const HEAD = '0x75f7a107f3b2ca07854e340e238e842d3183d45f32af445b22323a8d47c4fa9c';

test('the anchor publishes a real chain and computes its class', async () => {
  const mf = MF;
  const res = await MF.dispatchFetch('http://localhost/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: 'sit-demo-0001',
      chainText: CHAIN,
      signature: signHead(HEAD, Buffer.from('a-key-the-log-writer-does-not-hold')),
      sigAlg: 'hmac-sha256',
      logAccount: 'log-account-A',
      logAccountEvidence: 'asserted',
      claims: [{ text: 'the witness log is tamper-evident and replayable', source: 'README.md:136' }],
    }),
  });
  const out = await res.json();
  assert.equal(res.status, 200);
  assert.equal(out.ok, true, 'the real chain must re-derive');
  assert.equal(out.dialect, 'witness-chain/1');
  assert.equal(out.head, HEAD);
  assert.equal(out.signature.signed, true);
  // ASSERTED account -> attested, and the refusal is present
  assert.equal(out.class.label, 'attested');
  assert.match(out.class.refused, /ASSERTED/);
  assert.equal(out.kv, 'published');
  assert.equal(out.vectorBackend, 'd1-exact');
});

test('the same chain, published by the SAME account, is refused the strong word', async () => {
  // This test needs its OWN instance: it publishes from a DIFFERENT account,
  // which is the whole point of it.
  const mf = await makeAnchor({ ACCOUNT_ID: 'log-account-A' });
  try {
  const res = await mf.dispatchFetch('http://localhost/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: 'sit-demo-0001',
      chainText: CHAIN,
      signature: signHead(HEAD, Buffer.from('a-key-the-log-writer-does-not-hold')),
      logAccount: 'log-account-A',
      logAccountEvidence: 'observed',
    }),
  });
  const out = await res.json();
  assert.equal(out.class.label, 'attested', 'a self-anchored chain is not tamper-evident');
  assert.match(out.class.refused, /SAME account/);
  } finally { await mf.dispose(); }
});

test('an UNSIGNED chain is attestable, not attested', async () => {
  const mf = MF;
  const res = await MF.dispatchFetch('http://localhost/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chainId: 'unsigned', chainText: CHAIN, logAccount: 'log-account-A' }),
  });
  const out = await res.json();
  assert.equal(out.signature.signed, false);
  assert.equal(out.class.label, 'attestable');
});

test('a publisher who CLAIMS tamper-evident and cannot earn it is refused', async () => {
  const mf = MF;
  const res = await MF.dispatchFetch('http://localhost/publish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: 'overclaimer', chainText: CHAIN,
      signature: signHead(HEAD, Buffer.from('a-key-the-log-writer-does-not-hold')),
      logAccount: 'log-account-A', logAccountEvidence: 'asserted',
      claimedClass: 'tamper-evident',
    }),
  });
  const out = await res.json();
  assert.equal(out.class.label, 'attested');
  assert.match(out.class.refused, /claimed "tamper-evident" but the evidence supports "attested"/);
});

test('the anchor REFUSES TO OVERWRITE a published head, and records the divergence', async () => {
  // The anchor cannot prevent a rewrite -- the account can rewrite it. What
  // it can do is make the rewrite VISIBLE, which is the difference between
  // an anchor and a log.
  const mf = MF;
  const body = (chainText, sig) => JSON.stringify({
    chainId: 'ratcheted', chainText, signature: sig,
    logAccount: 'log-account-A', logAccountEvidence: 'asserted',
  });
  const r1 = await MF.dispatchFetch('http://localhost/publish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: body(CHAIN, signHead(HEAD, Buffer.from('a-key-the-log-writer-does-not-hold'))),
  });
  assert.equal((await r1.json()).kv, 'published');

  // a DIFFERENT LOG for the same chain id -> DIVERGED
  const r2 = await MF.dispatchFetch('http://localhost/publish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: body(OTHER_CHAIN, signHead(OTHER_HEAD, Buffer.from('a-key-the-log-writer-does-not-hold'))),
  });
  const out2 = await r2.json();
  assert.equal(out2.kv, 'DIVERGED');
  assert.equal(out2.epoch, 2, 'a second publication is an EPOCH, not a replacement');

  // and the head endpoint shows both
  const r3 = await MF.dispatchFetch('http://localhost/head/ratcheted');
  const head = await r3.json();
  assert.equal(head.epoch, 2);
  assert.equal(head.attempts.length, 2);
  assert.deepEqual(head.attempts.map((a) => a.outcome), ['published', 'DIVERGED']);
});

test('the vector index answers a query, and says which backend and which embedder', async () => {
  const mf = MF;
  await MF.dispatchFetch('http://localhost/publish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: 'indexed', chainText: CHAIN,
      signature: signHead(HEAD, Buffer.from('a-key-the-log-writer-does-not-hold')),
      logAccount: 'log-account-A', logAccountEvidence: 'asserted',
      claims: [
        { text: 'zzq-unique-claim-9f3a: the probe claim about unit vectors', source: 'zzq-probe.md' },
        { text: 'the budget vector sums field by field', source: 'calc_quilt.py' },
      ],
    }),
  });
  const res = await MF.dispatchFetch('http://localhost/query', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: 'zzq-unique-claim-9f3a unit vectors' }),
  });
  const out = await res.json();
  assert.equal(out.backend, 'd1-exact');
  assert.equal(out.search, 'exact (brute-force cosine)');
  assert.equal(out.embedder, 'lexical-hash-v1');
  assert.ok(out.matches.length > 0);
  assert.equal(out.matches[0].metadata.chain, 'indexed');
  assert.equal(out.matches[0].metadata.source, 'zzq-probe.md');
});

test('the stored log is re-verifiable against the published head', async () => {
  const mf = MF;
  await MF.dispatchFetch('http://localhost/publish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: 'reverify', chainText: CHAIN,
      signature: signHead(HEAD, Buffer.from('a-key-the-log-writer-does-not-hold')),
      logAccount: 'log-account-A', logAccountEvidence: 'asserted',
    }),
  });
  const res = await MF.dispatchFetch('http://localhost/verify/reverify');
  const out = await res.json();
  assert.equal(out.storedLogRederives, true);
  assert.equal(out.matches, true);
  assert.equal(out.storedHead, HEAD);
});

test('whoami reports the bindings, the backend, and the trusted key ids', async () => {
  const mf = MF;
  const res = await MF.dispatchFetch('http://localhost/whoami');
  const out = await res.json();
  assert.equal(out.account, 'anchor-account-B');
  assert.equal(out.bindings.kv, true);
  assert.equal(out.bindings.r2, true);
  assert.equal(out.bindings.d1, true);
  assert.equal(out.bindings.vectorize, false, 'no Vectorize binding in this test -- that is the whole point');
  assert.equal(out.vectorBackend, 'd1-exact');
  assert.deepEqual(out.trustedKeyIds, ['log-writer-1']);
});

// ---------------------------------------------------------------------------
// THE INTEROP CASE: the fleet's reference implementation signs in HEX, and
// the anchor must accept it. This is the exact form recorder.py produces:
//
//     "0x" + hmac.new(key, b"\x03" + head).hexdigest()
//
// An anchor that only accepted base64 would be an anchor the fleet's own
// reference implementation could not use -- and the whole point of the
// anchor is that the fleet's logs can be published to it.
// ---------------------------------------------------------------------------
test('a HEX signature from recorder.py verifies -- the fleet\'s own format', async () => {
  const { createHmac } = await import('node:crypto');
  const key = Buffer.from('a-key-the-log-writer-does-not-hold');
  const hexSig = '0x' + createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from([0x03]), Buffer.from(HEAD, 'utf8')]))
    .digest('hex');
  const res = await MF.dispatchFetch('http://localhost/publish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chainId: 'hexsig', chainText: CHAIN, signature: hexSig,
      logAccount: 'log-account-A', logAccountEvidence: 'asserted',
    }),
  });
  const out = await res.json();
  assert.equal(out.signature.signed, true, 'a recorder.py-shaped signature did not verify');
  assert.equal(out.class.label, 'attested');
});
