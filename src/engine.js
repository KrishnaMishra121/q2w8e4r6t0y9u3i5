'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { FFMPEG, DATA_DIR } = require('./config');
const ff = require('./ffmpeg');
const { fail } = require('./media');
const { readJson, writeJson, ensureDir } = require('./util');
const { redact } = require('./logger');

const PREFETCH_LEAD_MS = 1500;   // next item's decoder is warmed up this long before the current one ends
const STOP_GRACE_MS = 5000;      // time the publisher gets to finish cleanly before SIGTERM
const KILL_GRACE_MS = 3000;      // time after SIGTERM before SIGKILL
const STABLE_AFTER_MS = 60000;   // live this long -> retry counter resets
const MAX_SLATE_MS = 10000;

function terminate(proc, grace = KILL_GRACE_MS) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, grace);
    proc.once('exit', () => { clearTimeout(t); resolve(); });
    try { proc.kill('SIGTERM'); } catch { clearTimeout(t); resolve(); }
  });
}

function lines(stream, cb) {
  let buf = ''; stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (l.trim()) cb(l); }
    if (buf.length > 8192) buf = buf.slice(-1024);
  });
}

class Engine extends EventEmitter {
  constructor({ config, playlist, media, logger, binaries, encoders }) {
    super();
    Object.assign(this, { config, playlist, media, log: logger, binaries, encoders });
    this.pidFile = path.join(ensureDir(path.join(DATA_DIR, 'run')), 'pids.json');
    this.pids = new Set();
    this.state = 'idle';
    this.runId = 0;
    this._busy = false;
    this._throttle = new Map();
    this._resetRun();
  }

  _resetRun() {
    this.publisher = null; this.feeder = null; this.prefetched = null;
    this.publishers = new Map(); this.destinationStatuses = new Map(); this.destinationDesired = new Set(); this.destinationRetryCounts = new Map();
    this.destinationConfigs = []; this.multiMode = false;
    this.current = null; this.nextPick = null;
    this.played = new Set(); this.history = [];
    this.tsOffset = 0; this.retries = 0; this.consecutiveFailures = 0;
    this.liveSince = null; this.lastError = null; this.reconnect = null;
    this.stats = { frames: 0, fps: 0, bitrateKbps: 0, speed: 0, dropped: 0, outTimeSec: 0, updatedAt: null };
    this._timers = {};
  }
  _clearTimers() { for (const k of Object.keys(this._timers)) clearTimeout(this._timers[k]); this._timers = {}; }
  _setState(s) { if (this.state !== s) { this.state = s; this.log.info('engine', `State: ${s}`); this.emit('state', s); } }

  // ---------- process bookkeeping ----------
  _writePids() { try { writeJson(this.pidFile, [...this.pids]); } catch {} }
  _spawn(role, args, stdin) {
    const proc = spawn(FFMPEG, args, { stdio: [stdin, 'pipe', 'pipe'], windowsHide: true });
    if (proc.pid) { this.pids.add(proc.pid); this._writePids(); }
    proc.on('close', () => { this.pids.delete(proc.pid); this._writePids(); });
    proc.on('error', (e) => this.log.error(role, `Could not run FFmpeg: ${e.message}`));
    if (proc.stdin) proc.stdin.on('error', () => {});
    return proc;
  }
  async cleanupOrphans() {
    const old = readJson(this.pidFile, []);
    for (const pid of old) {
      if (pid === process.pid || this.pids.has(pid)) continue;
      if (await this._isFfmpeg(pid)) {
        try { process.kill(pid, 'SIGKILL'); this.log.warn('engine', `Killed orphaned FFmpeg process ${pid} from a previous run.`); } catch {}
      }
    }
    writeJson(this.pidFile, [...this.pids]);
  }
  _isFfmpeg(pid) {
    return new Promise((resolve) => {
      try { process.kill(pid, 0); } catch { return resolve(false); }
      if (process.platform === 'linux') {
        try { return resolve(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('ffmpeg')); } catch { return resolve(false); }
      }
      execFile('ps', ['-p', String(pid), '-o', 'comm='], (e, out) => resolve(!e && /ffmpeg/.test(out)));
    });
  }

  _procLog(role, line, tail) {
    tail.push(line); if (tail.length > 12) tail.shift();
    const l = line.toLowerCase();
    const level = /error|failed|refused|invalid|cannot|could not|no such|unable|denied|broken pipe|timed out|unauthorized|reset by peer/.test(l) ? 'error'
      : /warn|non-monoton|deprecated|discarding|dropping|past duration/.test(l) ? 'warn' : 'debug';
    const key = role + level + line.replace(/\d+/g, '#');
    const now = Date.now();
    if (now - (this._throttle.get(key) || 0) < 5000) return;
    this._throttle.set(key, now);
    if (this._throttle.size > 500) this._throttle.clear();
    this.log[level](role, line);
  }
  _tailMessage(tail) {
    return redact(this._tailRaw(tail));
  }
  _tailRaw(tail) {
    const errs = tail.filter((l) => /error|fail|refused|invalid|cannot|could not|no such|unable|denied|timed out|reset by peer/i.test(l));
    return (errs.length ? errs : tail).slice(-2).join(' | ');
  }

  // ---------- preflight ----------
  _testOutput() { return process.env.NODE_ENV === 'test' && process.env.PLAYOUT_TEST_OUTPUT ? process.env.PLAYOUT_TEST_OUTPUT : null; }
  preflight() {
    const problems = [];
    if (!this.binaries.ffmpeg.ok) problems.push(this.binaries.ffmpeg.error);
    if (!this.binaries.ffprobe.ok) problems.push(this.binaries.ffprobe.error);
    if (!this._testOutput()) {
      if (this.config.destinations.length) problems.push(...this.config.destinationProblems());
      else problems.push(...this.config.streamConfigProblems());
    }
    const p = this.config.effectiveProfile();
    const enc = this.encoders?.encoders?.[p.encoder];
    if (enc && !enc.available) problems.push(`Encoder ${p.encoder} is not usable on this machine (${enc.reason}). Choose libx264 in Stream Settings.`);
    if (this.encoders && !this.encoders.aac) problems.push('This FFmpeg build has no AAC encoder.');
    if (!this.playlist.items.length) problems.push('The playlist is empty. Add at least one item before going live.');
    const usable = this.playlist.items.some((i) => ['ready', 'scheduled'].includes(this.playlist.eligibility(i)));
    if (this.playlist.items.length && !usable) problems.push('No playlist item is playable right now (all are missing or past their scheduled window).');
    if (p.mode === 'copy') {
      for (const i of this.playlist.items) {
        const m = this.media.get(i.mediaId); if (!m) continue;
        const c = ff.copyCompat(m, p);
        if (!c.ok) problems.push(`Stream copy mode: "${m.name}" is not compatible (${c.reasons.join('; ')}). Use Auto or Transcode mode.`);
      }
    }
    return [...new Set(problems)];
  }

  // ---------- public controls ----------
  async start() {
    if (this._busy) throw fail(409, 'BUSY', 'Another start/stop operation is still in progress.');
    if (!['idle', 'error'].includes(this.state)) throw fail(409, 'ALREADY_RUNNING', `The broadcast is already ${this.state}.`);
    this._busy = true;
    try {
      const problems = this.preflight();
      if (problems.length) throw fail(400, 'PREFLIGHT', problems.join(' '), { problems });
      await this.cleanupOrphans();
      this._resetRun();
      this.multiMode = !this._testOutput() && this.config.destinations.length > 0;
      if (this.multiMode) {
        this.destinationConfigs = this.config.destinationsWithKeys().filter((d) => d.enabled !== false);
        this.destinationDesired = new Set(this.destinationConfigs.map((d) => d.id));
        for (const d of this.config.destinations) this.destinationStatuses.set(d.id, { id: d.id, name: d.name, platform: d.platform, state: d.enabled === false ? 'disabled' : 'stopped', retries: 0, bitrateKbps: 0, lastError: null });
      }
      const run = ++this.runId;
      this._setState('starting');
      this.log.info('engine', this.multiMode ? `Starting broadcast to ${this.destinationConfigs.length} destinations` : 'Starting broadcast');
      if (this.multiMode) this.destinationConfigs.forEach((d) => this._spawnPublisher(run, d));
      else this._spawnPublisher(run);
      this._advance(run, this.playlist.pick({ played: this.played, onPlaylistEnd: this.config.settings.onPlaylistEnd }));
    } finally { this._busy = false; }
  }

  async stop(reason = 'Stopped by operator') {
    if (this.state === 'idle') return;
    if (this._stopping) return this._stopping;
    this._stopping = (async () => {
      this._setState('stopping');
      await this._teardown();
      this.current = null; this.nextPick = null; this.liveSince = null; this.reconnect = null;
      this.stats = { ...this.stats, fps: 0, bitrateKbps: 0, speed: 0 };
      this._setState('idle');
      this.log.info('engine', reason);
    })().finally(() => { this._stopping = null; });
    return this._stopping;
  }

  async restart() { await this.stop('Restarting broadcast'); await this.start(); }

  async startDestination(id) {
    if (!this.multiMode || !['live', 'starting'].includes(this.state)) throw fail(409, 'NOT_RUNNING', 'Start the broadcast before starting an individual destination.');
    const destination = this.config.destinationWithKey(id);
    if (!destination) throw fail(404, 'NOT_FOUND', 'Destination not found.');
    if (this.publishers.has(id)) throw fail(409, 'ALREADY_RUNNING', 'This destination is already connecting or live.');
    this.destinationDesired.add(id); this.destinationRetryCounts.set(id, 0);
    clearTimeout(this._timers[`destination-${id}`]);
    this._spawnPublisher(this.runId, destination);
    return this.snapshot();
  }

  async stopDestination(id) {
    if (!this.multiMode) throw fail(409, 'NOT_RUNNING', 'Individual destination controls are available during a multi-destination broadcast.');
    if (!this.config.destinations.some((d) => d.id === id)) throw fail(404, 'NOT_FOUND', 'Destination not found.');
    this.destinationDesired.delete(id); this.destinationRetryCounts.delete(id);
    clearTimeout(this._timers[`destination-${id}`]);
    clearTimeout(this._timers[`destination-stable-${id}`]);
    const pub = this.publishers.get(id);
    if (pub) {
      pub.expected = true; this.publishers.delete(id);
      try { pub.proc.stdin.end(); } catch {}
      await terminate(pub.proc, STOP_GRACE_MS);
      this._setPublisherAlias();
    }
    const prev = this.destinationStatuses.get(id) || {};
    this.destinationStatuses.set(id, { ...prev, state: 'stopped', pid: null, bitrateKbps: 0, lastError: null });
    this._refreshMultiState();
    return this.snapshot();
  }

  skip() { return this._transition('skip'); }
  previous() { return this._transition('previous'); }
  restartItem() { return this._transition('restart'); }
  async _transition(reason) {
    if (!['live', 'starting'].includes(this.state) || !this.feeder) throw fail(409, 'NOT_PLAYING', 'Nothing is playing right now.');
    if (reason === 'previous' && !this.history.length) throw fail(409, 'NO_HISTORY', 'There is no previous item in this session.');
    const f = this.feeder;
    f.endReason = reason;
    if (this.prefetched) { const p = this.prefetched; this.prefetched = null; p.suppress = true; await terminate(p.proc, 1000); }
    this.log.info('engine', `Operator action: ${reason}`);
    await terminate(f.proc, 2000);
  }

  // ---------- publisher (one long-lived FFmpeg talking to the RTMP server) ----------
  _spawnPublisher(run, destination = null) {
    const id = destination?.id || 'legacy';
    const role = destination ? `publisher:${destination.platform}:${destination.id}` : 'publisher';
    const url = destination
      ? `${destination.rtmpUrl.replace(/\/+$/, '')}/${destination.key}`
      : this._testOutput() || this.config.fullOutputUrl();
    const proc = this._spawn(role, ff.buildPublisherArgs(url), 'pipe');
    const pub = { id, destination, proc, startedAt: Date.now(), expected: false, tail: [], retries: this.destinationRetryCounts.get(id) || 0, bitrateKbps: 0, state: 'connecting' };
    if (destination) {
      this.publishers.set(id, pub);
      const prior = this.destinationStatuses.get(id) || {};
      this.destinationStatuses.set(id, { ...prior, id, name: destination.name, platform: destination.platform, state: 'connecting', pid: proc.pid || null, retries: pub.retries, bitrateKbps: 0, lastError: null });
      this._setPublisherAlias();
      lines(proc.stderr, (l) => this._procLog(role, l, pub.tail));
      let block = {};
      lines(proc.stdout, (l) => {
        const [k, ...rest] = l.split('='); block[k] = rest.join('=');
        if (k === 'progress') { this._onDestinationProgress(run, pub, block); block = {}; }
      });
      proc.on('close', (code, signal) => this._onDestinationExit(run, pub, code, signal));
      return pub;
    }

    this.publisher = pub;
    lines(proc.stderr, (l) => this._procLog(role, l, pub.tail));
    let block = {};
    lines(proc.stdout, (l) => {
      const [k, ...rest] = l.split('='); const v = rest.join('=');
      block[k] = v;
      if (k === 'progress') { this._onProgress(run, block); block = {}; }
    });
    proc.on('close', (code, signal) => this._onPublisherExit(run, pub, code, signal));
    return pub;
  }

  _setPublisherAlias() { this.publisher = this.publishers.values().next().value || null; }

  _refreshMultiState() {
    const live = [...this.destinationStatuses.values()].some((d) => d.state === 'live');
    if (live && this.state === 'starting') {
      this.liveSince ||= Date.now(); this._setState('live');
    } else if (!live && this.state === 'live') {
      this.liveSince = null;
      this.stats = { ...this.stats, fps: 0, bitrateKbps: 0, speed: 0 };
      this._setState('starting');
    }
  }

  _onDestinationProgress(run, pub, block) {
    if (run !== this.runId || pub !== this.publishers.get(pub.id)) return;
    const bitrate = parseFloat(String(block.bitrate || '').replace('kbits/s', ''));
    if (Number.isFinite(bitrate)) pub.bitrateKbps = bitrate;
    const delivering = (parseInt(block.frame, 10) || 0) > 0 || (parseInt(block.total_size, 10) || 0) > 0 || (parseInt(block.out_time_us || block.out_time_ms, 10) || 0) > 0;
    const prior = this.destinationStatuses.get(pub.id) || {};
    this.destinationStatuses.set(pub.id, { ...prior, state: delivering ? 'live' : 'connecting', pid: pub.proc.pid || null, bitrateKbps: pub.bitrateKbps, retries: pub.retries, lastError: null, updatedAt: Date.now() });
    if (delivering && prior.state !== 'live') {
      const stableKey = `destination-stable-${pub.id}`;
      clearTimeout(this._timers[stableKey]);
      this._timers[stableKey] = setTimeout(() => {
        if (run !== this.runId || this.publishers.get(pub.id) !== pub) return;
        this.destinationRetryCounts.set(pub.id, 0); pub.retries = 0;
        const status = this.destinationStatuses.get(pub.id);
        if (status?.state === 'live') this.destinationStatuses.set(pub.id, { ...status, retries: 0 });
      }, STABLE_AFTER_MS);
    }
    const wasDestinationLive = prior.state === 'live';
    this._refreshMultiState();
    if (delivering && !wasDestinationLive) {
      this.reconnect = null;
      this.log.info('engine', `FFmpeg is sending stream data to ${pub.destination.name}.`);
    }
    const frames = parseInt(block.frame, 10) || 0;
    const kb = Number.isFinite(bitrate) ? bitrate : this.stats.bitrateKbps;
    this.stats = { ...this.stats, frames, fps: parseFloat(block.fps) || 0, bitrateKbps: kb, speed: parseFloat(String(block.speed || '').replace('x', '')) || 0, dropped: parseInt(block.drop_frames, 10) || 0, outTimeSec: (parseInt(block.out_time_us || block.out_time_ms, 10) || 0) / 1e6, updatedAt: Date.now() };
  }

  _onDestinationExit(run, pub, code, signal) {
    if (run !== this.runId || pub.expected || this.publishers.get(pub.id) !== pub) return;
    clearTimeout(this._timers[`destination-stable-${pub.id}`]);
    this.publishers.delete(pub.id); this._setPublisherAlias();
    const detail = pub.lastError || this._tailMessage(pub.tail) || `FFmpeg exited (code ${code}${signal ? ', ' + signal : ''})`;
    this.log.error(`publisher:${pub.destination.platform}:${pub.id}`, `Destination stopped: ${detail}`);
    if (!this.destinationDesired.has(pub.id)) {
      this.destinationStatuses.set(pub.id, { ...this.destinationStatuses.get(pub.id), state: 'stopped', pid: null, bitrateKbps: 0, lastError: null });
      this._refreshMultiState();
      return;
    }
    const retries = (this.destinationRetryCounts.get(pub.id) || 0) + 1;
    const settings = this.config.settings;
    if (retries <= settings.maxRetries) {
      this.destinationRetryCounts.set(pub.id, retries);
      const delay = Math.min(settings.backoffMaxSec, settings.backoffBaseSec * 2 ** (retries - 1)) * 1000;
      this.destinationStatuses.set(pub.id, { ...this.destinationStatuses.get(pub.id), state: 'reconnecting', pid: null, retries, bitrateKbps: 0, lastError: detail, retryAt: Date.now() + delay });
      this._refreshMultiState();
      this.log.warn('engine', `Retrying ${pub.destination.name} in ${delay / 1000}s (${retries}/${settings.maxRetries}).`);
      this._timers[`destination-${pub.id}`] = setTimeout(() => {
        if (run === this.runId && this.destinationDesired.has(pub.id)) this._spawnPublisher(run, pub.destination);
      }, delay);
      return;
    }
    this.destinationStatuses.set(pub.id, { ...this.destinationStatuses.get(pub.id), state: 'error', pid: null, retries: retries - 1, bitrateKbps: 0, lastError: detail });
    this._refreshMultiState();
    const pending = [...this.destinationStatuses.values()].some((d) => ['connecting', 'live', 'reconnecting'].includes(d.state));
    if (this.destinationDesired.size && !pending) this._fatal(run, `No streaming destination is receiving data after retries. Last error: ${detail}`);
  }

  _writeToPublishers(chunk) {
    for (const pub of this.publishers.values()) {
      if (pub.proc.stdin.destroyed || pub.proc.stdin.writableEnded) continue;
      if (!pub.proc.stdin.write(chunk)) {
        pub.lastError = 'This destination could not keep up with the outgoing stream.';
        pub.proc.stdin.destroy();
      }
    }
  }

  _onProgress(run, b) {
    if (run !== this.runId) return;
    const frames = parseInt(b.frame, 10) || 0;
    const kb = parseFloat(String(b.bitrate || '').replace('kbits/s', ''));
    this.stats = {
      frames, fps: parseFloat(b.fps) || 0, bitrateKbps: Number.isFinite(kb) ? kb : this.stats.bitrateKbps,
      speed: parseFloat(String(b.speed || '').replace('x', '')) || 0, dropped: parseInt(b.drop_frames, 10) || 0,
      outTimeSec: (parseInt(b.out_time_us || b.out_time_ms, 10) || 0) / 1e6, updatedAt: Date.now(),
    };
    // With -c copy the frame counter can stay at 0, so also accept written bytes or output time as proof of delivery.
    const delivering = frames > 0 || (parseInt(b.total_size, 10) || 0) > 0 || this.stats.outTimeSec > 0;
    if (this.state === 'starting' && delivering) {
      this.liveSince = Date.now(); this.reconnect = null;
      this._setState('live');
      this.log.info('engine', 'Broadcast is live: the destination is receiving video.');
      clearTimeout(this._timers.stable);
      this._timers.stable = setTimeout(() => { if (run === this.runId && this.retries) { this.retries = 0; this.log.info('engine', 'Connection stable; retry counter reset.'); } }, STABLE_AFTER_MS);
    }
  }

  _onPublisherExit(run, pub, code, signal) {
    if (run !== this.runId || pub !== this.publisher || pub.expected) return;
    this.publisher = null;
    const detail = this._tailMessage(pub.tail) || `FFmpeg exited (code ${code}${signal ? ', ' + signal : ''})`;
    this.log.error('engine', `The connection to the destination ended: ${detail}`);
    // Remember where we were so playback can resume at the same spot after reconnecting.
    const f = this.feeder; let resume = null;
    if (f && !f.slate && f.item) resume = { item: f.item, startSec: f.startSec + (Date.now() - f.playStart) / 1000 };
    for (const x of [this.feeder, this.prefetched]) if (x) { x.suppress = true; terminate(x.proc, 1000); }
    this.feeder = null; this.prefetched = null; this.liveSince = null;
    clearTimeout(this._timers.stable); clearTimeout(this._timers.prefetch);

    const s = this.config.settings;
    this.retries++;
    if (this.retries > s.maxRetries) {
      return this._fatal(run, `Could not keep the connection to the destination after ${s.maxRetries} retries. Last error: ${detail}`);
    }
    const delay = Math.min(s.backoffMaxSec, s.backoffBaseSec * 2 ** (this.retries - 1)) * 1000;
    this.reconnect = { attempt: this.retries, max: s.maxRetries, inMs: delay, at: Date.now() + delay };
    this._setState('starting');
    this.log.warn('engine', `Reconnecting in ${delay / 1000}s (attempt ${this.retries} of ${s.maxRetries})`);
    this._timers.retry = setTimeout(() => {
      if (run !== this.runId) return;
      this.tsOffset = 0;
      this._spawnPublisher(run);
      const still = resume && this.playlist.find(resume.item.itemId);
      if (still && resume.startSec < (this.media.get(still.mediaId)?.duration || 0) - 1) this._startItem(run, still, { startSec: resume.startSec });
      else this._advance(run, this.playlist.pick({ currentId: resume?.item.itemId, played: this.played, onPlaylistEnd: s.onPlaylistEnd }));
    }, delay);
  }

  // ---------- feeders (one FFmpeg per playlist item, normalised MPEG-TS on stdout) ----------
  _prepare(item, startSec, tsOffset) {
    const m = this.media.get(item.mediaId);
    if (!m || !this.media.exists(m)) return { error: 'The media file is missing on disk.' };
    const p = this.config.effectiveProfile();
    let durationSec = m.duration - startSec;
    if (item.endAt) {
      const cap = (Date.parse(item.endAt) - Date.now()) / 1000;
      if (cap <= 0.5) return { error: 'Its scheduled window has already ended.', benign: true };
      durationSec = Math.min(durationSec, cap);
    }
    if (durationSec < 0.2) return { error: 'Nothing left to play in this item.', benign: true };
    const compat = ff.copyCompat(m, p);
    let copy = false;
    if (p.mode === 'copy') { if (!compat.ok) return { error: 'Stream copy is not possible: ' + compat.reasons.join('; ') }; copy = true; }
    else if (p.mode === 'auto') copy = compat.ok;
    const args = ff.buildFeederArgs({ file: this.media.filePath(m), meta: m, profile: p, startSec, durationSec, tsOffset, copy });
    return { args, m, durationSec, copy };
  }

  _createFeeder(run, { item, meta, slate, args, durationSec, copy, startSec = 0, tsOffset }) {
    const proc = this._spawn('feeder', args, 'ignore');
    const f = { run, proc, item, meta, slate: !!slate, durationSec, copy: !!copy, startSec, tsOffset, startedAt: Date.now(), playStart: Date.now(), exited: false, code: null, tail: [], endReason: null, suppress: false };
    lines(proc.stderr, (l) => this._procLog('feeder', l, f.tail));
    proc.on('close', (code) => {
      f.exited = true; f.code = code; f.exitedAt = Date.now();
      if (f === this.feeder) this._onFeederEnd(f);
    });
    return f;
  }

  _startItem(run, item, { startSec = 0, resetPlayed = false } = {}) {
    if (run !== this.runId) return;
    const prep = this._prepare(item, startSec, this.tsOffset);
    if (prep.error) return this._failItem(run, item, prep.error, prep.benign);
    const f = this._createFeeder(run, { item, meta: prep.m, args: prep.args, durationSec: prep.durationSec, copy: prep.copy, startSec, tsOffset: this.tsOffset });
    f.resetPlayed = resetPlayed;
    this._begin(run, f);
  }

  _startSlate(run, ms) {
    const p = this.config.effectiveProfile();
    const durationSec = Math.min(ms, MAX_SLATE_MS) / 1000;
    this.log.info('engine', `Nothing is scheduled right now; sending black and silence for ${durationSec.toFixed(0)}s.`);
    const f = this._createFeeder(run, { item: null, meta: null, slate: true, args: ff.buildSlateArgs({ profile: p, durationSec, tsOffset: this.tsOffset }), durationSec, copy: false, tsOffset: this.tsOffset });
    this._begin(run, f);
  }

  _begin(run, f) { // make `f` the item on air
    if (run !== this.runId || (!this.multiMode && !this.publisher)) { f.suppress = true; terminate(f.proc, 500); return; }
    f.playStart = Date.now();
    this.feeder = f;
    if (f.resetPlayed) this.played.clear();
    if (f.item) { this.played.add(f.item.itemId); }
    const m = f.meta;
    this.current = f.slate
      ? { slate: true, name: 'Waiting for the next scheduled item', duration: f.durationSec, startedAt: f.playStart }
      : { itemId: f.item.itemId, mediaId: f.item.mediaId, name: m.name, duration: f.durationSec, startSec: f.startSec, startedAt: f.playStart, copy: f.copy, video: m.video, audio: m.audio };
    if (!f.slate) this.playlist.setError(f.item.itemId, null);
    if (this.multiMode) f.proc.stdout.on('data', (chunk) => { if (run === this.runId) this._writeToPublishers(chunk); });
    else f.proc.stdout.pipe(this.publisher.proc.stdin, { end: false });
    this.log.info('engine', f.slate ? 'Slate on air' : `On air: "${m.name}" (${f.copy ? 'stream copy' : 'transcode'})`);
    this.nextPick = this._computeNext(f);
    clearTimeout(this._timers.prefetch);
    this._timers.prefetch = setTimeout(() => this._prefetch(run, f), Math.max(0, f.durationSec * 1000 - PREFETCH_LEAD_MS));
    this.emit('item', this.current);
    if (f.exited) this._onFeederEnd(f); // it finished/failed while waiting in the wings
  }

  _computeNext(f) {
    return this.playlist.pick({ currentId: f.item?.itemId || null, played: this.played, onPlaylistEnd: this.config.settings.onPlaylistEnd });
  }
  _validNext(f) {
    const np = this.nextPick; const it = np?.item && this.playlist.find(np.item.itemId);
    return it && this.playlist.isEligible(it) ? np : this._computeNext(f);
  }

  _prefetch(run, cur) {
    if (run !== this.runId || this.feeder !== cur || cur.slate || this.prefetched || cur.endReason) return;
    const np = this._validNext(cur);
    if (!np.item) return;
    const prep = this._prepare(np.item, 0, this.tsOffset + cur.durationSec);
    if (prep.error) return; // handled (and reported) when the item actually comes up
    const f = this._createFeeder(run, { item: np.item, meta: prep.m, args: prep.args, durationSec: prep.durationSec, copy: prep.copy, tsOffset: this.tsOffset + cur.durationSec });
    f.resetPlayed = np.resetPlayed;
    this.prefetched = f;
  }

  _onFeederEnd(f) {
    if (f.run !== this.runId || f.suppress || this.state === 'stopping') return;
    clearTimeout(this._timers.prefetch);
    const run = f.run;
    const elapsed = Math.max(0, ((f.exitedAt || Date.now()) - f.playStart) / 1000);
    const reason = f.endReason;
    let advance = true;

    if (reason) this.tsOffset += elapsed;
    else if (f.code === 0) { this.tsOffset += f.durationSec; this.consecutiveFailures = 0; }
    else {
      this.tsOffset += Math.min(elapsed, f.durationSec);
      const msg = this._tailMessage(f.tail) || `FFmpeg exited with code ${f.code}`;
      if (f.item) { if (this._failItem(run, f.item, msg, false)) return; advance = false; }
    }
    if (f.item && reason !== 'previous' && reason !== 'restart' && (reason || f.code === 0)) { this.history.push(f.item.itemId); if (this.history.length > 50) this.history.shift(); }
    if (!advance) return;

    if (reason === 'previous') {
      let it = null; while (this.history.length && !it) { const c = this.playlist.find(this.history.pop()); if (c && this.playlist.isEligible(c)) it = c; }
      if (this.prefetched) { this.prefetched.suppress = true; terminate(this.prefetched.proc, 500); this.prefetched = null; }
      return it ? this._startItem(run, it) : this._advance(run, this._validNext(f));
    }
    if (reason === 'restart' && f.item) {
      if (this.prefetched) { this.prefetched.suppress = true; terminate(this.prefetched.proc, 500); this.prefetched = null; }
      return this._startItem(run, f.item);
    }
    this._advance(run, this._validNext(f));
  }

  // Returns true when the failure was fatal (engine is shutting down).
  _failItem(run, item, message, benign) {
    const name = this.media.get(item.mediaId)?.name || item.mediaId;
    if (!benign) {
      this.consecutiveFailures++;
      this.playlist.setError(item.itemId, message);
      this.log.error('engine', `"${name}" failed: ${message}`);
    } else this.log.warn('engine', `Skipping "${name}": ${message}`);
    const s = this.config.settings;
    if (!benign && (s.onItemFail === 'stop' || this.consecutiveFailures >= Math.max(3, this.playlist.items.length))) {
      this._fatal(run, s.onItemFail === 'stop' ? `Stopped because "${name}" failed: ${message}` : `Every playable item failed in a row. Last: "${name}": ${message}`);
      return true;
    }
    clearTimeout(this._timers.next);
    this._timers.next = setTimeout(() => {
      if (run !== this.runId) return;
      this._advance(run, this.playlist.pick({ currentId: item.itemId, played: this.played, onPlaylistEnd: s.onPlaylistEnd }));
    }, benign ? 0 : 500);
    return false;
  }

  _advance(run, pick) {
    if (run !== this.runId) return;
    if (!pick.item) {
      if (pick.waitMs > 0) return this._startSlate(run, pick.waitMs);
      this.log.info('engine', 'The playlist has finished.');
      return void this.stop('Playlist finished').catch(() => {});
    }
    const pf = this.prefetched;
    if (pf && pf.item?.itemId === pick.item.itemId && !pf.suppress) {
      this.prefetched = null; this._begin(run, pf);
    } else {
      if (pf) { pf.suppress = true; terminate(pf.proc, 500); this.prefetched = null; }
      this._startItem(run, pick.item, { resetPlayed: pick.resetPlayed });
    }
  }

  async _fatal(run, message) {
    if (run !== this.runId) return;
    message = redact(message);
    this.lastError = message;
    this.log.error('engine', message);
    this._setState('stopping');
    await this._teardown({ preserveDestinationStatus: true });
    this.current = null; this.nextPick = null; this.liveSince = null; this.reconnect = null;
    this._setState('error');
  }

  async _teardown({ preserveDestinationStatus = false } = {}) {
    this.runId++; // invalidates every pending callback from the previous run
    this._clearTimers();
    const feeders = [this.feeder, this.prefetched].filter(Boolean);
    feeders.forEach((f) => { f.suppress = true; });
    await Promise.all(feeders.map((f) => terminate(f.proc, 2000)));
    this.feeder = null; this.prefetched = null;
    if (this.multiMode) {
      const pubs = [...this.publishers.values()];
      this.publishers.clear(); this.publisher = null;
      await Promise.all(pubs.map(async (pub) => {
        pub.expected = true;
        try { pub.proc.stdin.end(); } catch {}
        await terminate(pub.proc, STOP_GRACE_MS);
      }));
      for (const [id, status] of this.destinationStatuses) {
        if (!preserveDestinationStatus || status.state !== 'error') this.destinationStatuses.set(id, { ...status, state: 'stopped', pid: null, bitrateKbps: 0 });
        else this.destinationStatuses.set(id, { ...status, pid: null, bitrateKbps: 0 });
      }
    } else {
      const pub = this.publisher;
      if (pub) {
        pub.expected = true; this.publisher = null;
        try { pub.proc.stdin.end(); } catch {}
        const exited = new Promise((r) => pub.proc.once('exit', r));
        const clean = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), STOP_GRACE_MS))]);
        if (!clean) { this.log.warn('engine', 'Publisher did not exit on its own; terminating it.'); await terminate(pub.proc, KILL_GRACE_MS); }
      }
    }
  }

  // Synchronous last-resort cleanup used when the Node process itself is exiting.
  killAllNow() { for (const pid of this.pids) { try { process.kill(pid, 'SIGKILL'); } catch {} } }

  snapshot() {
    const now = Date.now();
    const p = this.config.effectiveProfile();
    const enc = this.encoders?.encoders?.[p.encoder];
    const c = this.current;
    const inputRes = c?.video ? { width: c.video.width, height: c.video.height, fps: c.video.fps, codec: c.video.codec } : null;
    const np = this.nextPick?.item ? this.playlist.find(this.nextPick.item.itemId) : null;
    const nm = np ? this.media.get(np.mediaId) : null;
    return {
      state: this.state, lastError: this.lastError, reconnect: this.reconnect ? { ...this.reconnect, inMs: Math.max(0, this.reconnect.at - now) } : null,
      uptimeSec: this.liveSince ? (now - this.liveSince) / 1000 : 0,
      publisher: { running: !!this.publisher, pid: this.publisher?.proc.pid || null, uptimeSec: this.publisher ? (now - this.publisher.startedAt) / 1000 : 0 },
      destinations: this.config.publicDestinations().map((d) => ({ ...d, ...(this.destinationStatuses.get(d.id) || { state: d.enabled === false ? 'disabled' : 'stopped', pid: null, retries: 0, bitrateKbps: 0, lastError: null }) })),
      feeder: { running: !!this.feeder && !this.feeder.exited, pid: this.feeder?.proc.pid || null },
      processCount: this.pids.size,
      current: c ? { ...c, elapsedSec: Math.min(c.duration, (now - c.startedAt) / 1000), video: undefined, audio: undefined } : null,
      next: nm ? { itemId: np.itemId, name: nm.name } : (this.nextPick?.waitMs ? { name: 'Scheduled item (waiting)', waitMs: this.nextPick.waitMs } : null),
      stats: this.stats,
      input: inputRes,
      output: {
        requested: p,
        videoEncoder: c ? (c.copy ? 'copy (no re-encode)' : p.encoder) : p.encoder,
        audioEncoder: c?.copy ? 'copy (no re-encode)' : 'aac',
        hardwareAccel: !!(enc && enc.available && enc.hardware && !c?.copy),
        activeMode: c ? (c.copy ? 'stream copy' : 'transcode') : null,
        upscaling: !!(inputRes && (inputRes.height < p.height * 0.9)),
      },
      retries: this.retries,
    };
  }
}

module.exports = { Engine, terminate };
