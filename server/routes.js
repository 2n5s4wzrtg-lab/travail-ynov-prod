'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { db, transaction, log, getSetting, setSetting, UPLOAD_DIR } = require('./db');
const auth = require('./auth');

const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 200) * 1024 * 1024;
const INVITE_CODE = process.env.INVITE_CODE || '';

const PROJECT_STATUSES = ['idee', 'preprod', 'tournage', 'postprod', 'livre', 'archive'];
const PROJECT_KINDS = ['clip', 'court-metrage', 'publicite', 'corporate', 'documentaire', 'interview', 'evenement', 'autre'];
const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'];
const PRIORITIES = ['low', 'normal', 'high'];
const NOTE_KINDS = ['info', 'passation', 'decision', 'question'];
const DOC_CATEGORIES = ['scenario', 'planning', 'budget', 'autorisation', 'contrat', 'rushs', 'montage', 'livrable', 'reference', 'autre'];
const EVENT_KINDS = ['tournage', 'reperage', 'reunion', 'montage', 'livraison', 'autre'];
const COLORS = ['#ff2d7a', '#ff7a1a', '#ffd21a', '#2bd97c', '#1bb5ff', '#a678ff'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

// ---------- validation ----------
function str(v, { max = 200, required = false, name = 'champ' } = {}) {
  if (v == null || v === '') {
    if (required) throw bad(`Le ${name} est obligatoire.`);
    return '';
  }
  if (typeof v !== 'string') throw bad(`Le ${name} est invalide.`);
  const s = v.trim();
  if (required && !s) throw bad(`Le ${name} est obligatoire.`);
  if (s.length > max) throw bad(`Le ${name} est trop long (${max} caractères maximum).`);
  return s;
}
function oneOf(v, list, name, fallback) {
  if (v == null || v === '') { if (fallback !== undefined) return fallback; throw bad(`Le ${name} est obligatoire.`); }
  if (!list.includes(v)) throw bad(`Le ${name} est invalide.`);
  return v;
}
function dateOrNull(v, name = 'date') {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad(`La ${name} est invalide.`);
  return v;
}
function timeOrNull(v, name = 'heure') {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad(`L'${name} est invalide.`);
  return v;
}
function idOrNull(v, table) {
  if (v == null || v === '') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) throw bad('Référence inconnue.');
  return id;
}
function email(v) {
  const s = str(v, { max: 200, required: true, name: 'e-mail' }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad("L'adresse e-mail est invalide.");
  return s;
}
function password(v) {
  if (typeof v !== 'string' || v.length < 8) throw bad('Le mot de passe doit contenir au moins 8 caractères.');
  if (v.length > 200) throw bad('Le mot de passe est trop long.');
  return v;
}
function url(v) {
  const s = str(v, { max: 1000, required: true, name: 'lien' });
  let u;
  try { u = new URL(s); } catch { throw bad('Le lien est invalide.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw bad('Le lien doit commencer par http:// ou https://.');
  return u.href;
}

// ---------- helpers ----------
const must = (row, what = 'Élément') => { if (!row) throw new HttpError(404, `${what} introuvable.`); return row; };
const isAdmin = (u) => u.role === 'admin';
function requireAdmin(u) { if (!isAdmin(u)) throw new HttpError(403, 'Réservé aux administrateurs.'); }
function requireAuthor(u, authorId, ownerId) {
  if (isAdmin(u) || u.id === authorId || (ownerId != null && u.id === ownerId)) return;
  throw new HttpError(403, "Seul l'auteur, le responsable du projet ou un admin peut faire cela.");
}
function project(id) { return must(db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id)), 'Projet'); }
function touch(projectId) { db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(projectId); }

function isoWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - firstThu) / 864e5 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}
const today = () => new Date().toISOString().slice(0, 10);
function weekGroupOf(dateStr) {
  const parity = Number(getSetting('week_b_parity') || 0);
  return isoWeek(dateStr) % 2 === parity ? 'B' : 'C';
}

// Rate limiting en mémoire (anti force brute).
const attempts = new Map();
function rateLimit(key, max = 10, windowMs = 15 * 60 * 1000) {
  const now = Date.now();
  const e = attempts.get(key);
  if (!e || e.reset < now) { attempts.set(key, { count: 1, reset: now + windowMs }); return; }
  if (++e.count > max) throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
}
setInterval(() => { const n = Date.now(); for (const [k, v] of attempts) if (v.reset < n) attempts.delete(k); }, 600000).unref();

const USER_PUBLIC = 'id, name, email, role, week_group, job, color, created_at';

// ---------- routes ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, ...opts });
};

// --- config & auth ---
route('GET', '/api/config', () => ({
  inviteRequired: Boolean(INVITE_CODE),
  firstUser: db.prepare('SELECT COUNT(*) c FROM users').get().c === 0,
  weekBParity: Number(getSetting('week_b_parity')),
  today: today(),
  currentWeek: weekGroupOf(today()),
  maxUploadMb: Math.round(MAX_UPLOAD / 1048576),
  enums: { PROJECT_STATUSES, PROJECT_KINDS, TASK_STATUSES, PRIORITIES, NOTE_KINDS, DOC_CATEGORIES, EVENT_KINDS, COLORS },
}), { public: true });

route('POST', '/api/auth/register', ({ body, ip, res, secure }) => {
  rateLimit('reg:' + ip, 10);
  if (INVITE_CODE) {
    const given = Buffer.from(String(body.invite || ''));
    const want = Buffer.from(INVITE_CODE);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(403, "Code d'invitation incorrect.");
  }
  const name = str(body.name, { max: 80, required: true, name: 'nom' });
  const mail = email(body.email);
  const pwd = password(body.password);
  const week = oneOf(body.week_group, ['B', 'C'], 'groupe de semaine');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(mail)) throw new HttpError(409, 'Un compte existe déjà avec cet e-mail.');
  const first = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  const color = COLORS[crypto.randomInt(COLORS.length)];
  const info = db.prepare('INSERT INTO users (name, email, password_hash, role, week_group, job, color) VALUES (?,?,?,?,?,?,?)')
    .run(name, mail, auth.hashPassword(pwd), first ? 'admin' : 'member', week, str(body.job, { max: 80 }), color);
  const id = Number(info.lastInsertRowid);
  log(null, id, 'a rejoint L’agence', name);
  const s = auth.createSession(id);
  res.setHeader('Set-Cookie', auth.cookieHeader(s.token, s.expires, secure));
  return { user: db.prepare(`SELECT ${USER_PUBLIC} FROM users WHERE id = ?`).get(id) };
}, { public: true });

route('POST', '/api/auth/login', ({ body, ip, res, secure }) => {
  const mail = String(body.email || '').trim().toLowerCase();
  rateLimit(`login:${ip}:${mail}`, 8);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(mail);
  // On exécute toujours un scrypt pour ne pas révéler si le compte existe.
  const ok = auth.verifyPassword(String(body.password || ''), u ? u.password_hash : 'scrypt$00$00');
  if (!u || !ok) throw new HttpError(401, 'E-mail ou mot de passe incorrect.');
  attempts.delete(`login:${ip}:${mail}`);
  const s = auth.createSession(u.id);
  res.setHeader('Set-Cookie', auth.cookieHeader(s.token, s.expires, secure));
  return { user: db.prepare(`SELECT ${USER_PUBLIC} FROM users WHERE id = ?`).get(u.id) };
}, { public: true });

route('POST', '/api/auth/logout', ({ req, res }) => {
  auth.destroySession(auth.sessionToken(req));
  res.setHeader('Set-Cookie', auth.clearCookie);
  return { ok: true };
}, { public: true });

route('GET', '/api/me', ({ user }) => ({ user: user || null }), { public: true });

route('PATCH', '/api/me', ({ user, body }) => {
  const name = body.name !== undefined ? str(body.name, { max: 80, required: true, name: 'nom' }) : user.name;
  const week = body.week_group !== undefined ? oneOf(body.week_group, ['B', 'C'], 'groupe de semaine') : user.week_group;
  const job = body.job !== undefined ? str(body.job, { max: 80 }) : user.job;
  const color = body.color !== undefined ? oneOf(body.color, COLORS, 'couleur') : user.color;
  db.prepare('UPDATE users SET name=?, week_group=?, job=?, color=? WHERE id=?').run(name, week, job, color, user.id);
  return { user: db.prepare(`SELECT ${USER_PUBLIC} FROM users WHERE id = ?`).get(user.id) };
});

route('POST', '/api/me/password', ({ user, body, req }) => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
  if (!auth.verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(403, 'Mot de passe actuel incorrect.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password(body.password)), user.id);
  // Déconnecte les autres appareils.
  const keep = auth.sessionToken(req);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, crypto.createHash('sha256').update(keep || '').digest('hex'));
  return { ok: true };
});

// --- users ---
route('GET', '/api/users', () => ({ users: db.prepare(`SELECT ${USER_PUBLIC} FROM users ORDER BY name COLLATE NOCASE`).all() }));

route('PATCH', '/api/users/:id', ({ user, params, body }) => {
  requireAdmin(user);
  const target = must(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id)), 'Membre');
  const role = body.role !== undefined ? oneOf(body.role, ['admin', 'member'], 'rôle') : target.role;
  const week = body.week_group !== undefined ? oneOf(body.week_group, ['B', 'C'], 'groupe') : target.week_group;
  if (target.role === 'admin' && role !== 'admin' && db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c <= 1)
    throw bad('Il doit rester au moins un administrateur.');
  db.prepare('UPDATE users SET role=?, week_group=? WHERE id=?').run(role, week, target.id);
  log(null, user.id, 'a modifié le membre', target.name);
  return { ok: true };
});

route('POST', '/api/users/:id/password', ({ user, params, body }) => {
  requireAdmin(user);
  const target = must(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id)), 'Membre');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password(body.password)), target.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
  log(null, user.id, 'a réinitialisé le mot de passe de', target.name);
  return { ok: true };
});

route('DELETE', '/api/users/:id', ({ user, params }) => {
  requireAdmin(user);
  const target = must(db.prepare('SELECT * FROM users WHERE id = ?').get(Number(params.id)), 'Membre');
  if (target.id === user.id) throw bad('Vous ne pouvez pas supprimer votre propre compte.');
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  log(null, user.id, 'a supprimé le membre', target.name);
  return { ok: true };
});

route('PUT', '/api/settings', ({ user, body }) => {
  requireAdmin(user);
  setSetting('week_b_parity', oneOf(String(body.week_b_parity), ['0', '1'], 'réglage'));
  log(null, user.id, 'a modifié le calendrier des semaines B/C');
  return { ok: true, currentWeek: weekGroupOf(today()) };
});

// --- dashboard ---
route('GET', '/api/dashboard', ({ user }) => {
  const t = today();
  const myTasks = db.prepare(`
    SELECT t.*, p.title AS project_title FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE t.assignee_id = ? AND t.status != 'done' AND p.status != 'archive'
    ORDER BY (t.due_date IS NULL), t.due_date, t.id LIMIT 30`).all(user.id);
  const handoff = db.prepare(`
    SELECT n.*, p.title AS project_title, u.name AS author_name, u.color AS author_color
    FROM notes n JOIN projects p ON p.id = n.project_id LEFT JOIN users u ON u.id = n.user_id
    WHERE n.kind = 'passation' AND (n.week_group IS NULL OR n.week_group != ?)
    ORDER BY n.id DESC LIMIT 8`).all(user.week_group);
  const upcoming = db.prepare(`
    SELECT e.*, p.title AS project_title FROM events e JOIN projects p ON p.id = e.project_id
    WHERE e.date >= ? ORDER BY e.date, e.start_time LIMIT 8`).all(t);
  const activity = db.prepare(`
    SELECT a.*, u.name AS user_name, u.color AS user_color, p.title AS project_title
    FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN projects p ON p.id = a.project_id
    ORDER BY a.id DESC LIMIT 15`).all();
  const stats = {
    activeProjects: db.prepare("SELECT COUNT(*) c FROM projects WHERE status NOT IN ('livre','archive')").get().c,
    openTasks: db.prepare("SELECT COUNT(*) c FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.status != 'done' AND p.status != 'archive'").get().c,
    overdue: db.prepare("SELECT COUNT(*) c FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.status != 'done' AND p.status != 'archive' AND t.due_date < ?").get(t).c,
    blocked: db.prepare("SELECT COUNT(*) c FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.status = 'blocked' AND p.status != 'archive'").get().c,
  };
  return { currentWeek: weekGroupOf(t), today: t, myTasks, handoff, upcoming, activity, stats };
});

// --- projects ---
const PROJECT_LIST_SQL = `
  SELECT p.*, o.name AS owner_name, o.color AS owner_color,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS tasks_total,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS tasks_done,
    (SELECT COUNT(*) FROM project_members m WHERE m.project_id = p.id) AS members_count
  FROM projects p LEFT JOIN users o ON o.id = p.owner_id`;

route('GET', '/api/projects', () => ({
  projects: db.prepare(`${PROJECT_LIST_SQL} ORDER BY (p.status = 'archive'), p.updated_at DESC`).all(),
}));

function projectBody(body, existing = {}) {
  const pick = (k, fn) => (body[k] !== undefined ? fn(body[k]) : existing[k]);
  return {
    title: pick('title', (v) => str(v, { max: 120, required: true, name: 'titre' })),
    kind: pick('kind', (v) => oneOf(v, PROJECT_KINDS, 'type')) ?? 'autre',
    origin: pick('origin', (v) => oneOf(v, ['interne', 'externe'], 'origine')) ?? 'interne',
    client: pick('client', (v) => str(v, { max: 120 })) ?? '',
    description: pick('description', (v) => str(v, { max: 5000 })) ?? '',
    status: pick('status', (v) => oneOf(v, PROJECT_STATUSES, 'statut')) ?? 'idee',
    deadline: pick('deadline', (v) => dateOrNull(v, 'date de livraison')) ?? null,
    owner_id: pick('owner_id', (v) => idOrNull(v, 'users')) ?? null,
  };
}

route('POST', '/api/projects', ({ user, body }) => {
  const p = projectBody({ owner_id: user.id, ...body });
  const id = transaction(() => {
    const info = db.prepare(`INSERT INTO projects (title, kind, origin, client, description, status, deadline, owner_id, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(p.title, p.kind, p.origin, p.client, p.description, p.status, p.deadline, p.owner_id, user.id);
    const pid = Number(info.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, job) VALUES (?,?,?)').run(pid, user.id, 'Responsable');
    if (p.owner_id && p.owner_id !== user.id) db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, job) VALUES (?,?,?)').run(pid, p.owner_id, 'Responsable');
    log(pid, user.id, 'a créé le projet', p.title);
    return pid;
  });
  return { id };
});

route('GET', '/api/projects/:id', ({ params }) => {
  const p = must(db.prepare(`${PROJECT_LIST_SQL} WHERE p.id = ?`).get(Number(params.id)), 'Projet');
  p.members = db.prepare(`SELECT u.id, u.name, u.color, u.week_group, u.job AS user_job, m.job
    FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY u.name COLLATE NOCASE`).all(p.id);
  return { project: p };
});

route('PATCH', '/api/projects/:id', ({ user, params, body }) => {
  const existing = project(params.id);
  const p = projectBody(body, existing);
  db.prepare("UPDATE projects SET title=?, kind=?, origin=?, client=?, description=?, status=?, deadline=?, owner_id=?, updated_at=datetime('now') WHERE id=?")
    .run(p.title, p.kind, p.origin, p.client, p.description, p.status, p.deadline, p.owner_id, existing.id);
  if (p.status !== existing.status) log(existing.id, user.id, 'a passé le projet en', p.status);
  else log(existing.id, user.id, 'a modifié le projet', p.title);
  return { ok: true };
});

route('DELETE', '/api/projects/:id', ({ user, params }) => {
  const p = project(params.id);
  requireAuthor(user, p.created_by, p.owner_id);
  const files = db.prepare('SELECT stored_name FROM documents WHERE project_id = ? AND stored_name IS NOT NULL').all(p.id);
  db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  for (const f of files) fs.rmSync(path.join(UPLOAD_DIR, f.stored_name), { force: true });
  log(null, user.id, 'a supprimé le projet', p.title);
  return { ok: true };
});

route('PUT', '/api/projects/:id/members/:uid', ({ user, params, body }) => {
  const p = project(params.id);
  const uid = idOrNull(params.uid, 'users');
  db.prepare('INSERT INTO project_members (project_id, user_id, job) VALUES (?,?,?) ON CONFLICT(project_id, user_id) DO UPDATE SET job = excluded.job')
    .run(p.id, uid, str(body.job, { max: 80 }));
  const name = db.prepare('SELECT name FROM users WHERE id = ?').get(uid).name;
  log(p.id, user.id, 'a ajouté à l’équipe', name);
  touch(p.id);
  return { ok: true };
});

route('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
  const p = project(params.id);
  db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(p.id, Number(params.uid));
  const name = db.prepare('SELECT name FROM users WHERE id = ?').get(Number(params.uid))?.name || '';
  log(p.id, user.id, 'a retiré de l’équipe', name);
  return { ok: true };
});

// --- tasks ---
const TASK_SQL = `SELECT t.*, a.name AS assignee_name, a.color AS assignee_color,
  c.name AS created_by_name, up.name AS updated_by_name
  FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id
  LEFT JOIN users c ON c.id = t.created_by LEFT JOIN users up ON up.id = t.updated_by`;

route('GET', '/api/projects/:id/tasks', ({ params }) => {
  const p = project(params.id);
  return { tasks: db.prepare(`${TASK_SQL} WHERE t.project_id = ? ORDER BY (t.due_date IS NULL), t.due_date, t.id`).all(p.id) };
});

function taskBody(body, ex = {}) {
  const pick = (k, fn) => (body[k] !== undefined ? fn(body[k]) : ex[k]);
  return {
    title: pick('title', (v) => str(v, { max: 160, required: true, name: 'titre' })),
    description: pick('description', (v) => str(v, { max: 3000 })) ?? '',
    status: pick('status', (v) => oneOf(v, TASK_STATUSES, 'statut')) ?? 'todo',
    priority: pick('priority', (v) => oneOf(v, PRIORITIES, 'priorité')) ?? 'normal',
    assignee_id: pick('assignee_id', (v) => idOrNull(v, 'users')) ?? null,
    week_group: pick('week_group', (v) => (v ? oneOf(v, ['B', 'C'], 'semaine') : null)) ?? null,
    due_date: pick('due_date', (v) => dateOrNull(v, "date d'échéance")) ?? null,
  };
}

route('POST', '/api/projects/:id/tasks', ({ user, params, body }) => {
  const p = project(params.id);
  const t = taskBody(body);
  const info = db.prepare(`INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, week_group, due_date, created_by, updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(p.id, t.title, t.description, t.status, t.priority, t.assignee_id, t.week_group, t.due_date, user.id, user.id);
  log(p.id, user.id, 'a ajouté la tâche', t.title);
  touch(p.id);
  return { id: Number(info.lastInsertRowid) };
});

route('PATCH', '/api/tasks/:id', ({ user, params, body }) => {
  const ex = must(db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(params.id)), 'Tâche');
  const t = taskBody(body, ex);
  db.prepare("UPDATE tasks SET title=?, description=?, status=?, priority=?, assignee_id=?, week_group=?, due_date=?, updated_by=?, updated_at=datetime('now') WHERE id=?")
    .run(t.title, t.description, t.status, t.priority, t.assignee_id, t.week_group, t.due_date, user.id, ex.id);
  if (t.status !== ex.status) log(ex.project_id, user.id, t.status === 'done' ? 'a terminé la tâche' : 'a déplacé la tâche', `${t.title} → ${t.status}`);
  else log(ex.project_id, user.id, 'a modifié la tâche', t.title);
  touch(ex.project_id);
  return { ok: true };
});

route('DELETE', '/api/tasks/:id', ({ user, params }) => {
  const ex = must(db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(params.id)), 'Tâche');
  requireAuthor(user, ex.created_by, project(ex.project_id).owner_id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(ex.id);
  log(ex.project_id, user.id, 'a supprimé la tâche', ex.title);
  return { ok: true };
});

// --- notes (journal & passation) ---
const NOTE_SQL = `SELECT n.*, u.name AS author_name, u.color AS author_color FROM notes n LEFT JOIN users u ON u.id = n.user_id`;

route('GET', '/api/projects/:id/notes', ({ params }) => {
  const p = project(params.id);
  return { notes: db.prepare(`${NOTE_SQL} WHERE n.project_id = ? ORDER BY n.pinned DESC, n.id DESC`).all(p.id) };
});

route('POST', '/api/projects/:id/notes', ({ user, params, body }) => {
  const p = project(params.id);
  const text = str(body.body, { max: 5000, required: true, name: 'message' });
  const kind = oneOf(body.kind, NOTE_KINDS, 'type', 'info');
  const info = db.prepare('INSERT INTO notes (project_id, user_id, kind, body, week_group) VALUES (?,?,?,?,?)')
    .run(p.id, user.id, kind, text, user.week_group);
  log(p.id, user.id, kind === 'passation' ? 'a laissé une note de passation' : 'a écrit dans le journal', text.slice(0, 80));
  touch(p.id);
  return { id: Number(info.lastInsertRowid) };
});

route('PATCH', '/api/notes/:id', ({ user, params, body }) => {
  const n = must(db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(params.id)), 'Note');
  if (body.pinned !== undefined) {
    db.prepare('UPDATE notes SET pinned = ? WHERE id = ?').run(body.pinned ? 1 : 0, n.id);
  }
  if (body.body !== undefined) {
    requireAuthor(user, n.user_id, null);
    db.prepare('UPDATE notes SET body = ? WHERE id = ?').run(str(body.body, { max: 5000, required: true, name: 'message' }), n.id);
  }
  return { ok: true };
});

route('DELETE', '/api/notes/:id', ({ user, params }) => {
  const n = must(db.prepare('SELECT * FROM notes WHERE id = ?').get(Number(params.id)), 'Note');
  requireAuthor(user, n.user_id, project(n.project_id).owner_id);
  db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
  return { ok: true };
});

// --- documents ---
const DOC_SQL = `SELECT d.id, d.project_id, d.user_id, d.title, d.category, d.filename, d.mime, d.size, d.url, d.created_at,
  u.name AS author_name, u.color AS author_color FROM documents d LEFT JOIN users u ON u.id = d.user_id`;

route('GET', '/api/projects/:id/documents', ({ params }) => {
  const p = project(params.id);
  return { documents: db.prepare(`${DOC_SQL} WHERE d.project_id = ? ORDER BY d.id DESC`).all(p.id) };
});

// Ajout d'un lien (Drive, WeTransfer, Frame.io…)
route('POST', '/api/projects/:id/documents', ({ user, params, body }) => {
  const p = project(params.id);
  const title = str(body.title, { max: 160, required: true, name: 'titre' });
  const info = db.prepare('INSERT INTO documents (project_id, user_id, title, category, url) VALUES (?,?,?,?,?)')
    .run(p.id, user.id, title, oneOf(body.category, DOC_CATEGORIES, 'catégorie', 'autre'), url(body.url));
  log(p.id, user.id, 'a ajouté un lien', title);
  touch(p.id);
  return { id: Number(info.lastInsertRowid) };
});

// Envoi d'un fichier : corps brut, métadonnées dans les en-têtes.
route('POST', '/api/projects/:id/upload', async ({ user, params, req }) => {
  const p = project(params.id);
  const declared = Number(req.headers['content-length']);
  if (declared > MAX_UPLOAD) throw new HttpError(413, `Fichier trop volumineux (${Math.round(MAX_UPLOAD / 1048576)} Mo maximum).`);
  let filename;
  try { filename = decodeURIComponent(String(req.headers['x-filename'] || '')); } catch { throw bad('Nom de fichier invalide.'); }
  filename = path.basename(filename).replace(/[\u0000-\u001f"\\/]/g, '_').slice(0, 200);
  if (!filename) throw bad('Nom de fichier manquant.');
  let title = '';
  try { title = decodeURIComponent(String(req.headers['x-title'] || '')); } catch { /* ignore */ }
  title = str(title || filename, { max: 160, name: 'titre' });
  let category;
  try { category = oneOf(String(req.headers['x-category'] || 'autre'), DOC_CATEGORIES, 'catégorie'); } catch { category = 'autre'; }
  const stored = crypto.randomUUID();
  const dest = path.join(UPLOAD_DIR, stored);
  let size = 0;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest, { flags: 'wx' });
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_UPLOAD) { req.unpipe(out); out.destroy(); reject(new HttpError(413, 'Fichier trop volumineux.')); }
      });
      req.on('error', reject);
      req.on('aborted', () => reject(new Error('aborted')));
      out.on('error', reject);
      out.on('finish', resolve);
      req.pipe(out);
    });
  } catch (e) {
    fs.rm(dest, { force: true }, () => {});
    throw e;
  }
  if (size === 0) { fs.rmSync(dest, { force: true }); throw bad('Le fichier est vide.'); }
  const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].slice(0, 100);
  const info = db.prepare('INSERT INTO documents (project_id, user_id, title, category, filename, stored_name, mime, size) VALUES (?,?,?,?,?,?,?,?)')
    .run(p.id, user.id, title, category, filename, stored, mime, size);
  log(p.id, user.id, 'a déposé un document', title);
  touch(p.id);
  return { id: Number(info.lastInsertRowid) };
}, { raw: true });

const INLINE_TYPES = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|ogg|webm))$/;

route('GET', '/api/documents/:id/file', ({ params, res, req }) => {
  const d = must(db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(params.id)), 'Document');
  if (!d.stored_name) throw new HttpError(404, "Ce document n'est pas un fichier.");
  const file = path.join(UPLOAD_DIR, d.stored_name);
  let stat;
  try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'Fichier introuvable sur le serveur.'); }
  const inline = INLINE_TYPES.test(d.mime) && !req.url.includes('download=1');
  const asciiName = d.filename.replace(/[^\x20-\x7e]/g, '_');
  res.setHeader('Content-Type', inline ? d.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; media-src 'self'; img-src 'self'");
  res.setHeader('Accept-Ranges', 'bytes');
  let start = 0, end = stat.size - 1;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), end); }
    else { start = Math.max(0, stat.size - Number(m[2])); }
    if (start > end || start >= stat.size) { res.statusCode = 416; res.setHeader('Content-Range', `bytes */${stat.size}`); res.end(); return { handled: true }; }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
  }
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(file, { start, end }).pipe(res);
  return { handled: true };
});

route('DELETE', '/api/documents/:id', ({ user, params }) => {
  const d = must(db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(params.id)), 'Document');
  requireAuthor(user, d.user_id, project(d.project_id).owner_id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  if (d.stored_name) fs.rmSync(path.join(UPLOAD_DIR, d.stored_name), { force: true });
  log(d.project_id, user.id, 'a supprimé un document', d.title);
  return { ok: true };
});

// --- planning (événements) ---
const EVENT_SQL = `SELECT e.*, p.title AS project_title, u.name AS author_name FROM events e
  JOIN projects p ON p.id = e.project_id LEFT JOIN users u ON u.id = e.created_by`;

route('GET', '/api/events', ({ query }) => {
  const from = dateOrNull(query.get('from')) || '0000-01-01';
  const to = dateOrNull(query.get('to')) || '9999-12-31';
  return { events: db.prepare(`${EVENT_SQL} WHERE e.date BETWEEN ? AND ? ORDER BY e.date, e.start_time, e.id`).all(from, to) };
});

route('GET', '/api/projects/:id/events', ({ params }) => {
  const p = project(params.id);
  return { events: db.prepare(`${EVENT_SQL} WHERE e.project_id = ? ORDER BY e.date, e.start_time`).all(p.id) };
});

function eventBody(body, ex = {}) {
  const pick = (k, fn) => (body[k] !== undefined ? fn(body[k]) : ex[k]);
  const e = {
    title: pick('title', (v) => str(v, { max: 160, required: true, name: 'titre' })),
    kind: pick('kind', (v) => oneOf(v, EVENT_KINDS, 'type')) ?? 'tournage',
    date: pick('date', (v) => { if (!v) throw bad('La date est obligatoire.'); return dateOrNull(v); }),
    start_time: pick('start_time', (v) => timeOrNull(v, 'heure de début')) ?? null,
    end_time: pick('end_time', (v) => timeOrNull(v, 'heure de fin')) ?? null,
    location: pick('location', (v) => str(v, { max: 200 })) ?? '',
    notes: pick('notes', (v) => str(v, { max: 3000 })) ?? '',
  };
  if (!e.date) throw bad('La date est obligatoire.');
  if (e.start_time && e.end_time && e.end_time < e.start_time) throw bad("L'heure de fin précède l'heure de début.");
  return e;
}

route('POST', '/api/projects/:id/events', ({ user, params, body }) => {
  const p = project(params.id);
  const e = eventBody(body);
  const info = db.prepare('INSERT INTO events (project_id, title, kind, date, start_time, end_time, location, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(p.id, e.title, e.kind, e.date, e.start_time, e.end_time, e.location, e.notes, user.id);
  log(p.id, user.id, `a planifié (${e.kind})`, `${e.title} — ${e.date}`);
  touch(p.id);
  return { id: Number(info.lastInsertRowid) };
});

route('PATCH', '/api/events/:id', ({ user, params, body }) => {
  const ex = must(db.prepare('SELECT * FROM events WHERE id = ?').get(Number(params.id)), 'Événement');
  const e = eventBody(body, ex);
  db.prepare('UPDATE events SET title=?, kind=?, date=?, start_time=?, end_time=?, location=?, notes=? WHERE id=?')
    .run(e.title, e.kind, e.date, e.start_time, e.end_time, e.location, e.notes, ex.id);
  log(ex.project_id, user.id, 'a modifié le planning', e.title);
  return { ok: true };
});

route('DELETE', '/api/events/:id', ({ user, params }) => {
  const ex = must(db.prepare('SELECT * FROM events WHERE id = ?').get(Number(params.id)), 'Événement');
  db.prepare('DELETE FROM events WHERE id = ?').run(ex.id);
  log(ex.project_id, user.id, 'a supprimé du planning', ex.title);
  return { ok: true };
});

// --- activity ---
route('GET', '/api/projects/:id/activity', ({ params }) => {
  const p = project(params.id);
  return { activity: db.prepare(`SELECT a.*, u.name AS user_name, u.color AS user_color FROM activity a
    LEFT JOIN users u ON u.id = a.user_id WHERE a.project_id = ? ORDER BY a.id DESC LIMIT 100`).all(p.id) };
});

// --- sauvegarde complète (admin) ---
route('GET', '/api/admin/export', ({ user, res }) => {
  requireAdmin(user);
  const dump = { exported_at: new Date().toISOString(), version: 1 };
  for (const t of ['projects', 'project_members', 'tasks', 'notes', 'documents', 'events', 'activity', 'settings']) {
    dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  dump.users = db.prepare(`SELECT ${USER_PUBLIC} FROM users`).all();
  res.setHeader('Content-Disposition', `attachment; filename="agence-sauvegarde-${today()}.json"`);
  return dump;
});

module.exports = { routes, HttpError, weekGroupOf };
