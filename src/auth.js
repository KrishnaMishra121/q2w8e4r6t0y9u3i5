'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');
const { timingSafeEqualStr, ensureDir } = require('./util');

const SESSION_MS = 12 * 3600 * 1000;
const COOKIE = 'playout_session';
const MAX_SESSIONS = 2000;
const MAX_LOGIN_IPS = 10000;
const CREDENTIALS_FILE = path.join(DATA_DIR, 'admin-credentials.json');

function validateCredentials(username, password) {
  if (!/^[a-zA-Z0-9._-]{8,64}$/.test(username)) {
    throw new Error('APP_USERNAME must be 8–64 letters, numbers, dots, underscores or hyphens.');
  }
  if (password.length < 20 || /[\u0000-\u001f\u007f]/.test(password)) {
    throw new Error('APP_PASSWORD must be at least 20 characters and contain no control characters.');
  }
}

function loadCredentials() {
  const username = process.env.APP_USERNAME;
  const password = process.env.APP_PASSWORD;
  if (username || password) {
    if (!username || !password) throw new Error('Set both APP_USERNAME and APP_PASSWORD, or unset both to generate secure first-run credentials.');
    const credentials = { username: String(username).trim(), password: String(password) };
    validateCredentials(credentials.username, credentials.password);
    return { ...credentials, generated: false, source: 'environment' };
  }

  ensureDir(DATA_DIR);
  try {
    const saved = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    if (!saved || typeof saved.username !== 'string' || typeof saved.password !== 'string') throw new Error('invalid credential file');
    validateCredentials(saved.username, saved.password);
    fs.chmodSync(CREDENTIALS_FILE, 0o600);
    return { ...saved, generated: false, source: CREDENTIALS_FILE };
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`Cannot load ${CREDENTIALS_FILE}: ${e.message}`);
  }

  const credentials = {
    username: `admin-${crypto.randomBytes(8).toString('hex')}`,
    password: crypto.randomBytes(32).toString('base64url'),
  };
  fs.writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(credentials, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { ...credentials, generated: true, source: CREDENTIALS_FILE };
}

class Auth {
  constructor(username, password) {
    this.username = String(username).trim();
    this.password = String(password);
    validateCredentials(this.username, this.password);
    this.sessions = new Map();
    this.attempts = new Map();
  }
  _cookie(req) {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    return m ? m[1] : null;
  }
  _matches(req) {
    const user = String(req.body?.username ?? '').trim();
    const pass = String(req.body?.password ?? '');
    return user === this.username && timingSafeEqualStr(pass, this.password);
  }
  login(req, res) {
    const ip = req.ip || 'unknown';
    if (!this.attempts.has(ip) && this.attempts.size >= MAX_LOGIN_IPS) {
      const now = Date.now();
      for (const [address, attempt] of this.attempts) if (attempt.reset <= now) this.attempts.delete(address);
      if (this.attempts.size >= MAX_LOGIN_IPS) return res.status(503).json({ error: 'Login is temporarily unavailable. Try again shortly.' });
    }
    const a = this.attempts.get(ip) || { n: 0, reset: Date.now() + 300000 };
    if (Date.now() > a.reset) { a.n = 0; a.reset = Date.now() + 300000; }
    if (a.n >= 10) return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
    if (!this._matches(req)) {
      a.n++; this.attempts.set(ip, a);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    this.attempts.delete(ip);
    const now = Date.now();
    for (const [session, expires] of this.sessions) if (expires <= now) this.sessions.delete(session);
    if (this.sessions.size >= MAX_SESSIONS) return res.status(503).json({ error: 'The maximum number of active sessions has been reached.' });
    const sid = crypto.randomBytes(32).toString('base64url');
    this.sessions.set(sid, now + SESSION_MS);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
    res.json({ ok: true, username: this.username });
  }
  logout(req, res) {
    const sid = this._cookie(req); if (sid) this.sessions.delete(sid);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    res.json({ ok: true });
  }
  isAuthed(req) {
    const sid = this._cookie(req);
    const exp = sid && this.sessions.get(sid);
    if (exp && exp > Date.now()) return true;
    if (exp) this.sessions.delete(sid);
    return false;
  }
  middleware() {
    return (req, res, next) => {
      if (!this.isAuthed(req)) return res.status(401).json({ error: 'Sign in required.', code: 'AUTH' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-playout'] !== '1') {
        return res.status(403).json({ error: 'Missing X-Playout header.' });
      }
      next();
    };
  }
}
module.exports = { Auth, loadCredentials };
