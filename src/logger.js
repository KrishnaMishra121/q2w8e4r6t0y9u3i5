'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// Everything that reaches a log line, an error message or a diagnostic export goes through redact().
const secrets = new Set();
function registerSecret(s) { if (s && String(s).length >= 4) secrets.add(String(s)); }
function unregisterSecret(s) { secrets.delete(String(s)); }

function redact(text) {
  let out = String(text ?? '');
  for (const s of secrets) out = out.split(s).join('[REDACTED]');
  // rtmp(s)://host/app/KEY -> keep host + app, hide the key segment.
  out = out.replace(/(rtmps?:\/\/[^\s/]+\/[^\s/]+\/)([^\s'"]+)/gi, '$1[REDACTED]');
  // userinfo in URLs, bearer tokens, and key=value style secrets
  out = out.replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[REDACTED]@');
  out = out.replace(/(bearer\s+)[\w.\-~+/]+=*/gi, '$1[REDACTED]');
  out = out.replace(/((?:stream[_-]?key|token|password|secret)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[REDACTED]');
  return out;
}

class Logger extends EventEmitter {
  constructor({ dir, max = 3000 } = {}) {
    super();
    this.max = max;
    this.entries = [];
    this.seq = 0;
    this.file = null;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, 'playout.log');
      try { if (fs.statSync(this.file).size > 5 * 1024 * 1024) fs.renameSync(this.file, this.file + '.1'); } catch {}
    }
  }
  log(level, source, message, extra) {
    const entry = { id: ++this.seq, ts: new Date().toISOString(), level, source, message: redact(message) };
    if (extra) entry.extra = JSON.parse(redact(JSON.stringify(extra)));
    this.entries.push(entry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    if (this.file) {
      fs.appendFile(this.file, JSON.stringify(entry) + '\n', () => {});
    }
    this.emit('entry', entry);
    return entry;
  }
  debug(s, m, e) { return this.log('debug', s, m, e); }
  info(s, m, e) { return this.log('info', s, m, e); }
  warn(s, m, e) { return this.log('warn', s, m, e); }
  error(s, m, e) { return this.log('error', s, m, e); }
  query({ level, q, limit = 300, since = 0 } = {}) {
    const rank = { debug: 0, info: 1, warn: 2, error: 3 };
    const min = rank[level] ?? 0;
    const needle = q ? String(q).toLowerCase() : '';
    let list = this.entries.filter((e) => e.id > since && rank[e.level] >= min &&
      (!needle || (e.message + ' ' + e.source).toLowerCase().includes(needle)));
    return list.slice(-Math.min(limit, 2000));
  }
  recent(levels, n = 8) {
    return this.entries.filter((e) => levels.includes(e.level)).slice(-n).reverse();
  }
}

module.exports = { Logger, redact, registerSecret, unregisterSecret };
