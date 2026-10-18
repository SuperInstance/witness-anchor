# The measurements, and how to reproduce them

```bash
node scripts/build-corpus.mjs          # from the MERGED PR diffs
node scripts/run-measurement.mjs       # the index
node scripts/run-judge-measurement.mjs # the judge (needs TYPESAFE_AI_TOKEN)
node scripts/compare-methods.mjs       # the union, and the architecture
```

**The ground truth is machine-readable because it comes from the PR
diffs**, not from a claim about the PRs: 24 files changed by four merged
PRs (`witness-spec#2`, `quilt-claw#4`, `AI-Writings#89`,
`MicroMoth-quilt#48`), plus 44 untouched controls drawn from the same
repos.

| method | query | hit@10 | recall@10 | precision@10 |
|---|---|---|---|---|
| lexical index | literal | 3 | 0.1250 | 0.30 |
| lexical index | paraphrase (mean of 4) | 4 | 0.1667 | 0.40 |
| judge (Jev) | literal | 10 | 0.4167 | **1.00** |
| judge (Jev) | intent | 4 | 0.1667 | 0.40 |

Union: literal 12/24, intent 4/24. Only-index 2, only-judge 9 (literal).

**A gateway failure is never converted into a score.** The judge run
excluded 1 document that failed and reported it; it was not scored 0.
