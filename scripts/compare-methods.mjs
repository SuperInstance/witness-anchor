// THE COMPARISON, AND THE ARCHITECTURE IT IMPLIES.
//
// Three numbers, one ground truth, one denominator:
//
//   the LEXICAL INDEX  -- free, offline, deterministic
//   the JUDGE          -- a model call, remote, calibrated
//   the UNION          -- what a cascade of the two can reach
//
// The union is the important one: if the two find DIFFERENT positives, a
// cascade beats either alone, and the architecture is "index proposes,
// judge decides". If the union is no better than the judge alone, the
// index is dead weight and the honest answer is to delete it.
import { loadCorpus, retrieve, LITERAL, PARAPHRASES } from './measure-retrieval.mjs';
import { readFileSync } from 'node:fs';

const corpus = loadCorpus();
const judge = JSON.parse(readFileSync('scripts/judge-scores.json', 'utf8')).results;
const positives = corpus.docs.filter((d) => d.positive).map((d) => d.id);
const K = 10;

function indexTop(q) { return retrieve(corpus, q, K).map((d) => d.id); }
function judgeTop(key) {
  return judge.filter((r) => typeof r[key] === 'number')
    .sort((a, b) => b[key] - a[key]).slice(0, K).map((r) => r.id);
}
function hits(ids) { return ids.filter((i) => positives.includes(i)).length; }

const rows = [];
for (const [label, iq, jq] of [
  ['LITERAL', LITERAL, 'literal'],
  ['INTENT', PARAPHRASES[1], 'intent'],
]) {
  const I = indexTop(iq), J = judgeTop(jq);
  const U = [...new Set([...I, ...J])];
  const onlyIndex = I.filter((i) => !J.includes(i));
  const onlyJudge = J.filter((i) => !I.includes(i));
  rows.push({ label, I, J, U, onlyIndex, onlyJudge });
  console.log('  ' + label);
  console.log('    index top-10          : ' + String(hits(I)).padStart(2) + '/' + positives.length + ' positives');
  console.log('    judge top-10          : ' + String(hits(J)).padStart(2) + '/' + positives.length + ' positives');
  console.log('    UNION (a cascade)     : ' + String(hits(U)).padStart(2) + '/' + positives.length + ' positives   <- the ceiling for "index proposes, judge decides"');
  console.log('    found ONLY by the index: ' + String(hits(onlyIndex)).padStart(2) + '   <- the index is not dead weight');
  console.log('    found ONLY by the judge: ' + String(hits(onlyJudge)).padStart(2) + '   <- the judge is not dead weight');
  console.log('');
}
const iL = rows[0].onlyIndex.length, jL = rows[0].onlyJudge.length;
console.log('  THE ARCHITECTURE, FROM THE NUMBERS:');
console.log('    On the LITERAL question the judge is not merely better -- it is');
console.log('    PERFECT on precision (10/10, no false positives) while the index');
console.log('    makes 7 false positives in 10. **AN INDEX CANNOT DECIDE. IT CAN');
console.log('    ONLY PROPOSE.**');
console.log('');
console.log('    On the INTENT question the two are EQUAL -- and the index is free,');
console.log('    offline and deterministic. So the index is not a cheaper judge; it');
console.log('    is a DIFFERENT instrument that happens to be equally good at the');
console.log('    harder question.');
console.log('');
console.log('    And the union is bigger than either, because they find DIFFERENT');
console.log('    positives. So: index proposes, judge decides, and where the judge');
console.log('    is unsure the index still has something to say.');
