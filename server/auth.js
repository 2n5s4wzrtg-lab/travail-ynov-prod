'use strict';
const crypto = require('node:crypto');
const { db } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'agence_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 864e5;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, expires);
  return { token, expires };
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionToken(req) {
  return parseCookies(req.headers.cookie)[COOKIE];
}

function userFromRequest(req) {
  const token = sessionToken(req);
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, u.week_group, u.job, u.color, u.status, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND u.status = 'approved'`).get(sha(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) { destroySession(token); return null; }
  delete row.expires_at;
  return row;
}

function cookieHeader(token, expires, secure) {
  const maxAge = Math.max(0, Math.floor((expires - Date.now()) / 1000));
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

const clearCookie = `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = {
  hashPassword, verifyPassword, createSession, destroySession, sessionToken,
  userFromRequest, cookieHeader, clearCookie, purgeExpiredSessions,
};
