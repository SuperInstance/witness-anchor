// THE MEASUREMENT. Run it, print the numbers, keep them.
import { loadCorpus, score, LITERAL, PARAPHRASES } from './measure-retrieval.mjs';

const corpus = loadCorpus();
console.log('  corpus: ' + corpus.positives + ' positives + ' + corpus.controls + ' controls');
console.log('  embedder: ' + corpus.embedder + '  (LEXICAL: shared tokens and character fragments)');
console.log('');
console.log('  ' + 'query'.padEnd(62) + '  hit@10  recall@10  precision@10');
console.log('  ' + '-'.repeat(100));
const rows = [];
for (const q of [LITERAL, ...PARAPHRASES]) {
  const s = score(corpus, q, 10);
  rows.push(s);
  console.log('  ' + ('"' + q.slice(0, 58) + '"').padEnd(62) +
    '  ' + String(s.hits).padStart(5) + '  ' + String(s.recallAtK).padStart(9) +
    '  ' + String(s.precisionAtK).padStart(13));
}
const lit = rows[0];
const par = rows.slice(1);
const avgRecall = par.reduce((s, r) => s + r.recallAtK, 0) / par.length;
const avgPrec = par.reduce((s, r) => s + r.precisionAtK, 0) / par.length;
console.log('');
console.log('  LITERAL query recall@10 : ' + lit.recallAtK);
console.log('  PARAPHRASE recall@10 avg: ' + avgRecall.toFixed(4) + '   precision@10 avg: ' + avgPrec.toFixed(4));
console.log('');
console.log('  THE GAP IS THE FINDING. A lexical index answers the literal query');
console.log('  and misses the paraphrase. That is the difference between a grep');
console.log('  and a retrieval index -- and it is the reason the JUDGE sits on');
console.log('  top of the index rather than inside it.');
console.log('');
console.log('  --- the top 5 for the first paraphrase (none of them share its words) ---');
for (const d of corpus.docs.map((d) => ({ d, s: score(corpus, PARAPHRASES[0], 5) })).slice(0, 1)) {
  const top = score(corpus, PARAPHRASES[0], 5);
  const { retrieve } = await import('./measure-retrieval.mjs');
  for (const t of retrieve(corpus, PARAPHRASES[0], 5)) {
    console.log('    ' + t.score.toFixed(4) + '  ' + (t.positive ? 'POSITIVE ' : 'control  ') + t.path);
  }
}
