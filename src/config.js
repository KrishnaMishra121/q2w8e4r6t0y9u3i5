'use strict';
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, ensureDir, clamp, uid } = require('./util');
const { registerSecret, unregisterSecret } = require('./logger');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(ROOT, 'media'));

const PROFILES = {
  '720p30':  { label: '720p / 30 fps',  width: 1280, height: 720,  fps: 30, videoKbps: 3500, audioKbps: 128 },
  '1080p30': { label: '1080p / 30 fps', width: 1920, height: 1080, fps: 30, videoKbps: 6000, audioKbps: 160 },
  '1080p60': { label: '1080p / 60 fps', width: 1920, height: 1080, fps: 60, videoKbps: 9000, audioKbps: 160 },
};

const LIMITS = {
  width: [320, 3840], height: [240, 2160], fps: [10, 60],
  videoKbps: [500, 51000], audioKbps: [64, 320], gopSeconds: [1, 4],
};
const DESTINATION_PLATFORMS = ['youtube', 'facebook', 'instagram'];
const MAX_DESTINATIONS = 20;

const DEFAULT_STREAM = {
  rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2',
  profile: '1080p30',
  custom: { width: 1920, height: 1080, fps: 30, videoKbps: 6000, audioKbps: 160 },
  gopSeconds: 2,
  aspect: 'fit',            // fit (letterbox) | fill (crop) | stretch
  pixFmt: 'yuv420p',
  sampleRate: 48000,
  mode: 'transcode',        // transcode | copy | auto
  encoder: 'libx264',       // libx264 | h264_nvenc | h264_qsv | h264_videotoolbox
  x264Preset: 'veryfast',
};

const DEFAULT_SETTINGS = {
  maxUploadMB: 4096,
  maxImportMB: 4096,
  minFreeDiskMB: 1024,
  maxRetries: 5,
  backoffBaseSec: 2,
  backoffMaxSec: 30,
  onItemFail: 'skip',       // skip | stop
  onPlaylistEnd: 'stop',    // stop | restart (restart only matters when repeat is off)
  logRetention: 3000,
  statusIntervalMs: 2000,
  theme: 'dark',
};

const ENV_SETTING_OVERRIDES = {
  maxUploadMB: 'MAX_UPLOAD_MB',
  maxImportMB: 'MAX_IMPORT_MB',
  minFreeDiskMB: 'MIN_FREE_DISK_MB',
};

const readEnvSettings = () => Object.fromEntries(Object.entries(ENV_SETTING_OVERRIDES).flatMap(([key, envName]) => {
  const v = process.env[envName];
  if (v === undefined || v === '') return [];
  const n = Number(v);
  return Number.isFinite(n) ? [[key, n]] : [];
}));

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT || '3000', 10);
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

class ConfigStore {
  constructor() {
    ensureDir(DATA_DIR); ensureDir(MEDIA_DIR);
    this.streamFile = path.join(DATA_DIR, 'stream.json');
    this.settingsFile = path.join(DATA_DIR, 'settings.json');
    this.secretFile = path.join(DATA_DIR, 'secrets.json');
    this.destinationsFile = path.join(DATA_DIR, 'destinations.json');
    this.stream = { ...DEFAULT_STREAM, ...readJson(this.streamFile, {}) };
    this.stream.custom = { ...DEFAULT_STREAM.custom, ...(this.stream.custom || {}) };
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(this.settingsFile, {}), ...readEnvSettings() };
    this.destinations = readJson(this.destinationsFile, []).filter((d) => d && typeof d.id === 'string' && typeof d.name === 'string' && DESTINATION_PLATFORMS.includes(d.platform) && typeof d.rtmpUrl === 'string');
    // Restore a valid configuration: if the persisted file fails validation, fall back to defaults.
    if (this.validateStream(this.stream).errors.length) {
      this.stream = { ...DEFAULT_STREAM, custom: { ...DEFAULT_STREAM.custom } };
    }
    this.secrets = readJson(this.secretFile, {});
    if (this.streamKey) registerSecret(this.streamKey);
    for (const key of Object.values(this.secrets.destinations || {})) if (key) registerSecret(key);
  }

  // Env var wins over the file so deployments can inject the key without ever writing it to disk.
  get streamKey() { return process.env.STREAM_KEY || this.secrets.streamKey || ''; }
  get keySource() { return process.env.STREAM_KEY ? 'env' : (this.secrets.streamKey ? 'file' : 'none'); }

  setStreamKey(key) {
    const old = this.secrets.streamKey;
    if (!key) delete this.secrets.streamKey; else this.secrets.streamKey = key;
    if (old) this._unregisterSecretIfUnused(old);
    writeJson(this.secretFile, this.secrets, 0o600);
    try { fs.chmodSync(this.secretFile, 0o600); } catch {}
    if (key) registerSecret(key);
  }

  _saveSecrets() {
    writeJson(this.secretFile, this.secrets, 0o600);
    try { fs.chmodSync(this.secretFile, 0o600); } catch {}
  }

  _unregisterSecretIfUnused(key) {
    if (this.streamKey === key || Object.values(this.secrets.destinations || {}).includes(key)) return;
    unregisterSecret(key);
  }

  _saveDestinations() { writeJson(this.destinationsFile, this.destinations); }

  _validateDestination(input, existing = null) {
    const name = String(input.name ?? existing?.name ?? '').trim();
    const platform = String(input.platform ?? existing?.platform ?? '').trim().toLowerCase();
    const rtmpUrl = String(input.rtmpUrl ?? existing?.rtmpUrl ?? '').trim();
    const key = input.key === undefined ? (this.secrets.destinations?.[existing?.id] || '') : String(input.key).trim();
    const errors = [];
    if (!name || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) errors.push('Name must be 1–60 characters and contain no control characters.');
    if (!DESTINATION_PLATFORMS.includes(platform)) errors.push('Platform must be YouTube, Facebook, or Instagram.');
    try {
      const u = new URL(rtmpUrl);
      if (!['rtmp:', 'rtmps:'].includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash || /[\s\u0000-\u001f]/.test(rtmpUrl)) errors.push('Enter a valid RTMP(S) server URL without a stream key or query parameters.');
      if (platform !== 'youtube' && u.protocol !== 'rtmps:') errors.push('Facebook Live and Instagram Live require an RTMPS ingest URL.');
    } catch { errors.push('Enter a valid RTMP(S) server URL.'); }
    if (!/^[\x21-\x7e]{8,512}$/.test(key) || /[\\/?#]/.test(key)) errors.push('Stream key must contain 8–512 visible characters, no spaces, and no URL separators (/, ?, #).');
    if (errors.length) { const e = new Error(errors.join(' ')); e.status = 400; e.code = 'BAD_DESTINATION'; e.problems = errors; throw e; }
    return { name, platform, rtmpUrl };
  }

  addDestination(input) {
    if (this.destinations.length >= MAX_DESTINATIONS) { const e = new Error(`At most ${MAX_DESTINATIONS} destinations can be configured.`); e.status = 400; throw e; }
    const value = this._validateDestination(input);
    const destination = { id: uid(8), ...value, enabled: true, createdAt: new Date().toISOString() };
    this.destinations.push(destination);
    this.secrets.destinations ||= {};
    this.secrets.destinations[destination.id] = String(input.key).trim();
    registerSecret(this.secrets.destinations[destination.id]);
    this._saveDestinations(); this._saveSecrets();
    return this.publicDestination(destination);
  }

  updateDestination(id, patch) {
    const current = this.destinations.find((d) => d.id === id);
    if (!current) { const e = new Error('Destination not found.'); e.status = 404; throw e; }
    const value = this._validateDestination(patch, current);
    Object.assign(current, value);
    if (patch.key !== undefined) {
      this.secrets.destinations ||= {};
      const oldKey = this.secrets.destinations[id];
      this.secrets.destinations[id] = String(patch.key).trim();
      if (oldKey) this._unregisterSecretIfUnused(oldKey);
      registerSecret(this.secrets.destinations[id]);
      this._saveSecrets();
    }
    this._saveDestinations();
    return this.publicDestination(current);
  }

  removeDestination(id) {
    const index = this.destinations.findIndex((d) => d.id === id);
    if (index < 0) { const e = new Error('Destination not found.'); e.status = 404; throw e; }
    this.destinations.splice(index, 1);
    const oldKey = this.secrets.destinations?.[id];
    if (this.secrets.destinations) delete this.secrets.destinations[id];
    if (oldKey) this._unregisterSecretIfUnused(oldKey);
    this._saveDestinations(); this._saveSecrets();
  }

  destinationWithKey(id) {
    const d = this.destinations.find((x) => x.id === id);
    if (!d) return null;
    return { ...d, key: this.secrets.destinations?.[id] || '' };
  }

  destinationsWithKeys() { return this.destinations.map((d) => this.destinationWithKey(d.id)); }

  publicDestination(destination) {
    const key = this.secrets.destinations?.[destination.id] || '';
    return { ...destination, streamKeySet: !!key, streamKeyMasked: key ? (key.length <= 8 ? '••••' : '••••••••' + key.slice(-4)) : '' };
  }

  publicDestinations() { return this.destinations.map((d) => this.publicDestination(d)); }

  destinationProblems() {
    const errors = [];
    if (!this.destinations.length) return ['Add at least one streaming destination.'];
    const enabled = this.destinations.filter((d) => d.enabled !== false);
    if (!enabled.length) return ['Enable at least one streaming destination.'];
    for (const d of enabled) if (!this.secrets.destinations?.[d.id]) errors.push(`${d.name} has no stream key.`);
    return errors;
  }

  maskedKey() {
    const k = this.streamKey;
    if (!k) return '';
    return k.length <= 8 ? '••••' : '••••••••' + k.slice(-4);
  }

  validateStream(s) {
    const errors = [];
    const url = String(s.rtmpUrl || '').trim();
    if (!/^rtmps?:\/\/[^\s/]+(:\d+)?(\/[^\s?#]*)?$/i.test(url)) errors.push('Destination must be an rtmp:// or rtmps:// URL (without the stream key).');
    if (!['720p30', '1080p30', '1080p60', 'custom'].includes(s.profile)) errors.push('Unknown output profile.');
    if (!['fit', 'fill', 'stretch'].includes(s.aspect)) errors.push('Aspect handling must be fit, fill or stretch.');
    if (!['transcode', 'copy', 'auto'].includes(s.mode)) errors.push('Mode must be transcode, copy or auto.');
    if (!['libx264', 'h264_nvenc', 'h264_qsv', 'h264_videotoolbox'].includes(s.encoder)) errors.push('Unsupported encoder.');
    if (!['yuv420p', 'yuv422p', 'nv12'].includes(s.pixFmt)) errors.push('Pixel format must be yuv420p, yuv422p or nv12.');
    if (![44100, 48000].includes(Number(s.sampleRate))) errors.push('Audio sample rate must be 44100 or 48000.');
    if (!['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].includes(s.x264Preset)) errors.push('Invalid x264 preset.');
    const g = Number(s.gopSeconds);
    if (!(g >= LIMITS.gopSeconds[0] && g <= LIMITS.gopSeconds[1])) errors.push(`Keyframe interval must be ${LIMITS.gopSeconds.join('–')} seconds.`);
    if (s.profile === 'custom') {
      const c = s.custom || {};
      for (const k of ['width', 'height', 'fps', 'videoKbps', 'audioKbps']) {
        const v = Number(c[k]); const [lo, hi] = LIMITS[k];
        if (!Number.isFinite(v) || v < lo || v > hi) errors.push(`Custom ${k} must be between ${lo} and ${hi}.`);
      }
      if (Number(c.width) % 2 || Number(c.height) % 2) errors.push('Custom width and height must be even numbers (H.264 requirement).');
    }
    return { errors };
  }

  updateStream(patch) {
    const next = { ...this.stream, ...patch, custom: { ...this.stream.custom, ...(patch.custom || {}) } };
    next.rtmpUrl = String(next.rtmpUrl || '').trim().replace(/\/+$/, '');
    for (const k of ['gopSeconds', 'sampleRate']) next[k] = Number(next[k]);
    for (const k of Object.keys(next.custom)) next.custom[k] = Number(next.custom[k]);
    const { errors } = this.validateStream(next);
    if (errors.length) { const e = new Error(errors.join(' ')); e.status = 400; throw e; }
    this.stream = next;
    writeJson(this.streamFile, next);
    return next;
  }

  updateSettings(patch) {
    const next = { ...this.settings };
    const num = (k, lo, hi) => { if (patch[k] !== undefined) next[k] = clamp(Number(patch[k]), lo, hi); };
    num('maxUploadMB', 1, 51200); num('maxImportMB', 1, 51200); num('minFreeDiskMB', 0, 1048576);
    num('maxRetries', 0, 50); num('backoffBaseSec', 1, 60); num('backoffMaxSec', 1, 600);
    num('logRetention', 200, 20000); num('statusIntervalMs', 1000, 10000);
    if (patch.onItemFail !== undefined) {
      if (!['skip', 'stop'].includes(patch.onItemFail)) { const e = new Error('onItemFail must be skip or stop.'); e.status = 400; throw e; }
      next.onItemFail = patch.onItemFail;
    }
    if (patch.onPlaylistEnd !== undefined) {
      if (!['stop', 'restart'].includes(patch.onPlaylistEnd)) { const e = new Error('onPlaylistEnd must be stop or restart.'); e.status = 400; throw e; }
      next.onPlaylistEnd = patch.onPlaylistEnd;
    }
    if (patch.theme !== undefined) {
      if (!['dark', 'light', 'skyblue'].includes(String(patch.theme))) { const e = new Error('Theme must be dark, light, or skyblue.'); e.status = 400; throw e; }
      next.theme = String(patch.theme);
    }
    for (const k of Object.keys(next)) if (typeof next[k] === 'number' && Number.isNaN(next[k])) { const e = new Error(`Invalid value for ${k}.`); e.status = 400; throw e; }
    this.settings = next;
    writeJson(this.settingsFile, next);
    return next;
  }

  // Effective output profile: the *requested* settings. Actual encoder state is reported separately by the engine.
  effectiveProfile() {
    const s = this.stream;
    const base = s.profile === 'custom' ? s.custom : PROFILES[s.profile];
    return { width: base.width, height: base.height, fps: base.fps, videoKbps: base.videoKbps, audioKbps: base.audioKbps,
      gopSeconds: s.gopSeconds, aspect: s.aspect, pixFmt: s.pixFmt, sampleRate: s.sampleRate,
      mode: s.mode, encoder: s.encoder, x264Preset: s.x264Preset };
  }

  publicStream() {
    return { ...this.stream, streamKeySet: !!this.streamKey, streamKeyMasked: this.maskedKey(), keySource: this.keySource };
  }

  streamConfigProblems() {
    const p = [];
    const { errors } = this.validateStream(this.stream);
    p.push(...errors);
    if (!this.streamKey) p.push('No stream key is configured. Set one in Stream Settings or via the STREAM_KEY environment variable.');
    else if (/\s/.test(this.streamKey) || this.streamKey.length < 8) p.push('The stream key looks malformed (too short or contains whitespace).');
    return p;
  }

  fullOutputUrl() { return `${this.stream.rtmpUrl}/${this.streamKey}`; }
}

module.exports = { ConfigStore, PROFILES, LIMITS, DESTINATION_PLATFORMS, MAX_DESTINATIONS, DEFAULT_STREAM, DEFAULT_SETTINGS, ROOT, DATA_DIR, MEDIA_DIR, HOST, PORT, FFMPEG, FFPROBE };
