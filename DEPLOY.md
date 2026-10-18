# Deploying this, and what will still be unproven afterwards

## The one thing this repository cannot do by itself

Put itself on Cloudflare. That needs `CLOUDFLARE_API_TOKEN`, and there is
no way around that: **an account is a human relationship.**

There is no credential in the fleet's secret store, and none in the
environment. So the deploy is written and ready, and it is one secret
away.

## Before the first deploy

1. **Create the resources.** The binding ids in `wrangler.toml` are
   `REPLACE_WITH_...` on purpose. They are not placeholders-by-neglect:
   they are placeholders because the resources do not exist yet, and
   pretending otherwise is what the fleet's other `wrangler.toml` files
   do — `database_id = ""` and `id = "superinstance-db-id"`, which
   describe a deployment that does not exist.

   ```bash
   npx wrangler kv namespace create KV
   npx wrangler r2 bucket create witness-anchor-logs
   npx wrangler d1 create witness-anchor
   # optional:
   npx wrangler vectorize create witness-anchor-claims
   ```

2. **Put the real ids in** `wrangler.toml`, and set `ACCOUNT_ID` to the
   anchor's own account.

3. **Put the trusted keys in.** `TRUSTED_KEYS` is a JSON map of
   `{keyId: base64key}`. A head signed by a key that is not in this map
   is `attestable`, not `attested`. The keyring is a **secret** — set it
   with `wrangler secret put TRUSTED_KEYS`, not in the file.

4. **Set `CLOUDFLARE_API_TOKEN` as a repository secret** and
   `CLOUDFLARE_ACCOUNT_ID` + `WORKER_URL` as repository variables, then
   run the `deploy` workflow.

## The deploy workflow VERIFIES

A deploy that is not verified is a claim. The workflow hits the live
Worker and asks it what it can actually do, and fails the job if the
bindings are not there. It also prints the vector backend, because
`vectorize-ann` and `d1-exact` are different kinds of search and the
reader of the log should know which one they are looking at.

## What is still unproven after a successful deploy

| | why |
|---|---|
| the `vectorize-ann` path | It only runs when the `VECTORS` binding is present. Locally it is **remote-only** — `Binding VECTORS needs to be run remotely` — so it has **never executed** in this repository. |
| the `workers-ai` embedder | Same. Remote-only, account-only. |
| the ANN index's recall | The exact backend is the oracle the ANN path should be checked against, and **that check needs an account**. The right first deploy task is: index a corpus, run the exact search, run the ANN search, and compare the two answers. |
| `tamper-evident` | **Nothing holds leg 3.** To earn it, the anchor must run on an account the log writer does not control, and it must OBSERVE the log's account — not be told it. |

## The one build of work that would change the fleet's vocabulary

**Run the anchor on a second Cloudflare account, and have the log writer
publish to it.**

Then the anchor can OBSERVE that the log came from the first account
(rather than being told), and the class becomes `tamper-evident` for
real. Until then the strongest honest word is `attested`, and the Worker
will keep saying so.

**That is one build, not a redesign.** And it is the only thing in the
fleet that would make "tamper-evident" true.
