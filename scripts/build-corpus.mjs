// Build the corpus from GitHub: the files the vocabulary sweep CHANGED
// (positives) and files it did NOT (controls, drawn from the same repos).
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const REPO = 'SuperInstance';
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error('GITHUB_TOKEN is required'); process.exit(1); }

async function api(u) {
  const r = await fetch(u, { headers: { Authorization: 'token ' + TOKEN, 'User-Agent': 'witness-anchor', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(r.status + ' ' + u);
  return r.json();
}
async function blob(repo, path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${repo}/contents/${path}`, { headers: { Authorization: 'token ' + TOKEN, 'User-Agent': 'witness-anchor' } });
  if (!r.ok) return null;
  const d = await r.json();
  return Buffer.from(d.content, 'base64').toString('utf8');
}

// THE GROUND TRUTH: the files four merged PRs changed.
const PRs = [['witness-spec', 2], ['quilt-claw', 4], ['AI-Writings', 89], ['MicroMoth-quilt', 48]];
const positives = [];
for (const [repo, n] of PRs) {
  const files = await api(`https://api.github.com/repos/${REPO}/${repo}/pulls/${n}/files?per_page=100`);
  for (const f of files) positives.push({ repo, path: f.filename, additions: f.additions, deletions: f.deletions });
}
// CONTROLS: other markdown/js/py files from the same repos that the sweep
// did NOT touch. Drawn deterministically from the tree.
const controls = [];
for (const [repo] of PRs) {
  const tree = await api(`https://api.github.com/repos/${REPO}/${repo}/git/trees/HEAD?recursive=1`);
  const cands = (tree.tree || []).filter((t) => t.type === 'blob' &&
    /\.(md|js|mjs|py|ts)$/.test(t.path) && t.size > 200 && t.size < 200000);
  for (const c of cands) {
    const key = repo + '/' + c.path;
    if (positives.some((p) => p.repo === repo && p.path === c.path)) continue;
    if (controls.some((x) => x.key === key)) continue;
    controls.push({ repo, path: c.path, key });
    if (controls.filter((x) => x.repo === repo).length >= 12) break;
  }
}

const docs = [];
for (const p of positives) {
  const text = await blob(p.repo, p.path);
  if (!text) { console.log('  MISSING positive:', p.repo, p.path); continue; }
  docs.push({ id: 'P:' + p.repo + '/' + p.path, path: p.repo + '/' + p.path, positive: true, text });
}
for (const c of controls) {
  const text = await blob(c.repo, c.path);
  if (!text) { console.log('  MISSING control:', c.repo, c.path); continue; }
  docs.push({ id: 'C:' + c.key, path: c.key, positive: false, text });
}
const out = {
  at: new Date().toISOString().slice(0, 10),
  embedder: 'lexical-hash-v1',
  note: 'Positives are the files four MERGED PRs changed (the vocabulary sweep). ' +
        'Controls are untouched files from the same repos. The text is the file as merged.',
  positives: docs.filter((d) => d.positive).length,
  controls: docs.filter((d) => !d.positive).length,
  docs,
};
const raw = JSON.stringify(out);
writeFileSync('scripts/corpus.json', raw);
writeFileSync('scripts/corpus.sha256', createHash('sha256').update(raw).digest('hex') + '  corpus.json\n');
console.log(`  corpus: ${out.positives} positives + ${out.controls} controls = ${docs.length} docs`);
