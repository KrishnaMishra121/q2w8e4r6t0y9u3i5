'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const uid = (n = 8) => crypto.randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// Atomic write: temp file + rename, so a crash never leaves a half-written JSON file.
function writeJson(file, data, mode) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

function safeName(name) {
  const ext = path.extname(String(name)).toLowerCase().replace(/[^.a-z0-9]/g, '');
  const base = path.basename(String(name), path.extname(String(name)))
    .normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'media';
  return { base, ext };
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
}

function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = { uid, sleep, ensureDir, readJson, writeJson, safeName, clamp, fmtDuration, timingSafeEqualStr };
