# The deploy checklist — every value, where it goes, and what it is NOT

**Read this before you create anything.** Two of the five values people
think are secrets are identifiers and belong in `wrangler.toml` in
plaintext. One of them is not a value at all — it is the security decision.

---

## 0. The short version

| # | value | kind | goes in |
|---|---|---|---|
| 1 | `CLOUDFLARE_API_TOKEN` | **secret** | your shell, or a GitHub repo secret |
| 2 | `CLOUDFLARE_ACCOUNT_ID` | identifier | your shell, or a GitHub repo **variable** |
| 3 | `TRUSTED_KEYS` | **secret** | the Worker — `wrangler secret put` |
| 4 | `ACCOUNT_ID` | identifier | `wrangler.toml` `[vars]` |
| 5 | KV id · R2 bucket · D1 id | identifiers | `wrangler.toml` |
| — | **which account the anchor runs on** | **the security decision** | you |

**#6 is not a value and it is the whole point.** See §5.

---

## 1. The API token

**Create it:** Cloudflare dashboard → your profile icon → **My Profile** →
**API Tokens** → **Create Token** → **Use template** → **Edit Cloudflare
Workers**.

That template grants, verified against Cloudflare's own permissions
reference:

| scope | permission |
|---|---|
| Account | Workers Scripts — **Write** |
| Account | Workers KV Storage — **Write** |
| Account | Workers R2 Storage — **Write** |
| Account | Account Settings — Read |
| Zone | Workers Routes — Write |
| User | User Details — Read · Memberships — Read |

**The template does NOT include D1 or Vectorize.** For a custom token, add:

| scope | permission | why |
|---|---|---|
| Account | **D1 — Edit** | you need `wrangler d1 create` and the D1 binding |
| Account | **Vectorize — Edit** | only if you use Vectorize (and see §4 — you probably should not, yet) |

**Scope the token to the one account** you are deploying to, not "all
accounts". Cloudflare's docs are explicit that the token "gives access to
deploy Workers on your account".

---

## 2. The resources — one-time, and their ids are NOT secrets

```bash
npx wrangler kv namespace create KV          # -> id
npx wrangler r2 bucket create witness-anchor-logs
npx wrangler d1 create witness-anchor         # -> database_id
npx wrangler vectorize create witness-anchor-claims \
  --dimensions 256 --metric cosine            # ONLY if you use Vectorize
```

Then put the **identifiers** into `wrangler.toml` as plaintext:

```toml
[vars]
ACCOUNT_ID = "<the anchor's own account id>"

[[kv_namespaces]]
binding = "KV"
id      = "<the kv namespace id>"        # an id, not a secret

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "witness-anchor-logs"      # a name, not a secret

[[d1_databases]]
binding = "DB"
database_name = "witness-anchor"
database_id   = "<the d1 database id>"    # an id, not a secret
```

**A namespace id and a database id are not secrets.** They are addresses.
Committing them is correct, and the fleet's other `wrangler.toml` files
(`prism`, `SuperInstance-papers`) have the opposite problem — they use
`database_id = ""` and `id = "superinstance-db-id"`, which are neither
secrets nor addresses, but placeholders for resources that do not exist.

---

## 3. `TRUSTED_KEYS` — the one Worker secret, and it is the log writers' keys

```bash
npx wrangler secret put TRUSTED_KEYS
```

It is a **JSON map of key id → base64 key**:

```json
{"log-writer-1":"<base64 of the key recorder.py signs with>"}
```

**The key must be the SAME BYTES the log writer signs with.** The fleet's
reference implementation is `AI-Writings` → `labs/situation-recorder/recorder.py`:

```python
def sign_head(head: str, key: bytes) -> str:
    return "0x" + hmac.new(key, b"\x03" + head.encode("utf-8")).hexdigest()
```

So to make a recorder.py signature verify, the keyring entry is the
base64 of that same key:

```bash
printf %s "a-key-the-log-writer-does-not-hold" | base64 -w0
```

**A signature that does not verify against a key in this map is `attestable`,
not `attested` — and the Worker says so.** It never silently passes.

**The signature FORMAT is detected, not asked for:** hex with a `0x` prefix
(recorder.py's form), bare hex, or base64 all verify. An anchor that only
accepted one form would be an anchor the fleet's own reference
implementation could not use.

---

## 4. What the free tier actually gives you — and what it does not

Verified against Cloudflare's current pricing and limits pages:

| | Workers Free |
|---|---|
| Workers requests | 100,000 / day |
| CPU per invocation | 10 ms (network waits do **not** count) |
| Subrequests | 50 / request · 1,000 to internal services |
| KV | 100,000 reads/day · **1,000 writes/day** · 1 GB stored |
| D1 | 5M rows read/day · 100k rows written/day · 5 GB |
| R2 | 10 GB-month · 1M Class A ops/month · 10M Class B · **free egress** |
| **Vectorize** | **NOT AVAILABLE — Workers Paid plan only** |

**Two consequences:**

1. **The free tier gets you everything except Vectorize — and that is the
   right deployment anyway.** The anchor's vector store has an EXACT
   D1-backed implementation with the same interface, and the ANN path is
   the one line in the repository that has never executed. **Deploy the
   free tier, get the exact store, and the ANN path stays honestly
   labelled as unproven until you have a reason to pay $5/month.**

2. **The binding constraint is KV: 1,000 writes/day.** Each publish writes
   one head key, so that is ~1,000 publishes/day. Plenty for a witness
   anchor — and if you ever exceed it, KV *fails the write* rather than
   silently dropping it, which is the correct direction.

---

## 5. THE DECISION, WHICH IS NOT A VALUE

**The account is the unit of control.**

| where the anchor runs | what the class can be |
|---|---|
| the **same** Cloudflare account as the log writer | `attested` at best — the log writer can re-publish the head, so it is **self-anchored** |
| a **second** account the log writer does not control | `tamper-evident` — *if* the anchor OBSERVES the log's account rather than being told it |

**`ACCOUNT_ID` in `[vars]` is the anchor's own account, and it is compared
against the log's account on every publish.** If they match, the Worker
refuses the strong word and says so:

> *the head was published by the SAME account that wrote the log, so it is
> self-anchored, not out of band: the log writer can re-publish it*

**A second Cloudflare account is a second set of credentials and a second
email address, and it is the ONLY thing that makes "tamper-evident" true
in this fleet.** It is not a secret; it is a relationship.

**And even with two accounts, the evidence must be OBSERVED.** A publisher
that says "my log is on account A" is asserting, and an assertion cannot
establish a security property:

> *the log's account is ASSERTED by the publisher, not OBSERVED by the
> anchor, so no security property can rest on it*

---

## 6. Two ways to deploy, and the one that keeps the token off GitHub

**A. From your own machine.** The token never leaves your laptop.

```bash
export CLOUDFLARE_API_TOKEN='...'
export CLOUDFLARE_ACCOUNT_ID='...'
npx wrangler deploy
```

**B. From CI.** The token lives in GitHub's secret store (never in the
repository, never in a workflow file).

| repo setting | kind | value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | **Secret** | the token |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | the account id |
| `WORKER_URL` | Variable | `https://witness-anchor.<your-subdomain>.workers.dev` |

The `deploy` workflow in `.github/workflows/deploy.yml` already reads
exactly those three, and **it verifies the deployment after it happens** —
it hits the live `/whoami` and fails the job if the bindings are not
there. A deploy that is not verified is a claim.

---

## 7. And the option that needs no account at all

**`npm test` runs the entire Worker — real KV, real R2, real D1, the
vector store, the classification, the ratchet — with no Cloudflare
account, no token, and no network.** 24 tests, and it caught four real
deployment bugs (a `node:crypto` import, a `Buffer`, a multi-line D1
statement, and a SQLite reserved word) that would otherwise have shipped
and failed in production with no warning.

**If you never deploy, you still have the anchor, the classification, the
measurement, and a test suite anyone can run.** What you would not have is
a public URL and leg 3 — and leg 3 needs a second account whether or not
you deploy.
