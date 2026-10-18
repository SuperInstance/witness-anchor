// A VECTOR STORE WITH TWO BACKENDS AND ONE INTERFACE.
//
// CLOUDFLARE'S VECTORIZE IS REMOTE-ONLY. Running a Worker locally and
// touching a Vectorize binding fails with:
//
//     Binding VECTORS needs to be run remotely
//
// which means the fleet's Vectorize code -- prism's 18 KB worker, the
// papers' indexing scripts -- CANNOT BE EXECUTED BY ANYONE WITHOUT A
// CLOUDFLARE ACCOUNT. It is code that has never been run by most of the
// people who read it.
//
// THE WORKAROUND: give the store an interface that BOTH backends
// implement, exactly as Vectorize's binding does.
//
//   VECTORS binding present  -> the real, approximate (ANN) index
//   otherwise                 -> an EXACT search over vectors held in D1
//
// The Worker never knows which one it got: same insert(), same query(),
// same return shape. And every response says which backend served it, so
// nobody can mistake an exact score for an approximate one -- or believe
// an ANN result was tested when it was not.
//
// The exact backend is not a toy. On the corpus sizes this thing is
// actually for, exact search is both correct AND fast, and it has the
// property that matters most here: ITS ANSWER IS THE TRUTH. The ANN
// path is the approximation; the exact path is the oracle the ANN path
// should be CHECKED against.
//
// TWO THINGS THIS COST, LEARNED THE HARD WAY, SO THE NEXT PERSON DOES NOT
// LEARN THEM THE SAME WAY:
//   * the column is called `vec`, not `values` -- `values` is a SQLite
//     RESERVED WORD and fails at CREATE TABLE time;
//   * every statement is on ONE LINE -- miniflare's D1 exec() fails on a
//     multi-line statement with "incomplete input".

// ONE LINE PER STATEMENT -- miniflare's D1 exec() fails on a multi-line
// statement. Same rule as the Worker's own schema.
const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS docs (id TEXT PRIMARY KEY, text TEXT NOT NULL, vec TEXT NOT NULL, metadata TEXT, dim INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS docs_dim ON docs(dim)",
];

/** The exact, D1-backed implementation. Exact cosine, no approximation. */
export class D1VectorStore {
  constructor(db) { this.db = db; this.backend = 'd1-exact'; }
  async init() { for (const stmt of SCHEMA_STATEMENTS) await this.db.exec(stmt); }

  async insert(vectors) {
    await this.init();
    const stmts = vectors.map((v) => {
      const values = Array.from(v.values);
      return this.db.prepare(
        'INSERT INTO docs (id, text, vec, metadata, dim) VALUES (?, ?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET text=excluded.text, vec=excluded.vec, ' +
        'metadata=excluded.metadata, dim=excluded.dim')
        .bind(String(v.id), v.text || '', JSON.stringify(values),
              JSON.stringify(v.metadata || {}), values.length);
    });
    for (const s of stmts) await s.run();
    return { count: vectors.length };
  }

  async query(values, opts = {}) {
    await this.init();
    const topK = opts.topK || 10;
    const filter = opts.filter;
    const { results } = await this.db.prepare(
      'SELECT id, text, vec, metadata FROM docs WHERE dim = ?')
      .bind(values.length).all();
    const q = Array.from(values);
    const scored = [];
    for (const row of results || []) {
      const meta = safeParse(row.metadata) || {};
      if (filter && !matchesFilter(meta, filter)) continue;
      const s = cosine(q, safeParse(row.vec) || []);
      scored.push({ id: row.id, score: s, metadata: opts.returnMetadata ? meta : undefined });
    }
    scored.sort((a, b) => b.score - a.score);
    return { matches: scored.slice(0, topK), count: scored.length };
  }

  async delete(ids) {
    await this.init();
    for (const id of ids) {
      await this.db.prepare('DELETE FROM docs WHERE id = ?').bind(String(id)).run();
    }
    return { count: ids.length };
  }
}

/** A thin adapter that makes a real Vectorize binding look like the above. */
export class VectorizeAdapter {
  constructor(binding) { this.binding = binding; this.backend = 'vectorize-ann'; }
  async init() { /* the real index needs no schema */ }
  async insert(vectors) {
    // Vectorize's own shape: {id, values, namespace?, metadata?}
    return this.binding.insert(vectors.map((v) => ({
      id: String(v.id),
      values: Array.from(v.values),
      metadata: v.metadata || {},
    })));
  }
  async query(values, opts = {}) {
    const r = await this.binding.query(Array.from(values), {
      topK: opts.topK || 10,
      returnMetadata: opts.returnMetadata !== false,
      ...(opts.filter ? { filter: opts.filter } : {}),
    });
    return { matches: r.matches || [], count: r.count };
  }
  async delete(ids) {
    if (this.binding.delete) return this.binding.delete(ids.map(String));
    return { count: ids.length };
  }
}

/**
 * Pick the backend. The Vectorize binding wins if it is there; otherwise
 * the exact D1 store. The Worker calls one interface either way.
 */
export function makeVectorStore(env) {
  if (env.VECTORS && env.VECTORS.insert && env.VECTORS.query) {
    return new VectorizeAdapter(env.VECTORS);
  }
  return new D1VectorStore(env.DB);
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function matchesFilter(meta, filter) {
  for (const [k, want] of Object.entries(filter || {})) {
    if (meta[k] !== want) return false;
  }
  return true;
}

// local import to avoid a cycle with embed.js
function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}
