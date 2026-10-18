// A DETERMINISTIC EMBEDDING THAT RUNS ANYWHERE.
//
// Cloudflare's real embedding model is Workers AI, which is REMOTE-ONLY:
// you cannot call it from a test, and you cannot call it from a machine
// that has no account. That is why the fleet's Vectorize code has never
// been run by anyone without credentials -- and it is why a vector index
// built on it cannot be tested.
//
// So there are two embedders, and the response always says which one ran:
//
//   'lexical-hash-v1'  -- this file. Local, deterministic, no account, and
//                         EXPLICITLY LEXICAL: it matches shared tokens and
//                         shared character fragments, so it catches spelling
//                         variants and compound-word variants, but it does
//                         NOT understand paraphrase.
//   'workers-ai'       -- Cloudflare's semantic model. Remote. Untested
//                         locally by construction.
//
// The scores are NOT comparable between them, and the Worker says which
// embedder produced every score, so a number is never mistaken for a
// semantic similarity.
//
// WHY LEXICAL FIRST: a retrieval index is a CANDIDATE GENERATOR. The
// judgement belongs to a rule or a judge, not to the distance function.

const DIM = 256;

function hash32(s) {
  // FNV-1a 32-bit, over UTF-8 bytes, so the same string hashes the same
  // way in every runtime.
  let h = 0x811c9dc5;
  const b = new TextEncoder().encode(s);
  for (let i = 0; i < b.length; i++) {
    h ^= b[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function tokens(text) {
  const t = String(text || '').toLowerCase();
  const out = [];
  // words
  const words = t.match(/[a-z0-9_]+/g) || [];
  for (const w of words) out.push('w:' + w);
  // word bigrams -- these are what let a phrase match a differently-worded
  // sentence that says the same thing with one word changed
  for (let i = 0; i + 1 < words.length; i++) out.push('b:' + words[i] + '_' + words[i + 1]);
  // character trigrams -- these catch spelling variants and word forms
  const flat = ' ' + t.replace(/[^a-z0-9_]+/g, ' ') + ' ';
  for (let i = 0; i + 3 <= flat.length; i++) out.push('c:' + flat.slice(i, i + 3));
  return out;
}

/**
 * Embed a text into a unit-length vector of DIM dimensions.
 * @param {string} text
 * @returns {number[]}
 */
export function embed(text) {
  const v = new Float64Array(DIM);
  const tk = tokens(text);
  for (const t of tk) {
    const h = hash32(t);
    const idx = h % DIM;
    // the sign bit is taken from a different hash, so unrelated tokens do
    // not all pile up positive -- this is the signed hashing trick, and it
    // is what keeps the cosine from being a count.
    const sign = (hash32('sign:' + t) & 1) ? 1 : -1;
    v[idx] += sign;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return Array.from(v);
  return Array.from(v, (x) => x / n);
}

export const EMBEDDER_ID = 'lexical-hash-v1';
export const EMBED_DIM = DIM;

/** Cosine similarity of two unit vectors. */
export function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
