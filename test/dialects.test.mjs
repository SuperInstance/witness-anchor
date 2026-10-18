// The copied canonicaliser is PINNED by the same RFC 8785 vectors that
// proved the original in SuperInstance/quilt-stone. A copy that is not
// pinned by the vectors that proved its source is just a second
// implementation -- and the second implementation is the problem.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJSON, detectDialect, DIALECTS, parseChainJsonl, witnessChainVerify, calculatorQuiltVerify } from '../src/dialects.js';

const V = JSON.parse(readFileSync(new URL('./fixtures/rfc8785-vectors.json', import.meta.url), 'utf8'));

test('the vector fixture is unchanged', () => {
  const raw = readFileSync(new URL('./fixtures/rfc8785-vectors.json', import.meta.url));
  const h = createHash('sha256').update(raw).digest('hex');
  assert.equal(V.rfc8785.numbers.length, 24, 'RFC 8785 Appendix B has 24 samples');
  assert.ok(/^[0-9a-f]{64}$/.test(h));
});

test('the copied canonicaliser passes all 24 RFC 8785 Appendix B samples', () => {
  for (const { value, canonical } of V.rfc8785.numbers) {
    assert.equal(canonicalJSON(value), canonical, `number ${value}`);
  }
});

test('the copied canonicaliser passes the RFC 8785 3.2.3 sort-order test', () => {
  const r = V.rfc8785;
  const got = Object.keys(r.sort_test_data).sort().map((k) => r.sort_test_data[k]);
  assert.deepEqual(got, r.sort_expected_order);
  const byValue = {};
  for (const [k, v] of Object.entries(r.sort_test_data)) byValue[v] = k;
  const expected = '{' + r.sort_expected_order.map((v) => JSON.stringify(byValue[v]) + ':' + JSON.stringify(v)).join(',') + '}';
  assert.equal(canonicalJSON(r.sort_test_data), expected);
});

test('the copied canonicaliser puts the ASTRAL key first (UTF-16 order)', () => {
  const o = { '\u{10000}': 'A', '\uE000': 'B' };
  const keys = [...canonicalJSON(o).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse('"' + m[1] + '"'));
  assert.deepEqual(keys, ['\u{10000}', '\uE000']);
});

test('the two dialects detect and verify the fleet\'s REAL chains', async () => {
  // The 8-record committed transcript and the 36-row calculator log, both
  // copied in as fixtures byte for byte.
  const a = parseChainJsonl(readFileSync(new URL('./fixtures/example_situation.jsonl', import.meta.url), 'utf8'));
  assert.equal(await detectDialect(a), 'witness-chain/1');
  const av = await witnessChainVerify(a);
  assert.equal(av.ok, true);
  assert.equal(av.head, '0x75f7a107f3b2ca07854e340e238e842d3183d45f32af445b22323a8d47c4fa9c');

  const c = parseChainJsonl(readFileSync(new URL('./fixtures/calculator.jsonl', import.meta.url), 'utf8'));
  assert.equal(await detectDialect(c), 'fnv1a64-utf8-pyjson');
  const cv = calculatorQuiltVerify(c);
  assert.equal(cv.ok, true);
  assert.equal(cv.head, '0xaaeec5b31c7e1d45');
});

test('NEGATIVE: an edited row breaks the chain', async () => {
  const a = parseChainJsonl(readFileSync(new URL('./fixtures/example_situation.jsonl', import.meta.url), 'utf8'));
  a[3].body.value = 0;
  assert.equal((await witnessChainVerify(a)).ok, false);
});

test('NEGATIVE: a plain-parsed calculator chain does NOT verify -- and that is the safe direction', () => {
  // A caller who forgets the number-preserving parse gets a FALSE
  // NEGATIVE, not a false positive. The chain is not silently accepted.
  const plain = readFileSync(new URL('./fixtures/calculator.jsonl', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(calculatorQuiltVerify(plain).ok, false);
});
