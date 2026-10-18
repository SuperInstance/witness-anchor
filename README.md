# witness-anchor

**The fleet's out-of-band witness anchor — and the first Cloudflare artifact
in this fleet whose tests anyone can actually run.**

```bash
npm test        # the whole thing, locally, NO Cloudflare account, NO network
```

That line is the headline. Every other Cloudflare artifact in this fleet is
verified by a workflow that either has no tests or cannot run them,
because the code it guards needs a live account. This one runs the whole
Worker — real KV, real R2, real D1, and the vector store — inside
`workerd`, on a stock runner, with no credentials at all.

**That is the difference between a conformance suite and a comment.**

---

## What it does

A Cloudflare Worker with four bindings, and one job: hold the fleet's
signed witness heads somewhere the log writer does not control, and
compute the linkage class of each one **from evidence**.

| binding | what it holds |
|---|---|
| **KV** | the published heads — and the refusal to overwrite them |
| **R2** | the witness logs themselves, named by their head |
| **D1** | the index: chains, heads, epochs, and every publication attempt |
| **Vectorize** *(optional)* | semantic retrieval over the published claims |

```
POST /publish      publish a chain; get its class back
GET  /head/:chain  the published head, its class, and every attempt
GET  /verify/:chain  re-derive the STORED log against the PUBLISHED head
GET  /chains       the index
POST /query        vector search over the published claims
GET  /whoami       what this deployment can actually do
```

---

## The classification, and why it refuses

The fleet spent a year calling its logs **"tamper-evident"** when they were
not. A careful sweep of six repos produced 47 corrections and the finding
that **no log in the fleet holds all three legs**:

| leg | what it means | who holds it |
|---|---|---|
| 1. **re-derives** | the chain recomputes from its own bodies | everybody |
| 2. **signed** | the head carries a signature from a key we trust | two ledgers, optionally |
| 3. **published out of band** | the head is published where the log writer does not control it | **nobody** |

**This Worker cannot grant leg 3. It can only refuse to claim it.**

```js
// same account            -> attested, and it says why
// different account,      -> attested, and it says why: the log's account
//   ASSERTED by the        is ASSERTED by the publisher, not OBSERVED by
//   publisher                the anchor, so no security property can rest
//                             on it
// different account,      -> tamper-evident
//   OBSERVED by the anchor
```

**THE ACCOUNT IS THE UNIT OF CONTROL.** A Worker on the fleet's own
Cloudflare account is *not* out of band — the log writer can push to the
account, and so can the anchor's own operator. That is why a
self-anchored chain is `attested` and not `tamper-evident`, no matter what
the publisher asks for.

And a publisher who claims more than the evidence supports gets a
**refusal**, stored with the chain:

> the publisher claimed "tamper-evident" but the evidence supports
> "attested" (missing outOfBand(observed))

**A row-checksum log is not a chain.** 529 flat rows whose checksums
match do not re-derive *from* anything, and there is nothing to
truncate-and-detect. Calling that "re-derives" would be a lie, so the
classification does not.

---

## The vector store, and the workaround

Cloudflare's Vectorize is **remote-only**. A local Worker that touches a
`VECTORS` binding fails with:

```
Binding VECTORS needs to be run remotely
```

So the fleet's Vectorize code — `prism`'s 18 KB worker, the papers'
indexing scripts — **cannot be executed by anyone without an account.**
It is code most of the people reading it have never run.

**The workaround: two backends, one interface.**

| backend | when | search |
|---|---|---|
| `vectorize-ann` | the `VECTORS` binding is present | approximate (ANN) |
| `d1-exact` | otherwise | **exact** (brute-force cosine over D1) |

The Worker cannot tell them apart — same `insert()`, same `query()`, same
shapes — and **every response says which one served it**, so an
approximate answer is never passed off as an exact one.

The exact backend is not a toy. On the corpus sizes this thing is for,
exact search is both correct and fast, and it has the property that
matters most here: **its answer is the truth.** The ANN path is the
approximation; the exact path is the oracle the ANN path should be
*checked against*.

### The embedding, and its honest label

There are two embedders, and the response always says which one ran:

- **`lexical-hash-v1`** — local, deterministic, no account. **Explicitly
  lexical**: it matches shared tokens and character fragments, so it
  catches spelling variants, but it does *not* understand paraphrase.
- **`workers-ai`** — Cloudflare's semantic model. Remote. Untested locally
  by construction.

**The scores are not comparable between them**, and the Worker says which
embedder produced every score, so a number is never mistaken for a
semantic similarity.

---

## The measurement, with a denominator

The index is a **candidate generator**; the judgement belongs to a rule or
a judge, not to the distance function. So the index was measured against
a ground truth that did not come from the index: **the 24 files that four
merged PRs changed** when the vocabulary was corrected, plus **44
untouched controls** from the same repos.

| method | query | hit@10 | recall@10 | precision@10 |
|---|---|---|---|---|
| lexical index | literal | 3 | 0.125 | 0.30 |
| lexical index | paraphrase (avg of 4) | 4 | 0.167 | 0.40 |
| **judge (Jev)** | **literal** | **10** | **0.417** | **1.00** |
| **judge (Jev)** | intent | 4 | 0.167 | 0.40 |

**And the union, which is the number that decides the architecture:**

| | index top-10 | judge top-10 | **union** | only-index | only-judge |
|---|---|---|---|---|---|
| literal | 3/24 | 10/24 | **12/24** | 2 | 9 |
| intent | 0/24 | 4/24 | 4/24 | 0 | 4 |

Three things fall out of that, and they are the design:

1. **On the literal question the judge is not merely better — it is
   PERFECT on precision (10/10, no false positives) while the index makes
   7 false positives in 10. An index cannot decide. It can only propose.**
2. **On the intent question the two are equal** — and the index is free,
   offline and deterministic. So the index is not a cheaper judge; it is a
   *different instrument* that happens to be equally good at the harder
   question. (This also confirms, with a denominator, the fleet's earlier
   finding that the judge degrades badly on intent questions.)
3. **The union is bigger than either**, because they find *different*
   positives. So: **index proposes, judge decides**, and where the judge
   is unsure the index still has something to say.

### A rule, observed

**A gateway failure is never converted into a score.** The judge run had
one document fail; it was **excluded from the denominator and reported**,
not scored as 0. Scoring a transport error as "no" would inflate the
judge's recall by turning every failure into a correct negative.

---

## What is proven, and what is not

`DEPLOY.md` says this at length. The short version:

| | |
|---|---|
| **PROVEN, by a test anyone can run** | the classification matrix; the two chain rules against the fleet's real chains; the RFC 8785 canonicaliser against the published Appendix B vectors; the whole Worker's HTTP surface against real KV/R2/D1; the ratchet; the vector store's exact backend; the retrieval measurement |
| **NOT PROVEN** | the `vectorize-ann` path (it needs an account); the `workers-ai` embedder (same); the deployed Worker's behaviour (nothing is deployed); `tamper-evident` (nothing holds leg 3) |

**The `vectorize-ann` path is the one line in this repository that has
never executed.** It is marked as such, in the code, in the README, and in
the response shape.

---

## The three bugs the local test caught

Running it for real, with no account, found three things that would have
shipped:

1. **`import { createHash } from 'node:crypto'`** — a Worker cannot import
   a Node builtin without the `nodejs_compat` flag, and workerd would not
   resolve it. Replaced with **WebCrypto**, which is Workers-native and
   works in all three places. (The canonicaliser now has *no* deployment
   constraint at all.)
2. **`Buffer.from(s, 'utf8')`** — `Buffer` is a Node global and does not
   exist in a Worker. Replaced with `TextEncoder`. This one would have
   been a runtime error on the first `calculator-quilt` chain, in
   production, with no warning.
3. **A multi-line D1 statement** — miniflare's `exec()` fails on one with
   *"incomplete input"*, and `values` is a SQLite **reserved word**. Both
   found by running the thing.

**A test that has never run is a comment. This is the first artifact in
the fleet where that is not true.**

---

## Layout

```
src/classify.js     the linkage class, from evidence. The point.
src/dialects.js     the two chain rules, pinned by the RFC 8785 vectors
src/vectorstore.js  the Vectorize-compatible store, and its exact twin
src/embed.js        the local deterministic embedding, and its honest label
src/index.js        the Worker
test/               the suite -- runs with no account
scripts/            the corpus builder and the measurements
```
