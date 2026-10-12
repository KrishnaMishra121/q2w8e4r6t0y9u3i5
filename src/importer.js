'use strict';
const fs = require('fs');
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const { YOUTUBE_DL_PATH } = require('youtube-dl-exec').constants;
const { uid } = require('./util');
const { ALLOWED_EXT, fail } = require('./media');
const { redact } = require('./logger');

// SSRF guard: refuse loopback, private, link-local, CGNAT and other non-public destinations.
function isPrivateAddress(addr) {
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(addr)) {
    const x = addr.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')) return true;
    const m = x.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateAddress(m[1]);
  }
  return false;
}

const allowPrivate = () => process.env.ALLOW_PRIVATE_IMPORTS === '1';

// Validated at connect time (not just before), which closes the DNS-rebinding gap.
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
    if (!allowPrivate() && list.some((a) => isPrivateAddress(a.address))) {
      return cb(Object.assign(new Error('That address points to a private or internal network and cannot be imported from.'), { code: 'PRIVATE_ADDR' }));
    }
    if (options && options.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

const YT_RE = /^(www\.|m\.|music\.)?(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
function isYouTubeVideoUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!YT_RE.test(url.hostname)) return false;
  if (url.hostname.endsWith('youtu.be')) return /^[A-Za-z0-9_-]{6,}$/.test(url.pathname.slice(1));
  const id = url.pathname === '/watch' ? url.searchParams.get('v') : url.pathname.match(/^\/(?:shorts|live|embed|v)\/([^/]+)/)?.[1];
  return !!id && /^[A-Za-z0-9_-]{6,}$/.test(id);
}

function normalizeYtName(title) {
  return String(title || 'youtube-video').replace(/[\\/:*?"<>|\r\n]+/g, ' ').trim().slice(0, 180) || 'youtube-video';
}

const CT_EXT = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/x-msvideo': '.avi', 'video/mp2t': '.ts', 'video/x-m4v': '.m4v' };

class Importer {
  constructor({ media, config, logger }) {
    this.media = media; this.config = config; this.log = logger;
    this.jobs = new Map();
  }
  list() { return [...this.jobs.values()].map(({ controller, tempPrefix, cancelForLimit, ...j }) => j).slice(-20).reverse(); }

  async start(rawUrl) {
    let u;
    try { u = new URL(String(rawUrl).trim()); } catch { throw fail(400, 'BAD_URL', 'Enter a full http:// or https:// URL.'); }
    if (!/^https?:$/.test(u.protocol)) throw fail(400, 'BAD_URL', 'Only http:// and https:// URLs can be imported.');
    if (u.username || u.password) throw fail(400, 'BAD_URL', 'URLs containing a username or password are not accepted. Use a pre-authorised direct link or upload the file.');

    if (YT_RE.test(u.hostname)) {
      if (!isYouTubeVideoUrl(u.href)) {
        throw fail(422, 'YOUTUBE_NOT_DOWNLOADABLE',
          'Enter a YouTube video URL such as a watch, short, or youtu.be link.',
          { guidance: 'upload' });
      }
    }
    if (net.isIP(u.hostname) && isPrivateAddress(u.hostname) && !allowPrivate()) throw fail(400, 'PRIVATE_ADDR', 'That address points to a private or internal network.');

    const id = uid(6);
    const controller = new AbortController();
    const job = { id, url: redact(u.origin + u.pathname), title: null, thumbnail: null, state: 'running', received: 0, total: null, progressPct: 0, error: null, mediaId: null, startedAt: new Date().toISOString(), controller };
    this.jobs.set(id, job);
    this.log.info('import', `Import started: ${job.url}`);
    this._run(job, u).catch(() => {});
    const { controller: _c, ...pub } = job;
    return pub;
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j) throw fail(404, 'NOT_FOUND', 'Import job not found.');
    if (['running', 'processing'].includes(j.state)) { j.state = 'cancelled'; j.controller.abort(); this.log.info('import', 'Import cancelled'); }
    return true;
  }

  _get(url, signal, hops = 0) {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.get(url, { lookup: safeLookup, signal, headers: { 'User-Agent': 'yt-playout-importer/1.0', Accept: 'video/*,*/*;q=0.5' }, timeout: 20000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (hops >= 5) return reject(fail(502, 'REDIRECTS', 'Too many redirects.'));
          let next; try { next = new URL(res.headers.location, url); } catch { return reject(fail(502, 'BAD_REDIRECT', 'Invalid redirect.')); }
          if (!/^https?:$/.test(next.protocol)) return reject(fail(502, 'BAD_REDIRECT', 'Redirected to an unsupported protocol.'));
          return this._get(next, signal, hops + 1).then(resolve, reject);
        }
        resolve({ res, finalUrl: url });
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('Connection timed out.'), { code: 'ETIMEDOUT' })));
      req.on('error', reject);
    });
  }

  _runYtDlp(job, args, onStdout = () => {}, onStderr = () => {}) {
    return new Promise((resolve, reject) => {
      const proc = spawn(process.env.YT_DLP_PATH || YOUTUBE_DL_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      const abort = () => proc.kill('SIGTERM');
      if (job.controller.signal.aborted) abort();
      else job.controller.signal.addEventListener('abort', abort, { once: true });
      proc.stdout.on('data', (chunk) => onStdout(chunk.toString()));
      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderr = (stderr + text).slice(-12000);
        onStderr(text);
        if (job.cancelForLimit) proc.kill('SIGTERM');
      });
      proc.on('error', (error) => {
        job.controller.signal.removeEventListener('abort', abort);
        reject(error);
      });
      proc.on('close', (code) => {
        job.controller.signal.removeEventListener('abort', abort);
        if (job.controller.signal.aborted) return reject(fail(499, 'CANCELLED', 'Download cancelled.'));
        if (job.cancelForLimit) return reject(fail(413, 'TOO_LARGE', `Download exceeded the ${this.config.settings.maxImportMB} MB import limit.`));
        if (code !== 0) return reject(fail(502, 'YOUTUBE_DL_FAILED', stderr.trim() || `yt-dlp exited with code ${code}.`));
        resolve();
      });
    });
  }

  async _downloadYouTube(job, url) {
    const { settings } = this.config;
    const limit = settings.maxImportMB * 1048576;
    const outDir = path.dirname(this.media.tmpPath());
    const baseName = `${uid(8)}-youtube`;
    job.tempPrefix = baseName;
    const outputPattern = path.join(outDir, `${baseName}.%(ext)s`);
    let metadataText = '';
    await this._runYtDlp(job, [url.href, '--no-playlist', '--no-warnings', '--dump-single-json', '--skip-download'], (chunk) => { metadataText = (metadataText + chunk).slice(-2_000_000); });
    let info;
    try { info = JSON.parse(metadataText); } catch { throw fail(502, 'YOUTUBE_METADATA', 'yt-dlp returned invalid video metadata.'); }
    job.title = normalizeYtName(info.title || info.fulltitle);
    const thumbnail = String(info.thumbnail || '');
    try {
      const thumbUrl = new URL(thumbnail);
      if (thumbUrl.protocol === 'https:' && ['i.ytimg.com', 'img.youtube.com'].includes(thumbUrl.hostname)) job.thumbnail = thumbUrl.href;
    } catch {}
    this.media.checkDisk(0, settings.minFreeDiskMB);

    const progress = (text) => {
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/PROGRESS:\s*([\d.]+)%\|([\d.]+|NA)\|([\d.]+|NA)/i);
        if (!m) continue;
        job.progressPct = Math.max(0, Math.min(100, Number(m[1])));
        job.total = Number.isFinite(Number(m[2])) ? Number(m[2]) : null;
        job.received = Number.isFinite(Number(m[3])) ? Number(m[3]) : 0;
        if (job.total > limit || job.received > limit) job.cancelForLimit = true;
      }
    };
    await this._runYtDlp(job, [
      url.href, '--no-playlist', '--no-warnings', '--no-colors', '--newline',
      '--progress-template', 'download:PROGRESS:%(progress._percent_str)s|%(progress.total_bytes_estimate)s|%(progress.downloaded_bytes)s',
      '--merge-output-format', 'mp4', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '-o', outputPattern,
    ], () => {}, progress);

    const candidates = fs.readdirSync(outDir)
      .filter((f) => f.startsWith(baseName) && ALLOWED_EXT.includes(path.extname(f).toLowerCase()))
      .sort((a, b) => fs.statSync(path.join(outDir, b)).size - fs.statSync(path.join(outDir, a)).size);
    if (!candidates.length) throw fail(502, 'DOWNLOAD_FAILED', 'The YouTube download completed but no valid video file was produced.');
    const tmp = path.join(outDir, candidates[0]);
    const size = fs.statSync(tmp).size;
    if (job.cancelForLimit || size > limit) throw fail(413, 'TOO_LARGE', `Download exceeded the ${settings.maxImportMB} MB import limit.`);
    job.total = job.received = size;
    job.progressPct = 100;
    this.media.checkDisk(size, settings.minFreeDiskMB);
    const requestedName = `${job.title}${path.extname(tmp)}`;
    return { tmp, name: requestedName };
  }

  async _run(job, url) {
    const { settings } = this.config;
    const tmp = this.media.tmpPath();
    const cleanup = () => {
      fs.rmSync(tmp, { force: true });
      if (job.tempPrefix) {
        for (const file of fs.readdirSync(path.dirname(tmp))) if (file.startsWith(job.tempPrefix)) fs.rmSync(path.join(path.dirname(tmp), file), { force: true });
      }
    };
    const finish = (state, error) => { job.state = state; job.error = error || null; cleanup(); };
    try {
      const isYt = isYouTubeVideoUrl(url.href);
      let targetTmp = tmp;
      let name = null;
      if (isYt) {
        job.state = 'running';
        const res = await this._downloadYouTube(job, url);
        targetTmp = res.tmp; name = res.name;
      } else {
        const { res, finalUrl } = await this._get(url, job.controller.signal);
        if (res.statusCode === 401 || res.statusCode === 403) { res.resume(); throw fail(403, 'AUTH_REQUIRED', 'The server refused access (HTTP ' + res.statusCode + '). This link needs authorisation, which this tool will not bypass. Download the file yourself and upload it instead.'); }
        if (res.statusCode !== 200) { res.resume(); throw fail(502, 'HTTP_ERROR', `The server answered HTTP ${res.statusCode}.`); }
        const ct = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (/^text\//.test(ct) || ct === 'application/json' || ct === 'application/xhtml+xml') { res.resume(); throw fail(422, 'NOT_MEDIA', 'That URL returned a web page, not a media file. Use a direct link to the video file, or upload it.'); }
        const total = parseInt(res.headers['content-length'] || '', 10);
        job.total = Number.isFinite(total) ? total : null;
        const limit = settings.maxImportMB * 1048576;
        if (job.total && job.total > limit) { res.resume(); throw fail(413, 'TOO_LARGE', `File is ${(job.total / 1048576).toFixed(0)} MB; the import limit is ${settings.maxImportMB} MB.`); }
        this.media.checkDisk(job.total || 0, settings.minFreeDiskMB);

        name = path.basename(finalUrl.pathname) || 'import';
        const cd = String(res.headers['content-disposition'] || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
        if (cd) { try { name = decodeURIComponent(cd[1]); } catch { name = cd[1]; } }
        if (!ALLOWED_EXT.includes(path.extname(name).toLowerCase())) name += CT_EXT[ct] || '';

        await new Promise((resolve, reject) => {
          const out = fs.createWriteStream(tmp);
          const onAbort = () => { res.destroy(); out.destroy(); reject(fail(499, 'CANCELLED', 'Import cancelled.')); };
          job.controller.signal.addEventListener('abort', onAbort, { once: true });
          res.on('data', (chunk) => {
            job.received += chunk.length;
            if (job.received > limit) { res.destroy(fail(413, 'TOO_LARGE', `Download exceeded the ${settings.maxImportMB} MB import limit.`)); }
          });
          res.on('error', reject); out.on('error', reject);
          res.on('aborted', () => reject(fail(502, 'INTERRUPTED', 'The connection dropped before the download finished.')));
          out.on('finish', () => { if (job.total && job.received < job.total) reject(fail(502, 'INTERRUPTED', 'Download ended early.')); else resolve(); });
          res.pipe(out);
        });
      }

      job.state = 'processing';
      const m = await this.media.ingest(targetTmp, name || path.basename(url.pathname), { source: 'import', sourceUrl: job.url });
      job.mediaId = m.id; job.state = 'done';
      cleanup();
      this.log.info('import', `Import finished: ${m.name}`);
    } catch (e) {
      if (job.state === 'cancelled' || e.code === 'ABORT_ERR' || e.name === 'AbortError') return finish('cancelled', 'Cancelled.');
      if (e.status === 413) return finish('error', e.message);
      const msg = e.code === 'ENOTFOUND' ? 'The host name could not be resolved.' : e.code === 'ECONNREFUSED' ? 'The server refused the connection.' : redact(e.message);
      this.log.warn('import', `Import failed: ${msg}`);
      finish('error', msg + (e.status === 403 || e.code === 'NOT_MEDIA' ? '' : ' You can upload the file manually instead.'));
    }
  }
}

module.exports = { Importer, isPrivateAddress, isYouTubeVideoUrl };
