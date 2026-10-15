'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agence-test-'));
process.env.DATA_DIR = dir;
const server = require('../server/index.js');

let base;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

class Client {
  constructor() { this.cookie = ''; }
  async call(method, url, body, headers = {}) {
    const isRaw = Buffer.isBuffer(body);
    const res = await fetch(base + url, {
      method,
      headers: { 'X-Requested-With': 'agence', Cookie: this.cookie, ...(body && !isRaw ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? (isRaw ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
}

const alice = new Client();
const bob = new Client();
let projectId;

test('le premier inscrit devient admin, le suivant membre', async () => {
  const a = await alice.call('POST', '/api/auth/register', { name: 'Alice', email: 'alice@ynov.com', password: 'motdepasse1', week_group: 'B' });
  assert.equal(a.status, 200);
  assert.equal(a.data.user.role, 'admin');
  const b = await bob.call('POST', '/api/auth/register', { name: 'Bob', email: 'bob@ynov.com', password: 'motdepasse2', week_group: 'C' });
  assert.equal(b.data.user.role, 'member');
  assert.equal(b.data.user.week_group, 'C');
});

test('refuse les doublons, mots de passe courts et mauvais identifiants', async () => {
  const c = new Client();
  assert.equal((await c.call('POST', '/api/auth/register', { name: 'X', email: 'alice@ynov.com', password: 'motdepasse1', week_group: 'B' })).status, 409);
  assert.equal((await c.call('POST', '/api/auth/register', { name: 'X', email: 'x@y.fr', password: 'court', week_group: 'B' })).status, 400);
  assert.equal((await c.call('POST', '/api/auth/login', { email: 'alice@ynov.com', password: 'faux' })).status, 401);
  assert.equal((await c.call('POST', '/api/auth/login', { email: 'ALICE@ynov.com', password: 'motdepasse1' })).status, 200);
});

test('API protégée et CSRF', async () => {
  const anon = new Client();
  assert.equal((await anon.call('GET', '/api/projects')).status, 401);
  const noHeader = await fetch(base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: alice.cookie }, body: '{"title":"x"}' });
  assert.equal(noHeader.status, 403);
});

test('création de projet, tâches et passation entre semaines', async () => {
  const p = await alice.call('POST', '/api/projects', { title: 'Clip Neon', kind: 'clip', origin: 'externe', client: 'Studio Lune' });
  assert.equal(p.status, 200);
  projectId = p.data.id;

  const t = await alice.call('POST', `/api/projects/${projectId}/tasks`, { title: 'Repérage', due_date: '2026-11-03', week_group: 'C' });
  assert.equal(t.status, 200);
  assert.equal((await alice.call('POST', `/api/projects/${projectId}/tasks`, { title: 'x', due_date: 'pas-une-date' })).status, 400);

  await alice.call('POST', `/api/projects/${projectId}/notes`, { kind: 'passation', body: 'Lieu validé, il manque l’autorisation.' });

  // Bob (semaine C) voit la note de passation de la semaine B sur son tableau de bord.
  const dash = await bob.call('GET', '/api/dashboard');
  assert.equal(dash.data.handoff.length, 1);
  assert.equal(dash.data.handoff[0].author_name, 'Alice');
  assert.equal(dash.data.handoff[0].week_group, 'B');

  // Bob prend la tâche : l'auteur de la modification est tracé.
  const upd = await bob.call('PATCH', `/api/tasks/${t.data.id}`, { status: 'doing', assignee_id: 2 });
  assert.equal(upd.status, 200);
  const tasks = await bob.call('GET', `/api/projects/${projectId}/tasks`);
  assert.equal(tasks.data.tasks.find((x) => x.id === t.data.id).updated_by_name, 'Bob');
  const act = await bob.call('GET', `/api/projects/${projectId}/activity`);
  assert.ok(act.data.activity.some((a) => a.user_name === 'Bob' && a.action.includes('déplacé')));
});

test('permissions : un membre ne supprime pas la note d’un autre', async () => {
  const notes = await bob.call('GET', `/api/projects/${projectId}/notes`);
  assert.equal((await bob.call('DELETE', `/api/notes/${notes.data.notes[0].id}`)).status, 403);
  assert.equal((await alice.call('DELETE', `/api/notes/${notes.data.notes[0].id}`)).status, 200);
});

test('documents : fichier, lien, téléchargement protégé', async () => {
  const content = Buffer.from('%PDF-1.4 faux pdf');
  const up = await bob.call('POST', `/api/projects/${projectId}/upload`, content, {
    'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent('Scénario é.pdf'), 'X-Category': 'scenario',
  });
  assert.equal(up.status, 200);
  const list = await alice.call('GET', `/api/projects/${projectId}/documents`);
  assert.equal(list.data.documents[0].author_name, 'Bob');
  const dl = await alice.call('GET', `/api/documents/${up.data.id}/file`);
  assert.equal(dl.status, 200);
  assert.deepEqual(dl.data, content);
  assert.equal((await new Client().call('GET', `/api/documents/${up.data.id}/file`)).status, 401);

  const html = await bob.call('POST', `/api/projects/${projectId}/upload`, Buffer.from('<script>alert(1)</script>'), {
    'Content-Type': 'text/html', 'X-Filename': 'x.html',
  });
  const dl2 = await bob.call('GET', `/api/documents/${html.data.id}/file`);
  assert.match(dl2.headers.get('content-disposition'), /^attachment/);
  assert.equal(dl2.headers.get('content-type'), 'application/octet-stream');

  assert.equal((await alice.call('POST', `/api/projects/${projectId}/documents`, { title: 'Drive', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await alice.call('POST', `/api/projects/${projectId}/documents`, { title: 'Drive', url: 'https://drive.google.com/x' })).status, 200);
});

test('planning et réglage des semaines B/C (admin)', async () => {
  const e = await alice.call('POST', `/api/projects/${projectId}/events`, { title: 'Tournage jour 1', date: '2026-11-03', start_time: '09:00', end_time: '18:00' });
  assert.equal(e.status, 200);
  assert.equal((await alice.call('POST', `/api/projects/${projectId}/events`, { title: 'x', date: '2026-11-03', start_time: '18:00', end_time: '09:00' })).status, 400);
  const list = await bob.call('GET', '/api/events?from=2026-11-01&to=2026-11-30');
  assert.equal(list.data.events.length, 1);

  const before = (await bob.call('GET', '/api/config')).data.currentWeek;
  assert.equal((await bob.call('PUT', '/api/settings', { week_b_parity: 1 })).status, 403);
  const flip = await alice.call('PUT', '/api/settings', { week_b_parity: before === 'B' ? 1 : 0 });
  assert.equal(flip.status, 200);
  assert.notEqual(flip.data.currentWeek, before);
});

test('export admin et suppression de projet', async () => {
  assert.equal((await bob.call('GET', '/api/admin/export')).status, 403);
  const exp = await alice.call('GET', '/api/admin/export');
  assert.equal(exp.status, 200);
  assert.ok(!JSON.stringify(exp.data).includes('password_hash'));
  const del = await alice.call('DELETE', `/api/projects/${projectId}`);
  assert.equal(del.status, 200);
  assert.equal(fs.readdirSync(path.join(dir, 'uploads')).length, 0);
});

test('fichiers statiques : pas de traversée de dossier', async () => {
  const res = await fetch(base + '/..%2f..%2fpackage.json');
  assert.notEqual(res.status, 200);
  assert.equal((await fetch(base + '/')).status, 200);
});
