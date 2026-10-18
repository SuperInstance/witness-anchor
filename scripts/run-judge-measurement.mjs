// THE JUDGE, ON THE SAME TASK, WITH THE SAME DENOMINATOR.
//
// The lexical index measures whether a RETRIEVAL index can find the files
// that make a tamper-evidence claim, when the query is a paraphrase. This
// script asks the fleet's semantic judge (Jev) the same question about
// the same 68 documents, against the same ground truth, and the two are
// then compared.
//
// TWO RULES, LEARNED THE HARD WAY IN THIS FLEET:
//   1. api.typesafe.ai presents a cert whose SAN list is marked CRITICAL,
//      which strict verifiers reject -- and Node's fetch cannot be told to
//      skip verification. So this uses `curl -k`, exactly as the fleet's
//      own jev client does. Documented rather than worked around, because
//      a skipped check is a real one.
//   2. A GATEWAY FAILURE MUST NEVER BE CONVERTED INTO A SCORE. A doc that
//      does not answer is EXCLUDED from the denominator and reported, not
//      scored as 0. Scoring a transport error as "no" would make the
//      judge's recall look better than it is by treating every failure as
//      a correct negative.
//
// USAGE: node scripts/run-judge-measurement.mjs

import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCorpus } from './measure-retrieval.mjs';

const exec = promisify(execFile);
const KEY = process.env.TYPESAFE_AI_TOKEN;
if (!KEY) { console.error('TYPESAFE_AI_TOKEN is not set'); process.exit(1); }

const MAX_STATE = 6000;   // chars of the document put in front of the judge

const QUESTIONS = {
  literal: 'This document uses the phrase "tamper-evident" to describe a log, a receipt, or a ledger.',
  intent: 'This document makes a claim that a record cannot be silently changed or rewritten without anyone being able to detect it.',
};

async function askJudge(text) {
  const body = {
    state: { document: text.slice(0, MAX_STATE) },
    model: 'jev-latest',
    questions: Object.fromEntries(Object.entries(QUESTIONS).map(([k, v]) =>
      [k, { type: 'noul', instructions: v }])),
  };
  // curl -k, per the fleet's own documented precedent for this gateway.
  const { stdout } = await exec('curl', [
    '-sk', '-m', '60', '-X', 'POST',
    'https://api.typesafe.ai/v1/systemone',
    '-H', 'authorization: Bearer ' + KEY,
    '-H', 'content-type: application/json',
    '--data-binary', JSON.stringify(body),
  ], { maxBuffer: 8 * 1024 * 1024 });
  const j = JSON.parse(stdout);
  const ans = j.answers || {};
  // The answer shape is {"type":"noul","noul":0.99} -- the probability is
  // in the `noul` field. (An earlier extractor looked for p_yes and
  // silently produced null for every doc, which made the judge look like
  // it had scored NOTHING rather than like it had scored nothing.)
  const p = (a) => {
    if (a == null) return null;
    if (typeof a === 'number') return a;
    if (typeof a === 'object') {
      for (const k of ['noul', 'p_yes', 'pYes', 'yes', 'probability', 'p', 'value']) {
        if (typeof a[k] === 'number') return a[k];
      }
    }
    return null;
  };
  return { literal: p(ans.literal), intent: p(ans.intent), raw: ans };
}

const corpus = loadCorpus();
const results = [];
let failed = 0;
for (let i = 0; i < corpus.docs.length; i++) {
  const d = corpus.docs[i];
  let r = null;
  for (let attempt = 0; attempt < 3 && !r; attempt++) {
    try { r = await askJudge(d.text); } catch (e) {
      if (attempt === 2) { failed++; console.log('  FAILED (excluded, not scored): ' + d.path); }
      else await new Promise((s) => setTimeout(s, 1500));
    }
  }
  if (r) {
    results.push({ id: d.id, path: d.path, positive: d.positive, literal: r.literal, intent: r.intent });
    process.stdout.write(`\r  judged ${i + 1}/${corpus.docs.length}   `);
  }
}
console.log('');
writeFileSync('scripts/judge-scores.json', JSON.stringify({ at: new Date().toISOString(), questions: QUESTIONS, results }, null, 1));

// --- score it, the same way the index was scored ---
function scoreJudge(key, k = 10) {
  const ranked = results.filter((r) => typeof r[key] === 'number')
    .sort((a, b) => b[key] - a[key]);
  const top = ranked.slice(0, k);
  const positives = results.filter((r) => r.positive).length;
  const hits = top.filter((r) => r.positive).length;
  return { hits, positives, recallAtK: +(hits / positives).toFixed(4), precisionAtK: +(hits / top.length).toFixed(4), topPaths: top.map((t) => t.path) };
}
console.log('');
console.log('  ' + 'question'.padEnd(60) + '  hit@10  recall@10  precision@10');
console.log('  ' + '-'.repeat(98));
for (const key of ['literal', 'intent']) {
  const s = scoreJudge(key);
  console.log('  ' + ('Jev: ' + QUESTIONS[key].slice(0, 46)).padEnd(60) +
    '  ' + String(s.hits).padStart(5) + '  ' + String(s.recallAtK).padStart(9) + '  ' + String(s.precisionAtK).padStart(13));
}
console.log('');
console.log('  ' + results.length + ' judged, ' + failed + ' failed and EXCLUDED (never scored as 0)');
console.log('  ' + 'scores written to scripts/judge-scores.json');
