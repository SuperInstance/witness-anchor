// A MEASUREMENT, WITH A DENOMINATOR.
//
// The vector index is a CANDIDATE GENERATOR. This script measures what it
// actually retrieves, against a ground truth that did not come from the
// index: the files that a careful reader changed when they corrected the
// fleet's "tamper-evident" vocabulary.
//
// THE GROUND TRUTH IS THE 24 FILES CHANGED BY FOUR MERGED PRS. It is
// machine-readable because it comes from the PR diffs, not from a claim.
//
// THE TWO QUERIES ARE THE POINT:
//   LITERAL    "tamper-evident"      -- shares vocabulary with the docs
//   PARAPHRASE "the record cannot be changed without anyone being able to
//               tell"               -- shares NO vocabulary with the docs
//
// A retrieval index that only works on the literal query is a grep with
// extra steps. The gap between the two numbers is the honest measurement
// of how much the index actually buys, and it is the number that decides
// whether a JUDGE is needed on top of it.
//
// USAGE: node scripts/measure-retrieval.mjs [--judge]
//   --judge also asks the fleet's semantic judge (Jev) the same question,
//   so the two are compared on the SAME set with the SAME denominator.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { embed, cosine, EMBEDDER_ID } from '../src/embed.js';

const CORPUS = 'scripts/corpus.json';

export function loadCorpus() {
  if (!existsSync(CORPUS)) throw new Error('run scripts/build-corpus.mjs first');
  return JSON.parse(readFileSync(CORPUS, 'utf8'));
}

export const LITERAL = 'tamper-evident';
export const PARAPHRASES = [
  'the record cannot be changed without anyone being able to tell',
  'proof that the history was not edited after the fact',
  'you cannot tamper with the log and still have it verify',
  'a guarantee that nobody can quietly rewrite what was written',
];

export function retrieve(corpus, query, topK = 10) {
  const q = embed(query);
  return corpus.docs
    .map((d) => ({ id: d.id, score: cosine(q, embed(d.text)), positive: d.positive, path: d.path }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

export function score(corpus, query, topK = 10) {
  const top = retrieve(corpus, query, topK);
  const totalPos = corpus.docs.filter((d) => d.positive).length;
  const hits = top.filter((d) => d.positive).length;
  return {
    query,
    topK,
    hits,
    positives: totalPos,
    recallAtK: totalPos ? +(hits / totalPos).toFixed(4) : 0,
    precisionAtK: top.length ? +(hits / top.length).toFixed(4) : 0,
    topPaths: top.map((d) => d.path),
  };
}
