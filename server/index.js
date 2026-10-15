'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const auth = require('./auth');
const { routes, HttpError } = require('./routes');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

const CSP = "default-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Requête trop volumineuse.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch { reject(new HttpError(400, 'JSON invalide.')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const method = req.method;
  let matched = null;
  let pathMatch = false;
  for (const r of routes) {
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    pathMatch = true;
    if (r.method !== method) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    matched = { r, params };
    break;
  }
  if (!matched) throw new HttpError(pathMatch ? 405 : 404, pathMatch ? 'Méthode non autorisée.' : 'Route inconnue.');

  // Protection CSRF : un en-tête personnalisé est exigé pour toute écriture.
  if (method !== 'GET' && req.headers['x-requested-with'] !== 'agence') throw new HttpError(403, 'Requête refusée.');

  const user = auth.userFromRequest(req);
  if (!matched.r.public && !user) throw new HttpError(401, 'Connexion requise.');

  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  const secure = Boolean(req.socket.encrypted) || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
  const body = method !== 'GET' && !matched.r.raw ? await readJson(req) : {};

  const result = await matched.r.handler({ req, res, user, params: matched.params, body, query: url.searchParams, ip, secure });
  if (result && result.handled) return;
  send(res, 200, result ?? { ok: true });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.statusCode = 403; return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.statusCode = 404; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('Introuvable'); }
    const ext = path.extname(file);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', st.size);
    res.setHeader('Cache-Control', ext === '.ttf' || ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else { res.statusCode = 405; res.end(); }
  } catch (e) {
    if (res.headersSent) return res.destroy();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Erreur interne du serveur.' });
  }
});
server.requestTimeout = 0; // les gros envois de fichiers peuvent être longs
server.headersTimeout = 30000;

auth.purgeExpiredSessions();
setInterval(auth.purgeExpiredSessions, 3600000).unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`L'agence — plateforme de production  →  http://localhost:${PORT}`));
}
module.exports = server;
