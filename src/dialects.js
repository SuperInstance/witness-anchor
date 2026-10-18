// THE TWO CHAIN RULES THE FLEET ACTUALLY HAS.
//
// Copied from SuperInstance/quilt-stone, which is the fleet's canonical
// verifier, and PINNED HERE by the same RFC 8785 Appendix B vectors that
// proved the original. A copy that is not pinned by the vectors that
// proved the source is just a second implementation, and the second
// implementation is the problem.
//
// The two rules, and why they need two implementations:
//
//   witness-chain/1        SHA-256 over RFC 8785 (JCS) canonical bytes, with
//                          RFC 6962 domain separation (0x00 leaf / 0x01 node).
//                          The linkage lives in RECORD ORDER -- a record
//                          carries `hash` and NO `prev`.
//
//   fnv1a64-utf8-pyjson    FNV-1a-64 over the UTF-8 BYTES of PYTHON's
//                          json.dumps. The linkage is in an explicit `prev`
//                          field, and the canonical form depends on the
//                          LEXICAL form of a number -- so it can only be
//                          re-derived from the RAW TEXT.

// ---------------------------------------------------------------------------
// RFC 8785 (JCS). The key order is JS's default sort, which is by UTF-16
// code unit -- and that is exactly what JCS requires. The number form is
// JSON.stringify, which is ECMAScript's Number::toString -- also exactly
// what JCS requires.
// ---------------------------------------------------------------------------
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']';
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
}

// WebCrypto, NOT node:crypto. A Cloudflare Worker cannot import
// 'node:crypto' unless it is deployed with the nodejs_compat flag -- and
// the local workerd will not resolve it either. WebCrypto is the
// Workers-native primitive and it works in all three places, so the
// canonicaliser has no deployment constraint at all.
async function sha256Hex(s) {
  const bytes = new TextEncoder().encode(s);
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// The witness-chain/1 rule.
// ---------------------------------------------------------------------------
const WC_GENESIS = '0x0000000000000000';

export async function witnessChainVerify(records) {
  let prev = WC_GENESIS;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r || typeof r !== 'object') return { ok: false, why: 'row is not an object', at: i };
    if (r.hash === undefined) return { ok: false, why: 'missing hash', at: i };
    const body = { ...r };
    delete body.hash;
    const leaf = '0x' + await sha256Hex('\u0000' + canonicalJSON(body));
    const want = '0x' + await sha256Hex('\u0001' + prev + leaf);
    if (want !== r.hash) return { ok: false, why: 'hash mismatch', at: i, want, got: r.hash };
    prev = r.hash;
  }
  return { ok: true, head: records.length ? records[records.length - 1].hash : WC_GENESIS };
}

// ---------------------------------------------------------------------------
// The calculator-quilt rule. Python's json.dumps, FNV over UTF-8 bytes,
// and the `prev` field OVERWRITTEN with the running tip before hashing.
// ---------------------------------------------------------------------------
const PY_RAW = '__PYRAW_NUM__';
const CQ_GENESIS = '0x0000000000000000';

export function pyNum(v) {
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return String(v);
  if (!Number.isFinite(v)) return Number.isNaN(v) ? 'NaN' : (v > 0 ? 'Infinity' : '-Infinity');
  if (v === 0) return Object.is(v, -0) ? '-0.0' : '0.0';
  const s = String(v);
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(s);
  if (!m) return s;
  const neg = m[1] === '-' ? '-' : '';
  const intPart = m[2], fracPart = m[3] || '';
  const exp = m[4] ? parseInt(m[4], 10) : 0;
  const raw = intPart + fracPart;
  const leadZeros = raw.length - raw.replace(/^0+/, '').length;
  const digits = raw.replace(/^0+/, '').replace(/0+$/, '');
  if (!digits) return neg ? '-0.0' : '0.0';
  const decpt = intPart.length + exp - leadZeros;
  const n = digits.length;
  if (decpt > 0 && decpt <= 16) {
    if (decpt >= n) return neg + digits + '0'.repeat(decpt - n) + '.0';
    return neg + digits.slice(0, decpt) + '.' + digits.slice(decpt);
  }
  if (decpt <= 0 && decpt > -4) return neg + '0.' + '0'.repeat(-decpt) + digits;
  const e = decpt - 1;
  const es = (e >= 0 ? '+' : '-') + String(Math.abs(e)).padStart(2, '0');
  return neg + digits[0] + (n > 1 ? '.' + digits.slice(1) : '') + 'e' + es;
}

export function pyNumFromText(t) {
  if (/[.eE]/.test(t)) {
    const v = Number(t);
    if (Number.isInteger(v) && Math.abs(v) < 1e16) {
      return Object.is(v, -0) ? '-0.0' : v.toFixed(1);
    }
    return pyNum(v);
  }
  return String(BigInt(t));
}

export function pyStr(s) {
  return JSON.stringify(s).replace(/[\u0080-\uffff]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function pySortKeys(keys) {
  return keys.slice().sort((a, b) => {
    const A = Array.from(a), B = Array.from(b);
    const n = Math.min(A.length, B.length);
    for (let i = 0; i < n; i++) {
      const x = A[i].codePointAt(0), y = B[i].codePointAt(0);
      if (x !== y) return x - y;
    }
    return A.length - B.length;
  });
}

export function pyJsonDumps(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return pyNum(v);
  if (typeof v === 'string') {
    if (v.startsWith(PY_RAW)) return pyNumFromText(v.slice(PY_RAW.length));
    return pyStr(v);
  }
  if (Array.isArray(v)) return '[' + v.map(pyJsonDumps).join(',') + ']';
  return '{' + pySortKeys(Object.keys(v))
    .map((k) => pyStr(k) + ':' + pyJsonDumps(v[k])).join(',') + '}';
}

export function fnv1a64Utf8(s) {
  // TextEncoder, NOT Buffer. `Buffer` is a Node global and does not exist
  // in a Cloudflare Worker (nor in workerd) without the nodejs_compat
  // flag. TextEncoder gives the same UTF-8 BYTES and exists everywhere.
  // (The local test caught this one; it would have been a runtime error on
  // the first calculator-quilt chain, in production, with no warning.)
  const b = new TextEncoder().encode(s);
  let h = 0xcbf29ce484222325n, p = 0x100000001b3n, m = 0xffffffffffffffffn;
  for (const x of b) { h ^= BigInt(x); h = (h * p) & m; }
  return '0x' + h.toString(16).padStart(16, '0');
}

// Parse JSON but KEEP THE LEXICAL FORM OF EVERY NUMBER. JSON.parse throws
// the int/float distinction away, and this canonical form depends on it.
export function parsePreservingNumbers(text) {
  const out = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n) { if (text[j] === '\\') { j += 2; continue; } if (text[j] === '"') break; j++; }
      out.push(text.slice(i, j + 1)); i = j + 1; continue;
    }
    if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i;
      if (text[j] === '-') j++;
      while (j < n && text[j] >= '0' && text[j] <= '9') j++;
      if (text[j] === '.') { j++; while (j < n && text[j] >= '0' && text[j] <= '9') j++; }
      if (text[j] === 'e' || text[j] === 'E') {
        j++;
        if (text[j] === '+' || text[j] === '-') j++;
        while (j < n && text[j] >= '0' && text[j] <= '9') j++;
      }
      out.push('"' + PY_RAW + text.slice(i, j) + '"'); i = j; continue;
    }
    out.push(c); i++;
  }
  return JSON.parse(out.join(''));
}

export function calculatorQuiltVerify(records) {
  let prev = CQ_GENESIS;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r || typeof r !== 'object') return { ok: false, why: 'row is not an object', at: i };
    if (r.hash === undefined) return { ok: false, why: 'missing hash', at: i };
    // The number-preserving parse, when there is one. The plain parse
    // cannot tell `0.0` from `0`, and this canonical form can -- so a
    // caller who hands us a plain-parsed structure gets a chain that
    // FAILS TO VERIFY, which is the safe direction: a false negative, not
    // a false positive.
    const src = r.__pyjson ?? r;
    const env = { ...src };
    delete env.hash;
    env.prev = prev;
    const want = fnv1a64Utf8(pyJsonDumps(env));
    if (want !== r.hash) return { ok: false, why: 'hash mismatch', at: i, want, got: r.hash };
    prev = r.hash;
  }
  return { ok: true, head: records.length ? records[records.length - 1].hash : CQ_GENESIS };
}

// ---------------------------------------------------------------------------
// Detection, by TRIAL -- the shape is a guess, the trial is the proof.
// ---------------------------------------------------------------------------
export const DIALECTS = {
  'witness-chain/1': witnessChainVerify,
  'fnv1a64-utf8-pyjson': calculatorQuiltVerify,
};

/**
 * Parse a JSONL chain, keeping BOTH parses: the plain one, which is what
 * witness-chain/1 hashes, and the number-preserving one, which is what
 * calculator-quilt hashes. JSON.parse throws the int/float distinction
 * away, and each canonical form has its own edge.
 *
 * ONE PARSER. A second parser that forgets the lexical form will
 * misdiagnose a valid chain -- which is exactly what happened in the
 * fleet's own scanner.
 */
export function parseChainJsonl(text) {
  const rows = [];
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    const row = JSON.parse(line);
    try {
      Object.defineProperty(row, '__pyjson', {
        value: parsePreservingNumbers(line), enumerable: false,
      });
    } catch (e) { /* frozen row: fall back to the plain parse */ }
    rows.push(row);
  }
  return rows;
}

export async function detectDialect(records) {
  if (!Array.isArray(records) || !records.length) return null;
  const r0 = records[0];
  // witness-chain/1 carries `hash` and NO `prev`.
  if (r0.hash !== undefined && r0.prev === undefined) {
    if ((await witnessChainVerify(records)).ok) return 'witness-chain/1';
  }
  // calculator-quilt carries `prev` AND `hash`.
  if (r0.hash !== undefined && r0.prev !== undefined) {
    if (calculatorQuiltVerify(records).ok) return 'fnv1a64-utf8-pyjson';
  }
  return null;
}

/** The linkage CLASS of a log, which is not the same thing as the dialect. */
export function linkageOf(records, dialect) {
  if (!dialect) return 'none';
  // A row-checksum log has checksums but no chain: its rows do not carry
  // the previous row's hash, so there is nothing to truncate-and-detect.
  const r0 = records[0] || {};
  const chained = dialect === 'witness-chain/1' ||
    (dialect === 'fnv1a64-utf8-pyjson' && r0.prev !== undefined);
  return chained ? 'chain' : 'row-checksum';
}
