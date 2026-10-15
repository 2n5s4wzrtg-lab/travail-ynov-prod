'use strict';
/* L'agence — plateforme de production. Application monopage sans dépendance.
   Tout le contenu utilisateur est inséré via textContent (jamais innerHTML). */

const S = { user: null, config: null, users: [] };

// ---------- libellés ----------
const L = {
  status: { idee: 'Idée', preprod: 'Pré-production', tournage: 'Tournage', postprod: 'Post-production', livre: 'Livré', archive: 'Archivé' },
  kind: { clip: 'Clip', 'court-metrage': 'Court-métrage', publicite: 'Publicité', corporate: 'Corporate', documentaire: 'Documentaire', interview: 'Interview', evenement: 'Événement', autre: 'Autre' },
  task: { todo: 'À faire', doing: 'En cours', blocked: 'Bloqué', done: 'Terminé' },
  taskColor: { todo: 'var(--muted)', doing: 'var(--blue)', blocked: 'var(--orange)', done: 'var(--green)' },
  prio: { low: 'Basse', normal: 'Normale', high: 'Haute' },
  note: { info: 'Info', passation: 'Passation B ⇄ C', decision: 'Décision', question: 'Question' },
  doc: { scenario: 'Scénario', planning: 'Planning', budget: 'Budget', autorisation: 'Autorisation', contrat: 'Contrat', rushs: 'Rushs', montage: 'Montage', livrable: 'Livrable', reference: 'Référence', autre: 'Autre' },
  event: { tournage: 'Tournage', reperage: 'Repérage', reunion: 'Réunion', montage: 'Montage', livraison: 'Livraison', autre: 'Autre' },
};

// ---------- utilitaires DOM ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const clear = (el) => { el.replaceChildren(); return el; };

function toast(msg, isErr) {
  const t = h('div', { class: 'toast' + (isErr ? ' err' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3200);
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'X-Requested-With': 'agence', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch { throw new Error('Impossible de joindre le serveur.'); }
  let data = {};
  try { data = await res.json(); } catch { /* vide */ }
  if (res.status === 401 && S.user) { S.user = null; renderAuth(); throw new Error('Session expirée, reconnectez-vous.'); }
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}
// Exécute une action, affiche l'erreur éventuelle en toast.
async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r ?? true; }
  catch (e) { toast(e.message, true); return false; }
}

// ---------- dates ----------
const parseTs = (s) => new Date(String(s).replace(' ', 'T') + 'Z');
function ago(s) {
  const sec = Math.max(0, (Date.now() - parseTs(s)) / 1000);
  if (sec < 60) return "à l'instant";
  if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h`;
  if (sec < 86400 * 7) return `il y a ${Math.floor(sec / 86400)} j`;
  return parseTs(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
const dayDate = (d) => new Date(d + 'T12:00:00');
const fmtDate = (d, opts = { day: 'numeric', month: 'short', year: 'numeric' }) => (d ? dayDate(d).toLocaleDateString('fr-FR', opts) : '');
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function mondayOf(dateStr) { const d = dayDate(dateStr); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const f = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - f) / 864e5 - 3 + ((f.getUTCDay() + 6) % 7)) / 7);
}
const weekGroup = (d) => (isoWeek(d) % 2 === S.config.weekBParity ? 'B' : 'C');
const isLate = (due, status) => due && status !== 'done' && due < S.config.today;
const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko');

// ---------- composants ----------
const initials = (name) => (name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
const avatar = (name, color, cls = '') => h('span', { class: 'avatar ' + cls, style: { background: color || '#555' }, title: name || 'Ancien membre' }, initials(name));
const who = (name, color) => h('span', { class: 'who' }, avatar(name, color, 'sm'), name || 'Ancien membre');
const weekBadge = (g) => h('span', { class: `badge week ${g.toLowerCase()}` }, `Semaine ${g}`);
const statusBadge = (s) => h('span', { class: 'badge ' + 'st-' + s }, h('span', { class: 'dot' }), L.status[s]);
const logo = (xl) => h('a', { class: 'logo' + (xl ? ' xl' : ''), href: '#/' }, h('b', {}, "L'agence"), h('i'));

function opts(map, selected) { return Object.entries(map).map(([v, l]) => h('option', { value: v, selected: v === selected }, l)); }
function userOpts(selected, emptyLabel = '— Personne —') {
  return [h('option', { value: '' }, emptyLabel), ...S.users.map((u) => h('option', { value: u.id, selected: u.id === selected }, `${u.name} (${u.week_group})`))];
}
function field(label, input) { return h('label', { class: 'field' }, label, input); }

function modal(title, body, { onClose } = {}) {
  const prev = document.activeElement;
  const close = () => { ov.remove(); document.removeEventListener('keydown', esc); prev?.focus?.(); onClose?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const ov = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', onmousedown: (e) => { if (e.target === ov) close(); } },
    h('div', { class: 'modal' }, h('h2', {}, title), body));
  document.addEventListener('keydown', esc);
  document.body.append(ov);
  ov.querySelector('input:not([type=hidden]), textarea, select')?.focus();
  return { close, el: ov };
}

// Formulaire modal générique : fields = [{name,label,type,...}]
function formModal(title, fields, values, onSubmit, { submitLabel = 'Enregistrer', extra } = {}) {
  const inputs = {};
  const err = h('div', { class: 'error' });
  const rows = fields.map((f) => {
    let input;
    if (f.type === 'select') input = h('select', { name: f.name }, f.options(values[f.name]));
    else if (f.type === 'textarea') input = h('textarea', { name: f.name, placeholder: f.placeholder || '', rows: f.rows || 4 }, values[f.name] ?? '');
    else input = h('input', { name: f.name, type: f.type || 'text', value: values[f.name] ?? '', placeholder: f.placeholder || '', required: f.required, maxlength: f.max });
    inputs[f.name] = input;
    return { f, node: field(f.label, input) };
  });
  const grid = h('div', { class: 'row' });
  const stack = h('div', { class: 'stack' });
  let m;
  rows.forEach(({ f, node }) => (f.half ? grid : stack).append(node));
  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const form = h('form', { class: 'stack', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    const data = {};
    for (const f of fields) data[f.name] = inputs[f.name].value;
    submit.disabled = true; err.textContent = '';
    try { await onSubmit(data); m.close(); } catch (ex) { err.textContent = ex.message; }
    submit.disabled = false;
  } }, stack, grid.children.length ? grid : null, err,
  h('div', { class: 'actions' }, extra, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Annuler'), submit));
  m = modal(title, form);
  return m;
}

function confirmDo(msg, fn) { if (window.confirm(msg)) return fn(); }

// ---------- routage ----------
const root = $('#app');
let current = { path: '' };

async function boot() {
  try {
    S.config = await api('GET', '/api/config');
    S.user = (await api('GET', '/api/me')).user;
    if (S.user) await loadUsers();
  } catch (e) { root.append(h('p', { class: 'main' }, e.message)); return; }
  route();
}
async function loadUsers() { S.users = (await api('GET', '/api/users')).users; }

window.addEventListener('hashchange', route);
async function route() {
  if (!S.user) return renderAuth();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const page = parts[0] || 'accueil';
  const views = { accueil: viewDashboard, projets: parts[1] ? viewProject : viewProjects, planning: viewPlanning, equipe: viewTeam, profil: viewProfile, admin: viewAdmin };
  const view = views[page] || viewDashboard;
  const shell = renderShell(page === 'accueil' || !views[page] ? 'accueil' : page);
  const content = $('#content', shell);
  current = { path: location.hash, page, parts, content, refresh: () => view(content, parts) };
  try { await view(content, parts); }
  catch (e) { clear(content).append(h('div', { class: 'card empty' }, e.message)); }
}
const refresh = () => current.refresh && current.refresh();

// Actualise la vue quand on revient sur l'onglet (travail à plusieurs).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.user && !$('.overlay') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) refresh();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && S.user && !$('.overlay') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) refresh();
}, 60000);

function renderShell(active) {
  clear(root);
  const nav = [['accueil', 'Tableau de bord', '#/'], ['projets', 'Projets', '#/projets'], ['planning', 'Planning', '#/planning'], ['equipe', 'Équipe', '#/equipe']];
  const week = S.config.currentWeek;
  const adminLink = h('a', { class: 'icon-btn', href: '#/admin', title: 'Administration' }, 'Admin');
  if (S.user.role === 'admin') api('GET', '/api/admin/pending-count').then((r) => { if (r.count) adminLink.append(h('span', { class: 'badge c', style: { marginLeft: '6px' }, title: 'Demandes en attente' }, r.count)); }).catch(() => {});
  const el = h('div', {},
    h('header', { class: 'topbar' }, h('div', { class: 'topbar-in' },
      logo(),
      h('nav', { class: 'nav', 'aria-label': 'Navigation principale' }, nav.map(([k, l, href]) => h('a', { href, class: k === active ? 'active' : '' }, l))),
      h('div', { class: 'flex right' },
        h('span', { class: `badge week ${week.toLowerCase()}`, title: 'Semaine en cours' }, `Semaine ${week} en cours`),
        h('a', { href: '#/profil', style: { textDecoration: 'none' }, title: 'Mon profil' }, h('span', { class: 'who' }, avatar(S.user.name, S.user.color), h('span', { class: 'hide-sm' }, S.user.name.split(' ')[0]))),
        S.user.role === 'admin' ? adminLink : null,
        h('button', { class: 'icon-btn', onclick: logout }, 'Déconnexion')))),
    h('main', { class: 'main', id: 'content' }));
  root.append(el);
  return el;
}
async function logout() { await act(() => api('POST', '/api/auth/logout')); S.user = null; location.hash = '#/'; renderAuth(); }

// ---------- connexion / inscription ----------
function renderAuth() {
  clear(root);
  let mode = S.config.firstUser ? 'register' : 'login';
  const box = h('div', { class: 'auth-box' });
  root.append(h('div', { class: 'auth' }, box));
  const showPending = (mail) => {
    clear(box).append(logo(true),
      h('h2', { style: { margin: '26px 0 12px' } }, 'Demande envoyée ✅'),
      h('p', { class: 'tag', style: { margin: '0 0 22px' } }, `Ton profil (${mail}) doit être validé par un administrateur de l'agence avant que tu puisses entrer. Reviens te connecter un peu plus tard : tant que ce n'est pas fait, l'accès reste fermé.`),
      h('button', { class: 'btn primary', style: { width: '100%', padding: '13px' }, onclick: () => { mode = 'login'; draw(); } }, 'Retour à la connexion'));
  };
  const draw = () => {
    const err = h('div', { class: 'error', role: 'alert' });
    const reg = mode === 'register';
    const f = {
      name: h('input', { type: 'text', name: 'name', autocomplete: 'name', maxlength: 80 }),
      job: h('input', { type: 'text', name: 'job', placeholder: 'Réalisateur, cadreur, monteur…', maxlength: 80 }),
      email: h('input', { type: 'email', name: 'email', autocomplete: 'email', required: true }),
      password: h('input', { type: 'password', name: 'password', autocomplete: reg ? 'new-password' : 'current-password', required: true }),
      invite: h('input', { type: 'text', name: 'invite', autocomplete: 'off' }),
    };
    const btn = h('button', { class: 'btn primary', type: 'submit', style: { width: '100%', padding: '13px' } }, reg ? (S.config.firstUser ? 'Créer mon profil' : 'Demander à rejoindre l\'agence') : 'Se connecter');
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try {
        const body = { email: f.email.value, password: f.password.value };
        if (reg) Object.assign(body, { name: f.name.value, job: f.job.value, invite: f.invite.value, week_group: form.week_group.value });
        const r = await api('POST', reg ? '/api/auth/register' : '/api/auth/login', body);
        if (r.pending) return showPending(f.email.value);
        S.user = r.user;
        S.config = await api('GET', '/api/config');
        await loadUsers();
        location.hash = '#/'; route();
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    } },
    reg ? field('Nom complet', f.name) : null,
    reg ? field('Poste (facultatif)', f.job) : null,
    field('E-mail', f.email),
    field(reg ? 'Mot de passe (8 caractères minimum)' : 'Mot de passe', f.password),
    reg ? h('div', { class: 'field' }, 'Tu travailles en semaine…',
      h('div', { class: 'seg' },
        h('label', {}, h('input', { type: 'radio', name: 'week_group', value: 'B', checked: true }), h('span', { class: 'b' }, 'Semaine B')),
        h('label', {}, h('input', { type: 'radio', name: 'week_group', value: 'C' }), h('span', { class: 'c' }, 'Semaine C')))) : null,
    reg && S.config.inviteRequired ? field("Code d'invitation (donné par l'agence)", f.invite) : null,
    err, btn,
    h('p', { class: 'muted small', style: { textAlign: 'center' } }, reg ? 'Déjà un profil ? ' : 'Pas encore de profil ? ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = reg ? 'login' : 'register'; draw(); } }, reg ? 'Se connecter' : 'Créer mon profil')));
    clear(box).append(logo(true),
      h('p', { class: 'tag' }, S.config.firstUser ? 'Bienvenue ! Le premier profil créé devient administrateur de la plateforme.' : (reg ? 'Ton profil sera examiné par un administrateur de l\'agence avant d\'être activé.' : 'Production & coordination de projets — semaines B et C réunies.')),
      form);
    f[reg ? 'name' : 'email'].focus();
  };
  draw();
}

// ---------- tableau de bord ----------
async function viewDashboard(c) {
  const d = await api('GET', '/api/dashboard');
  S.config.currentWeek = d.currentWeek; S.config.today = d.today;
  const other = S.user.week_group === 'B' ? 'C' : 'B';
  clear(c).append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, `Salut ${S.user.name.split(' ')[0]} 👋`),
      h('p', { class: 'sub' }, fmtDate(d.today, { weekday: 'long', day: 'numeric', month: 'long' })))),
    d.pendingCount ? h('a', { class: 'week-banner', href: '#/admin', style: { textDecoration: 'none', borderColor: 'var(--yellow)' } },
      h('div', { class: 'letter', style: { background: 'var(--yellow)' } }, d.pendingCount),
      h('div', { class: 'grow' }, h('b', {}, d.pendingCount > 1 ? `${d.pendingCount} personnes demandent à rejoindre l'agence` : '1 personne demande à rejoindre l\'agence'),
        h('p', { class: 'muted small' }, 'Accepte ou refuse les demandes depuis l\'administration.')), h('span', { class: 'btn small' }, 'Traiter →')) : null,
    h('div', { class: 'week-banner' },
      h('div', { class: `letter ${d.currentWeek}` }, d.currentWeek),
      h('div', { class: 'grow' }, h('b', {}, `On est en semaine ${d.currentWeek}`),
        h('p', { class: 'muted small' }, d.currentWeek === S.user.week_group ? "C'est ta semaine : les tâches et notes que tu ajoutes serviront de relais à l'autre groupe." : `Ta semaine (${S.user.week_group}) arrive. Consulte ce que le groupe ${other} a laissé pour toi 👇`))),
    h('div', { class: 'stats' },
      stat(d.stats.activeProjects, 'projets en cours'), stat(d.stats.openTasks, 'tâches ouvertes'),
      stat(d.stats.overdue, 'tâches en retard', d.stats.overdue > 0), stat(d.stats.blocked, 'tâches bloquées', d.stats.blocked > 0)),
    h('div', { class: 'grid dash' },
      h('div', { class: 'stack' },
        h('section', { class: 'card' }, h('h2', {}, `Passations de la semaine ${other}`),
          d.handoff.length ? h('div', { class: 'stack' }, d.handoff.map((n) => noteCard(n, { showProject: true }))) : h('p', { class: 'empty' }, `Aucune note de passation du groupe ${other} pour l'instant.`)),
        h('section', { class: 'card' }, h('h2', {}, 'Mes tâches'),
          d.myTasks.length ? h('div', { class: 'list' }, d.myTasks.map((t) => h('div', { class: 'item' },
            h('span', { class: 'dot', style: { color: L.taskColor[t.status], marginTop: '8px' } }),
            h('div', { class: 'grow' }, h('a', { class: 't', href: `#/projets/${t.project_id}/taches` }, t.title),
              h('div', { class: 'due' }, t.project_title, t.due_date ? ' · ' : '', t.due_date ? h('span', { class: isLate(t.due_date, t.status) ? 'late' : '' }, 'pour le ' + fmtDate(t.due_date, { day: 'numeric', month: 'short' })) : '')),
            t.week_group ? weekBadge(t.week_group) : null))) : h('p', { class: 'empty' }, 'Rien ne t’est assigné. Va piocher dans un projet !'))),
      h('div', { class: 'stack' },
        h('section', { class: 'card' }, h('h2', {}, 'À venir'),
          d.upcoming.length ? h('div', { class: 'list' }, d.upcoming.map((e) => h('div', { class: 'item' },
            h('div', { class: 'grow' }, h('a', { class: 't', href: `#/projets/${e.project_id}/planning` }, e.title),
              h('div', { class: 'due' }, `${L.event[e.kind]} · ${fmtDate(e.date, { weekday: 'short', day: 'numeric', month: 'short' })}${e.start_time ? ' · ' + e.start_time : ''} · ${e.project_title}`)),
            weekBadge(weekGroup(dayDate(e.date)))))) : h('p', { class: 'empty' }, 'Rien de planifié.')),
        h('section', { class: 'card' }, h('h2', {}, 'Activité récente'), activityList(d.activity, true)))));
}
const stat = (n, label, warn) => h('div', { class: 'stat' + (warn ? ' warn' : '') }, h('b', {}, n), h('span', {}, label));

function activityList(items, withProject) {
  if (!items.length) return h('p', { class: 'empty' }, 'Aucune activité.');
  return h('div', { class: 'list' }, items.map((a) => h('div', { class: 'item' }, avatar(a.user_name, a.user_color, 'sm'),
    h('div', { class: 'grow small' }, h('b', {}, a.user_name || 'Ancien membre'), ' ', a.action, a.detail ? h('span', { class: 'muted' }, ` « ${a.detail} »`) : '',
      h('div', { class: 'due' }, ago(a.created_at), withProject && a.project_title ? ` · ${a.project_title}` : '')))));
}

// ---------- projets ----------
async function viewProjects(c) {
  const { projects } = await api('GET', '/api/projects');
  const f = { q: '', status: '', origin: '', mine: false };
  const list = h('div', { class: 'grid cols-3' });
  const draw = () => {
    const shown = projects.filter((p) => (!f.q || `${p.title} ${p.client}`.toLowerCase().includes(f.q.toLowerCase()))
      && (f.status ? p.status === f.status : p.status !== 'archive' || f.status === 'archive')
      && (!f.origin || p.origin === f.origin));
    clear(list);
    if (!shown.length) list.append(h('div', { class: 'card empty', style: { gridColumn: '1/-1' } }, projects.length ? 'Aucun projet ne correspond.' : 'Aucun projet pour le moment. Crée le premier !'));
    shown.forEach((p) => list.append(projectCard(p)));
  };
  clear(c).append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Projets'), h('p', { class: 'sub' }, 'Tous les projets de l\'agence — étudiants et clients extérieurs.')),
      h('button', { class: 'btn primary right', onclick: () => projectForm() }, '+ Nouveau projet')),
    h('div', { class: 'filters' },
      h('input', { type: 'search', placeholder: 'Rechercher un projet ou un client…', 'aria-label': 'Rechercher', oninput: (e) => { f.q = e.target.value; draw(); } }),
      h('select', { 'aria-label': 'Statut', onchange: (e) => { f.status = e.target.value; draw(); } }, h('option', { value: '' }, 'Tous les statuts actifs'), opts(L.status)),
      h('select', { 'aria-label': 'Origine', onchange: (e) => { f.origin = e.target.value; draw(); } }, h('option', { value: '' }, 'Interne + externe'), h('option', { value: 'interne' }, 'Interne (étudiant)'), h('option', { value: 'externe' }, 'Externe (client)'))),
    list);
  draw();
}

function projectCard(p) {
  const pct = p.tasks_total ? Math.round((p.tasks_done / p.tasks_total) * 100) : 0;
  return h('a', { class: 'card pcard', href: `#/projets/${p.id}` },
    h('div', { class: 'meta' }, statusBadge(p.status), h('span', { class: 'badge' }, L.kind[p.kind]), p.origin === 'externe' ? h('span', { class: 'badge' }, 'Client') : null),
    h('h3', {}, p.title),
    p.client ? h('p', { class: 'muted small' }, p.client) : null,
    h('div', {}, h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('span', { style: { width: pct + '%' } })),
      h('p', { class: 'muted small', style: { marginTop: '6px' } }, p.tasks_total ? `${p.tasks_done}/${p.tasks_total} tâches terminées` : 'Aucune tâche')),
    h('div', { class: 'foot' }, p.owner_name ? who(p.owner_name, p.owner_color) : h('span', {}, 'Sans responsable'),
      p.deadline ? h('span', {}, 'Livraison ' + fmtDate(p.deadline, { day: 'numeric', month: 'short' })) : null));
}

function projectForm(p) {
  const v = p || { owner_id: S.user.id, status: 'idee', kind: 'clip', origin: 'interne' };
  formModal(p ? 'Modifier le projet' : 'Nouveau projet', [
    { name: 'title', label: 'Titre du projet', required: true, max: 120 },
    { name: 'kind', label: 'Type', type: 'select', half: true, options: (s) => opts(L.kind, s) },
    { name: 'origin', label: 'Origine', type: 'select', half: true, options: (s) => opts({ interne: 'Interne (étudiant)', externe: 'Externe (client)' }, s) },
    { name: 'client', label: 'Client / commanditaire', half: true },
    { name: 'status', label: 'Statut', type: 'select', half: true, options: (s) => opts(L.status, s) },
    { name: 'deadline', label: 'Date de livraison', type: 'date', half: true },
    { name: 'owner_id', label: 'Responsable', type: 'select', half: true, options: (s) => userOpts(s) },
    { name: 'description', label: 'Description / brief', type: 'textarea', rows: 5 },
  ], v, async (d) => {
    d.owner_id = d.owner_id ? Number(d.owner_id) : null;
    if (p) { await api('PATCH', `/api/projects/${p.id}`, d); toast('Projet mis à jour'); refresh(); }
    else { const r = await api('POST', '/api/projects', d); location.hash = `#/projets/${r.id}`; }
  }, { submitLabel: p ? 'Enregistrer' : 'Créer le projet' });
}

const TABS = [['taches', 'Tâches'], ['journal', 'Journal & passation'], ['documents', 'Documents'], ['planning', 'Planning'], ['equipe', 'Équipe'], ['activite', 'Activité']];

async function viewProject(c, parts) {
  const id = Number(parts[1]);
  const tab = TABS.some(([k]) => k === parts[2]) ? parts[2] : 'taches';
  const { project: p } = await api('GET', `/api/projects/${id}`);
  const pct = p.tasks_total ? Math.round((p.tasks_done / p.tasks_total) * 100) : 0;
  const body = h('div');
  clear(c).append(
    h('a', { href: '#/projets', class: 'muted small' }, '← Tous les projets'),
    h('div', { class: 'page-head', style: { marginTop: '12px' } },
      h('div', { class: 'grow' },
        h('div', { class: 'flex wrap', style: { marginBottom: '10px' } }, statusBadge(p.status), h('span', { class: 'badge' }, L.kind[p.kind]), p.origin === 'externe' ? h('span', { class: 'badge' }, 'Client : ' + (p.client || 'externe')) : null,
          p.deadline ? h('span', { class: 'badge' }, 'Livraison ' + fmtDate(p.deadline)) : null),
        h('h1', {}, p.title),
        p.description ? h('p', { class: 'sub', style: { whiteSpace: 'pre-wrap', maxWidth: '760px' } }, p.description) : null),
      h('div', { class: 'flex' },
        h('button', { class: 'btn', onclick: () => projectForm(p) }, 'Modifier'),
        (S.user.role === 'admin' || S.user.id === p.owner_id || S.user.id === p.created_by) ? h('button', { class: 'btn danger', onclick: () => confirmDo(`Supprimer « ${p.title} » et tout son contenu (tâches, notes, documents) ? Action irréversible.`, async () => { if (await act(() => api('DELETE', `/api/projects/${id}`), 'Projet supprimé')) location.hash = '#/projets'; }) }, 'Supprimer') : null)),
    h('div', { class: 'progress', style: { maxWidth: '420px' } }, h('span', { style: { width: pct + '%' } })),
    h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, l]) => h('a', { href: `#/projets/${id}/${k}`, class: k === tab ? 'active' : '', role: 'tab' }, l))),
    body);
  await ({ taches: tabTasks, journal: tabNotes, documents: tabDocs, planning: tabEvents, equipe: tabMembers, activite: tabActivity })[tab](body, p);
}

// --- onglet tâches (kanban) ---
async function tabTasks(el, p) {
  const { tasks } = await api('GET', `/api/projects/${p.id}/tasks`);
  const cols = h('div', { class: 'kanban' });
  const order = ['todo', 'doing', 'blocked', 'done'];
  for (const st of order) {
    const items = tasks.filter((t) => t.status === st);
    const col = h('div', { class: 'col',
      ondragover: (e) => { e.preventDefault(); col.classList.add('over'); },
      ondragleave: () => col.classList.remove('over'),
      ondrop: async (e) => {
        e.preventDefault(); col.classList.remove('over');
        const tid = Number(e.dataTransfer.getData('text/plain'));
        const t = tasks.find((x) => x.id === tid);
        if (t && t.status !== st) { await act(() => api('PATCH', `/api/tasks/${tid}`, { status: st })); refresh(); }
      } },
      h('div', { class: 'col-head' }, h('span', { class: 'dot', style: { color: L.taskColor[st] } }), L.task[st], h('span', { class: 'count' }, items.length)),
      items.map((t) => h('div', { class: 'tcard', draggable: 'true', tabindex: 0, role: 'button',
        ondragstart: (e) => { e.dataTransfer.setData('text/plain', String(t.id)); e.currentTarget.classList.add('dragging'); },
        ondragend: (e) => e.currentTarget.classList.remove('dragging'),
        onclick: () => taskForm(p, t),
        onkeydown: (e) => { if (e.key === 'Enter') taskForm(p, t); } },
      h('div', { class: 't' }, t.title),
      h('div', { class: 'meta' },
        t.assignee_name ? avatar(t.assignee_name, t.assignee_color, 'sm') : h('span', { class: 'badge' }, 'Non assignée'),
        t.week_group ? weekBadge(t.week_group) : null,
        t.priority === 'high' ? h('span', { class: 'badge prio-high' }, '▲ Haute') : null,
        t.due_date ? h('span', { class: 'due' + (isLate(t.due_date, t.status) ? ' late' : '') }, fmtDate(t.due_date, { day: 'numeric', month: 'short' })) : null,
        st !== 'done' ? h('button', { class: 'icon-btn adv', title: 'Passer à l\'étape suivante', 'aria-label': 'Étape suivante', onclick: async (e) => { e.stopPropagation(); await act(() => api('PATCH', `/api/tasks/${t.id}`, { status: order[order.indexOf(st === 'blocked' ? 'doing' : st) + 1] })); refresh(); } }, '→') : null),
      t.updated_by_name ? h('div', { class: 'due', style: { marginTop: '8px' } }, `Modifiée par ${t.updated_by_name} · ${ago(t.updated_at)}`) : null)));
    cols.append(col);
  }
  el.append(h('div', { class: 'flex', style: { marginBottom: '16px' } },
    h('p', { class: 'muted small' }, 'Glisse les cartes d\'une colonne à l\'autre, ou utilise la flèche →'),
    h('button', { class: 'btn primary right', onclick: () => taskForm(p) }, '+ Nouvelle tâche')), cols);
}

function taskForm(p, t) {
  const v = t || { status: 'todo', priority: 'normal', assignee_id: null, week_group: '' };
  const m = formModal(t ? 'Modifier la tâche' : 'Nouvelle tâche', [
    { name: 'title', label: 'Tâche', required: true, max: 160 },
    { name: 'description', label: 'Détails (où en est-on, ce qu\'il reste à faire…)', type: 'textarea', rows: 4 },
    { name: 'assignee_id', label: 'Assignée à', type: 'select', half: true, options: (s) => userOpts(s, '— Personne —') },
    { name: 'week_group', label: 'À faire en semaine', type: 'select', half: true, options: (s) => [h('option', { value: '' }, 'Peu importe'), h('option', { value: 'B', selected: s === 'B' }, 'Semaine B'), h('option', { value: 'C', selected: s === 'C' }, 'Semaine C')] },
    { name: 'status', label: 'Statut', type: 'select', half: true, options: (s) => opts(L.task, s) },
    { name: 'priority', label: 'Priorité', type: 'select', half: true, options: (s) => opts(L.prio, s) },
    { name: 'due_date', label: 'Échéance', type: 'date', half: true },
  ], v, async (d) => {
    d.assignee_id = d.assignee_id ? Number(d.assignee_id) : null;
    d.week_group = d.week_group || null;
    if (t) await api('PATCH', `/api/tasks/${t.id}`, d); else await api('POST', `/api/projects/${p.id}/tasks`, d);
    toast(t ? 'Tâche mise à jour' : 'Tâche ajoutée'); refresh();
  }, { submitLabel: t ? 'Enregistrer' : 'Ajouter',
    extra: t ? h('button', { class: 'btn danger', type: 'button', style: { marginRight: 'auto' }, onclick: () => confirmDo('Supprimer cette tâche ?', async () => { if (await act(() => api('DELETE', `/api/tasks/${t.id}`), 'Tâche supprimée')) { m.close(); refresh(); } }) }, 'Supprimer') : null });
}

// --- onglet journal / passation ---
function noteCard(n, { showProject, onChange } = {}) {
  return h('article', { class: `note ${n.kind}${n.pinned ? ' pinned' : ''}` },
    h('div', { class: 'note-head' }, who(n.author_name, n.author_color),
      n.week_group ? weekBadge(n.week_group) : null,
      h('span', { class: 'badge' }, L.note[n.kind]),
      n.pinned ? h('span', { class: 'badge' }, '📌 Épinglée') : null,
      h('span', { class: 'due right' }, ago(n.created_at)),
      onChange ? h('button', { class: 'icon-btn', title: n.pinned ? 'Désépingler' : 'Épingler', onclick: async () => { await act(() => api('PATCH', `/api/notes/${n.id}`, { pinned: !n.pinned })); onChange(); } }, '📌') : null,
      onChange && (S.user.role === 'admin' || S.user.id === n.user_id) ? h('button', { class: 'icon-btn', title: 'Supprimer', onclick: () => confirmDo('Supprimer cette note ?', async () => { await act(() => api('DELETE', `/api/notes/${n.id}`)); onChange(); }) }, '✕') : null),
    showProject ? h('a', { class: 'small', href: `#/projets/${n.project_id}/journal` }, n.project_title) : null,
    h('p', { class: 'body' }, n.body));
}

async function tabNotes(el, p) {
  const { notes } = await api('GET', `/api/projects/${p.id}/notes`);
  const other = S.user.week_group === 'B' ? 'C' : 'B';
  const ta = h('textarea', { placeholder: `Où en est-on ? Qu'est-ce qui est fait, bloqué, à faire en priorité ? (semaine ${other}, c'est pour toi 😉)`, rows: 4, maxlength: 5000, 'aria-label': 'Nouveau message' });
  const kind = h('select', { 'aria-label': 'Type de note', style: { width: 'auto' } }, opts(L.note, 'passation'));
  el.append(
    h('div', { class: 'card', style: { marginBottom: '18px' } },
      h('div', { class: 'stack' }, ta,
        h('div', { class: 'flex wrap' }, kind,
          h('span', { class: 'muted small' }, `Signé : ${S.user.name} · semaine ${S.user.week_group}`),
          h('button', { class: 'btn primary right', onclick: async () => {
            if (!ta.value.trim()) return toast('Écris un message d\'abord.', true);
            if (await act(() => api('POST', `/api/projects/${p.id}/notes`, { body: ta.value, kind: kind.value }), 'Note publiée')) refresh();
          } }, 'Publier')))),
    notes.length ? h('div', { class: 'stack' }, notes.map((n) => noteCard(n, { onChange: refresh }))) : h('p', { class: 'empty' }, 'Aucune note. Commence le journal de ce projet — c\'est le relais entre les semaines B et C.'));
}

// --- onglet documents ---
async function tabDocs(el, p) {
  const { documents } = await api('GET', `/api/projects/${p.id}/documents`);
  const cat = h('select', { 'aria-label': 'Catégorie' }, opts(L.doc, 'autre'));
  const fileInput = h('input', { type: 'file', multiple: true, class: 'hidden' });
  const progress = h('div', { class: 'upbar hidden' }, h('span'));
  const status = h('p', { class: 'muted small', style: { marginTop: '8px' } });
  const upload = async (files) => {
    for (const file of files) {
      progress.classList.remove('hidden'); status.textContent = `Envoi de ${file.name}…`;
      try {
        await new Promise((resolve, reject) => {
          const x = new XMLHttpRequest();
          x.open('POST', `/api/projects/${p.id}/upload`);
          x.setRequestHeader('X-Requested-With', 'agence');
          x.setRequestHeader('X-Filename', encodeURIComponent(file.name));
          x.setRequestHeader('X-Category', cat.value);
          x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
          x.upload.onprogress = (e) => { if (e.lengthComputable) progress.firstChild.style.width = (e.loaded / e.total) * 100 + '%'; };
          x.onload = () => (x.status === 200 ? resolve() : reject(new Error((() => { try { return JSON.parse(x.responseText).error; } catch { return 'Échec de l\'envoi.'; } })())));
          x.onerror = () => reject(new Error('Échec de l\'envoi.'));
          x.send(file);
        });
        toast(`${file.name} ajouté`);
      } catch (e) { toast(`${file.name} : ${e.message}`, true); }
    }
    refresh();
  };
  const drop = h('div', { class: 'drop', tabindex: 0, role: 'button',
    onclick: () => fileInput.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); },
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); upload([...e.dataTransfer.files]); } },
  h('b', {}, 'Glisse tes fichiers ici'), h('p', { class: 'small' }, `ou clique pour parcourir · ${S.config.maxUploadMb} Mo max par fichier`), progress, status);
  fileInput.addEventListener('change', () => upload([...fileInput.files]));
  el.append(
    h('div', { class: 'card', style: { marginBottom: '18px' } }, h('div', { class: 'flex wrap', style: { marginBottom: '14px' } },
      h('span', { class: 'muted small' }, 'Catégorie des fichiers à envoyer :'), h('div', { style: { width: '200px' } }, cat),
      h('button', { class: 'btn small right', onclick: () => linkForm(p) }, '+ Ajouter un lien (Drive, WeTransfer…)')), drop, fileInput),
    h('div', { class: 'card' }, documents.length ? h('div', { class: 'list' }, documents.map((d) => h('div', { class: 'doc' },
      h('div', { class: 'ico' }, d.url ? '🔗' : (d.filename.split('.').pop() || 'fic').slice(0, 4)),
      h('div', { class: 'grow' },
        d.url ? h('a', { class: 't', href: d.url, target: '_blank', rel: 'noopener noreferrer' }, d.title) : h('a', { class: 't', href: `/api/documents/${d.id}/file`, target: '_blank', rel: 'noopener' }, d.title),
        h('div', { class: 'flex wrap small muted', style: { marginTop: '4px' } }, h('span', { class: 'badge' }, L.doc[d.category]), who(d.author_name, d.author_color), `· ${ago(d.created_at)}`, d.size ? `· ${fmtSize(d.size)}` : null)),
      !d.url ? h('a', { class: 'btn small', href: `/api/documents/${d.id}/file?download=1` }, 'Télécharger') : null,
      (S.user.role === 'admin' || S.user.id === d.user_id || S.user.id === p.owner_id) ? h('button', { class: 'icon-btn', title: 'Supprimer', onclick: () => confirmDo(`Supprimer « ${d.title} » ?`, async () => { await act(() => api('DELETE', `/api/documents/${d.id}`)); refresh(); }) }, '✕') : null)))
      : h('p', { class: 'empty' }, 'Aucun document. Dépose le scénario, le plan de travail, les autorisations de tournage…')));
}
function linkForm(p) {
  formModal('Ajouter un lien', [
    { name: 'title', label: 'Titre', required: true },
    { name: 'url', label: 'Adresse du lien', type: 'url', placeholder: 'https://…' },
    { name: 'category', label: 'Catégorie', type: 'select', options: (s) => opts(L.doc, s || 'autre') },
  ], { category: 'autre' }, async (d) => { await api('POST', `/api/projects/${p.id}/documents`, d); toast('Lien ajouté'); refresh(); }, { submitLabel: 'Ajouter' });
}

// --- onglet planning du projet ---
async function tabEvents(el, p) {
  const { events } = await api('GET', `/api/projects/${p.id}/events`);
  el.append(h('div', { class: 'flex', style: { marginBottom: '16px' } }, h('p', { class: 'muted small' }, 'Dates de tournage, repérages, réunions, livraisons.'),
    h('button', { class: 'btn primary right', onclick: () => eventForm(p.id) }, '+ Planifier')),
  ...(events.length ? events.map((e) => eventRow(e, false)) : [h('p', { class: 'empty card' }, 'Rien de planifié pour ce projet.')]));
}
function eventRow(e, showProject) {
  return h('div', { class: `ev ${e.kind}`, tabindex: 0, role: 'button', onclick: () => eventForm(e.project_id, e), onkeydown: (k) => { if (k.key === 'Enter') eventForm(e.project_id, e); } },
    h('div', { class: 'time' }, e.start_time ? `${e.start_time}${e.end_time ? ' – ' + e.end_time : ''}` : 'Journée', h('div', {}, fmtDate(e.date, { day: 'numeric', month: 'short' }))),
    h('div', { class: 'grow' }, h('b', {}, e.title), h('div', { class: 'small muted' }, [L.event[e.kind], showProject ? e.project_title : null, e.location].filter(Boolean).join(' · ')),
      e.notes ? h('div', { class: 'small', style: { marginTop: '4px', whiteSpace: 'pre-wrap' } }, e.notes) : null),
    weekBadge(weekGroup(dayDate(e.date))));
}
function eventForm(projectId, e) {
  const m = formModal(e ? 'Modifier' : 'Planifier', [
    { name: 'title', label: 'Titre', required: true, max: 160 },
    { name: 'kind', label: 'Type', type: 'select', half: true, options: (s) => opts(L.event, s || 'tournage') },
    { name: 'date', label: 'Date', type: 'date', half: true },
    { name: 'start_time', label: 'Début', type: 'time', half: true },
    { name: 'end_time', label: 'Fin', type: 'time', half: true },
    { name: 'location', label: 'Lieu', max: 200 },
    { name: 'notes', label: 'Notes (équipe, matériel, accès…)', type: 'textarea', rows: 3 },
  ], e || { kind: 'tournage', date: S.config.today }, async (d) => {
    if (e) await api('PATCH', `/api/events/${e.id}`, d); else await api('POST', `/api/projects/${projectId}/events`, d);
    toast('Planning mis à jour'); refresh();
  }, { submitLabel: e ? 'Enregistrer' : 'Planifier',
    extra: e ? h('button', { class: 'btn danger', type: 'button', style: { marginRight: 'auto' }, onclick: () => confirmDo('Supprimer cet événement ?', async () => { if (await act(() => api('DELETE', `/api/events/${e.id}`))) { m.close(); refresh(); } }) }, 'Supprimer') : null });
}

// --- onglet équipe du projet ---
async function tabMembers(el, p) {
  const sel = h('select', { 'aria-label': 'Membre' }, h('option', { value: '' }, 'Ajouter un membre…'), S.users.filter((u) => !p.members.some((m) => m.id === u.id)).map((u) => h('option', { value: u.id }, `${u.name} (${u.week_group})`)));
  const job = h('input', { type: 'text', placeholder: 'Rôle sur ce projet (ex. cadreur)', maxlength: 80, 'aria-label': 'Rôle' });
  el.append(h('div', { class: 'card', style: { marginBottom: '18px' } }, h('div', { class: 'flex wrap' }, h('div', { class: 'grow' }, sel), h('div', { class: 'grow' }, job),
    h('button', { class: 'btn primary', onclick: async () => { if (!sel.value) return toast('Choisis un membre.', true); await act(() => api('PUT', `/api/projects/${p.id}/members/${sel.value}`, { job: job.value })); refresh(); } }, 'Ajouter'))),
  h('div', { class: 'people' }, p.members.length ? p.members.map((m) => h('div', { class: 'person' }, avatar(m.name, m.color, 'lg'),
    h('div', { class: 'grow' }, h('b', {}, m.name), h('div', { class: 'small muted' }, m.job || m.user_job || 'Membre'), h('div', { style: { marginTop: '6px' } }, weekBadge(m.week_group))),
    h('button', { class: 'icon-btn', title: 'Retirer', onclick: async () => { await act(() => api('DELETE', `/api/projects/${p.id}/members/${m.id}`)); refresh(); } }, '✕'))) : h('p', { class: 'empty' }, 'Personne dans l\'équipe.')));
}

async function tabActivity(el, p) {
  const { activity } = await api('GET', `/api/projects/${p.id}/activity`);
  el.append(h('div', { class: 'card' }, activityList(activity, false)));
}

// ---------- planning global ----------
let planStart = null;
async function viewPlanning(c) {
  if (!planStart) planStart = iso(mondayOf(S.config.today));
  const weeks = 4;
  const start = dayDate(planStart);
  const end = addDays(start, weeks * 7 - 1);
  const { events } = await api('GET', `/api/events?from=${iso(start)}&to=${iso(end)}`);
  const { projects } = await api('GET', '/api/projects');
  const body = h('div');
  for (let w = 0; w < weeks; w++) {
    const monday = addDays(start, w * 7);
    const g = weekGroup(monday);
    const isCurrent = iso(mondayOf(S.config.today)) === iso(monday);
    const block = h('section', { class: 'week-block' },
      h('div', { class: 'week-title' + (isCurrent ? ' current' : '') }, h('h3', {}, `Semaine ${isoWeek(monday)}`), weekBadge(g), h('span', { class: 'muted small' }, `${fmtDate(iso(monday), { day: 'numeric', month: 'short' })} – ${fmtDate(iso(addDays(monday, 6)), { day: 'numeric', month: 'short' })}`), h('div', { class: 'line' })));
    for (let i = 0; i < 7; i++) {
      const day = iso(addDays(monday, i));
      const evs = events.filter((e) => e.date === day);
      if (!evs.length) continue;
      block.append(h('div', { class: 'day' },
        h('div', { class: 'dlabel' + (day === S.config.today ? ' today' : '') }, fmtDate(day, { weekday: 'short', day: 'numeric', month: 'short' })),
        h('div', {}, evs.map((e) => eventRow(e, true)))));
    }
    if (!block.querySelector('.day')) block.append(h('p', { class: 'muted small', style: { padding: '4px 0 10px' } }, 'Rien de planifié.'));
    body.append(block);
  }
  clear(c).append(
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Planning'), h('p', { class: 'sub' }, 'Toutes les dates de l\'agence, avec l\'alternance des semaines B et C.')),
      h('div', { class: 'flex right wrap' },
        h('button', { class: 'btn small', onclick: () => { planStart = iso(addDays(start, -7 * weeks)); refresh(); } }, '← Précédent'),
        h('button', { class: 'btn small', onclick: () => { planStart = iso(mondayOf(S.config.today)); refresh(); } }, 'Aujourd\'hui'),
        h('button', { class: 'btn small', onclick: () => { planStart = iso(addDays(start, 7 * weeks)); refresh(); } }, 'Suivant →'),
        h('button', { class: 'btn primary', onclick: () => {
          if (!projects.length) return toast('Crée d\'abord un projet.', true);
          const sel = h('select', {}, projects.filter((p) => p.status !== 'archive').map((p) => h('option', { value: p.id }, p.title)));
          const m = modal('Pour quel projet ?', h('div', { class: 'stack' }, sel, h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => { m.close(); eventForm(Number(sel.value)); } }, 'Continuer'))));
        } }, '+ Planifier'))),
    body);
}

// ---------- équipe ----------
async function viewTeam(c) {
  await loadUsers();
  const group = (g) => {
    const us = S.users.filter((u) => u.week_group === g);
    return h('section', {}, h('div', { class: 'group-title' }, h('div', { class: `letter ${g}` }, g), h('h2', {}, `Semaine ${g}`), h('span', { class: 'muted' }, `${us.length} membre${us.length > 1 ? 's' : ''}`)),
      h('div', { class: 'people' }, us.length ? us.map((u) => h('div', { class: 'person' }, avatar(u.name, u.color, 'lg'),
        h('div', { class: 'grow' }, h('b', {}, u.name), u.role === 'admin' ? h('span', { class: 'badge', style: { marginLeft: '8px' } }, 'Admin') : null,
          h('div', { class: 'small muted' }, u.job || 'Membre de l\'agence'), h('a', { class: 'small', href: `mailto:${u.email}` }, u.email)))) : h('p', { class: 'muted' }, 'Personne pour l\'instant.')));
  };
  clear(c).append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'L\'équipe'), h('p', { class: 'sub' }, 'Qui est qui, et dans quelle semaine on le trouve.'))), group('B'), group('C'));
}

// ---------- profil ----------
async function viewProfile(c) {
  const u = S.user;
  let color = u.color;
  const name = h('input', { type: 'text', value: u.name, maxlength: 80 });
  const job = h('input', { type: 'text', value: u.job, maxlength: 80, placeholder: 'Réalisateur, cadreur, monteur…' });
  const week = h('select', {}, h('option', { value: 'B', selected: u.week_group === 'B' }, 'Semaine B'), h('option', { value: 'C', selected: u.week_group === 'C' }, 'Semaine C'));
  const sw = h('div', { class: 'swatches' });
  const drawSw = () => { clear(sw); S.config.enums.COLORS.forEach((col) => sw.append(h('button', { type: 'button', class: col === color ? 'on' : '', style: { background: col }, 'aria-label': col, onclick: () => { color = col; drawSw(); } }))); };
  drawSw();
  const cur = h('input', { type: 'password', autocomplete: 'current-password' });
  const np = h('input', { type: 'password', autocomplete: 'new-password' });
  clear(c).append(h('div', { class: 'page-head' }, h('h1', {}, 'Mon profil')),
    h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' } },
      h('section', { class: 'card stack' }, h('h2', {}, 'Mes informations'),
        h('div', { class: 'muted small' }, 'Ton nom sera affiché sur tout ce que tu ajoutes (tâches, notes, documents).'),
        field('Nom', name), field('Poste', job), field('Semaine', week), h('div', { class: 'field' }, 'Couleur', sw),
        h('button', { class: 'btn primary', onclick: async () => {
          if (await act(async () => { S.user = (await api('PATCH', '/api/me', { name: name.value, job: job.value, week_group: week.value, color })).user; await loadUsers(); }, 'Profil enregistré')) route();
        } }, 'Enregistrer')),
      h('section', { class: 'card stack' }, h('h2', {}, 'Mot de passe'), field('Mot de passe actuel', cur), field('Nouveau mot de passe (8 caractères min.)', np),
        h('button', { class: 'btn', onclick: async () => { if (await act(() => api('POST', '/api/me/password', { current: cur.value, password: np.value }), 'Mot de passe changé')) { cur.value = ''; np.value = ''; } } }, 'Changer le mot de passe'))));
}

// ---------- administration ----------
async function viewAdmin(c) {
  if (S.user.role !== 'admin') { clear(c).append(h('div', { class: 'card empty' }, 'Réservé aux administrateurs.')); return; }
  await loadUsers();
  const cfg = await api('GET', '/api/config');
  S.config = cfg;
  const everyone = (await api('GET', '/api/admin/users')).users;
  const pending = everyone.filter((u) => u.status === 'pending');
  const members = everyone.filter((u) => u.status !== 'pending');
  const decide = (u, verb, msg) => async () => { if (await act(() => api('POST', `/api/users/${u.id}/${verb}`), msg)) route(); };
  clear(c).append(h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Administration'), h('p', { class: 'sub' }, 'Membres, calendrier B/C et sauvegarde.'))),
    h('section', { class: 'card', style: { marginBottom: '18px', borderColor: pending.length ? 'var(--yellow)' : '' } }, h('h2', {}, `Demandes d'adhésion${pending.length ? ` (${pending.length})` : ''}`),
      pending.length ? h('div', { class: 'list' }, pending.map((u) => h('div', { class: 'item', style: { alignItems: 'center', flexWrap: 'wrap' } },
        avatar(u.name, u.color, 'lg'),
        h('div', { class: 'grow' }, h('b', {}, u.name), h('div', { class: 'small muted' }, `${u.email}${u.job ? ' · ' + u.job : ''}`),
          h('div', { class: 'flex wrap', style: { marginTop: '6px' } }, weekBadge(u.week_group), h('span', { class: 'due' }, 'demande ' + ago(u.created_at)))),
        h('div', { class: 'flex' },
          h('button', { class: 'btn primary', onclick: decide(u, 'approve', `${u.name} a rejoint l'agence`) }, '✓ Accepter'),
          h('button', { class: 'btn danger', onclick: () => confirmDo(`Refuser la demande de ${u.name} (${u.email}) ?`, decide(u, 'reject', 'Demande refusée')) }, '✕ Refuser')))))
        : h('p', { class: 'empty' }, 'Aucune demande en attente. Les nouvelles inscriptions apparaîtront ici : personne ne peut entrer sans ton accord.')),
    h('section', { class: 'card', style: { marginBottom: '18px' } }, h('h2', {}, 'Calendrier des semaines'),
      h('p', { class: 'muted', style: { marginBottom: '14px' } }, `Cette semaine (n°${isoWeek(dayDate(cfg.today))}) est la semaine ${cfg.currentWeek}. Les semaines alternent B / C. Si c'est inversé par rapport à votre emploi du temps, inversez-les :`),
      h('button', { class: 'btn', onclick: async () => { if (await act(() => api('PUT', '/api/settings', { week_b_parity: cfg.weekBParity ? 0 : 1 }), 'Semaines inversées')) { S.config = await api('GET', '/api/config'); route(); } } }, '⇄ Inverser B et C')),
    h('section', { class: 'card', style: { marginBottom: '18px' } }, h('h2', {}, 'Membres'),
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' }, h('thead', {}, h('tr', {}, ['Membre', 'Semaine', 'Rôle', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, members.map((u) => h('tr', {},
          h('td', {}, h('div', { class: 'flex' }, avatar(u.name, u.color), h('div', {}, h('b', {}, u.name), u.status === 'rejected' ? h('span', { class: 'badge', style: { marginLeft: '8px', color: 'var(--pink)' } }, 'Accès refusé') : null, h('div', { class: 'small muted' }, u.email)))),
          h('td', {}, h('select', { 'aria-label': 'Semaine', style: { width: '120px' }, onchange: async (e) => { await act(() => api('PATCH', `/api/users/${u.id}`, { week_group: e.target.value }), 'Mis à jour'); } }, h('option', { value: 'B', selected: u.week_group === 'B' }, 'B'), h('option', { value: 'C', selected: u.week_group === 'C' }, 'C'))),
          h('td', {}, h('select', { 'aria-label': 'Rôle', style: { width: '140px' }, onchange: async (e) => { if (!(await act(() => api('PATCH', `/api/users/${u.id}`, { role: e.target.value }), 'Rôle mis à jour'))) route(); } }, h('option', { value: 'member', selected: u.role === 'member' }, 'Membre'), h('option', { value: 'admin', selected: u.role === 'admin' }, 'Admin'))),
          h('td', {}, h('div', { class: 'flex' },
            h('button', { class: 'btn small', onclick: () => formModal(`Nouveau mot de passe — ${u.name}`, [{ name: 'password', label: 'Mot de passe (8 caractères min.)', type: 'password' }], {}, async (d) => { await api('POST', `/api/users/${u.id}/password`, d); toast('Mot de passe réinitialisé'); }, { submitLabel: 'Réinitialiser' }) }, 'Mot de passe'),
            u.status === 'rejected' ? h('button', { class: 'btn small', onclick: decide(u, 'approve', 'Accès rétabli') }, 'Rétablir') : null,
            u.status === 'approved' && u.role !== 'admin' ? h('button', { class: 'btn small danger', title: 'Ferme l\'accès sans supprimer ses contributions', onclick: () => confirmDo(`Retirer l'accès de ${u.name} ? Il sera déconnecté. Ses contributions restent.`, decide(u, 'reject', 'Accès retiré')) }, 'Retirer l\'accès') : null,
            u.id !== S.user.id ? h('button', { class: 'btn small danger', onclick: () => confirmDo(`Supprimer le compte de ${u.name} ? Ses contributions restent, signées « Ancien membre ».`, async () => { await act(() => api('DELETE', `/api/users/${u.id}`), 'Compte supprimé'); route(); }) }, 'Supprimer') : null)))))))),
    h('section', { class: 'card' }, h('h2', {}, 'Sauvegarde'),
      h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'Exporte toutes les données (projets, tâches, notes, planning, journal) en JSON. Les fichiers déposés sont dans le dossier data/uploads du serveur.'),
      h('a', { class: 'btn', href: '/api/admin/export' }, '⬇ Télécharger la sauvegarde')));
}

boot();
