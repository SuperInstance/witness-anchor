// The classification is the whole point, so it is tested FIRST and in full.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.js';

const base = { rederives: true, signed: true, linkage: 'chain' };

test('all three legs, observed across accounts -> tamper-evident', () => {
  const r = classify({ ...base, publisherAccount: 'B', logAccount: 'A', logAccountEvidence: 'observed' });
  assert.equal(r.label, 'tamper-evident');
  assert.equal(r.refused, null);
  assert.deepEqual(r.legs, { rederives: true, signed: true, outOfBand: true });
});

test('the SAME account -> attested, and it says why', () => {
  const r = classify({ ...base, publisherAccount: 'A', logAccount: 'A', logAccountEvidence: 'observed' });
  assert.equal(r.label, 'attested');
  assert.match(r.refused, /SAME account/);
});

test('an ASSERTED log account cannot earn the strong word', () => {
  // THE RULE THAT MATTERS MOST. A publisher SAYING "my log lives on
  // another account" is an assertion, and an assertion is not evidence.
  const r = classify({ ...base, publisherAccount: 'B', logAccount: 'A', logAccountEvidence: 'asserted' });
  assert.equal(r.label, 'attested');
  assert.match(r.refused, /ASSERTED/);
  assert.equal(r.legs.outOfBand, false);
});

test('unsigned -> attestable, whatever else holds', () => {
  const r = classify({ rederives: true, signed: false, linkage: 'chain', publisherAccount: 'B', logAccount: 'A', logAccountEvidence: 'observed' });
  assert.equal(r.label, 'attestable');
  assert.match(r.why, /missing signed/);
});

test('a ROW-CHECKSUM log is not a chain, and does not re-derive', () => {
  // 529 flat rows with checksums: the checksums match, but there is no
  // chain, so there is nothing to re-derive FROM and nothing to
  // truncate-and-detect. Calling that "re-derives" would be a lie.
  const r = classify({ rederives: true, signed: true, publisherAccount: 'B', logAccount: 'A', logAccountEvidence: 'observed', linkage: 'row-checksum' });
  assert.equal(r.legs.rederives, false);
  assert.equal(r.label, 'attestable');
  assert.match(r.why, /missing rederives/);
});

test('an UNDECLARED linkage is not a chain, and saying so is the safe default', () => {
  // A caller that does not say what the linkage is gets `none`, and `none`
  // does not re-derive. Guessing "chain" would be the unsafe default.
  const r = classify({ rederives: true, signed: true, publisherAccount: 'B', logAccount: 'A', logAccountEvidence: 'observed' });
  assert.equal(r.legs.rederives, false);
  assert.equal(r.label, 'attestable');
});

test('a publisher who claims too much is REFUSED, and the refusal is kept', () => {
  const r = classify({ ...base, publisherAccount: 'B', logAccount: 'A', logAccountEvidence: 'observed', claimedClass: 'tamper-evident' });
  // this one IS earned, so no refusal
  assert.equal(r.refused, null);
  const r2 = classify({ ...base, signed: false, publisherAccount: 'B', logAccount: 'A', logAccountEvidence: 'observed', claimedClass: 'tamper-evident' });
  assert.match(r2.refused, /claimed "tamper-evident" but the evidence supports "attestable"/);
});

test('the class never depends on the request asking for a stronger one', () => {
  const claims = ['tamper-evident', 'attested', 'attestable', 'nonsense'];
  const set = new Set(claims.map((c) => classify({ ...base, signed: false, claimedClass: c, publisherAccount: 'A', logAccount: 'A' }).label));
  assert.equal(set.size, 1, 'the class must not vary with the claim');
  assert.equal([...set][0], 'attestable');
});
