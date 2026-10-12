'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const cfgMod = require('./config');
const { ConfigStore, PROFILES, LIMITS, DESTINATION_PLATFORMS, ROOT } = cfgMod;
const { Logger, redact } = require('./logger');
const ff = require('./ffmpeg');
const { MediaLibrary, ALLOWED_EXT, fail } = require('./media');
const { Importer } = require('./importer');
const { Playlist } = require('./playlist');
const { Engine } = require('./engine');
const { Metrics } = require('./metrics');
const { Auth, loadCredentials } = require('./auth');
const { uid, ensureDir } = require('./util');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function createContext() {
  const config = new ConfigStore();
  const log = new Logger({ dir: path.join(cfgMod.DATA_DIR, 'logs'), max: config.settings.logRetention });
  const binaries = await ff.detectBinaries();
  if (!binaries.ffmpeg.ok) log.error('system', binaries.ffmpeg.error);
  if (!binaries.ffprobe.ok) log.error('system', binaries.ffprobe.error);
  const encoders = binaries.ffmpeg.ok ? await ff.detectEncoders() : { aac: false, encoders: {} };
  const media = new MediaLibrary(log);
  const playlist = new Playlist({ media, config, logger: log });
  const engine = new Engine({ config, playlist, media, logger: log, binaries, encoders });
  const importer = new Importer({ media, config, logger: log });
  const metrics = new Metrics();
  const credentials = loadCredentials();
  const auth = new Auth(credentials.username, credentials.password);
  const ctx = { config, log, binaries, encoders, media, playlist, engine, importer, metrics, auth, credentials, startedAt: Date.now(), sse: new Set() };
  ctx.buildStatus = () => buildStatus(ctx);
  return ctx;
}

function configProblems(ctx) {
  const p = [];
  if (!ctx.binaries.ffmpeg.ok) p.push(ctx.binaries.ffmpeg.error);
  if (!ctx.binaries.ffprobe.ok) p.push(ctx.binaries.ffprobe.error);
  p.push(...(ctx.config.destinations.length ? ctx.config.destinationProblems() : ctx.config.streamConfigProblems()));
  return p;
}

function buildStatus(ctx) {
  const { config, playlist, media, engine, metrics, log } = ctx;
  const prof = config.effectiveProfile();
  const pv = playlist.view();
  const problems = configProblems(ctx);
  const m = metrics.snapshot();
  return {
    time: Date.now(),
    server: { uptimeSec: (Date.now() - ctx.startedAt) / 1000, node: process.version, host: cfgMod.HOST, port: cfgMod.PORT },
    engine: engine.snapshot(),
    playlist: { count: pv.count, totalDuration: pv.totalDuration, repeat: pv.repeat, shuffle: pv.shuffle, ready: pv.items.filter((i) => i.status === 'ready').length },
    media: { count: media.items.length, totalSize: media.items.reduce((a, x) => a + (x.size || 0), 0) },
    stream: { rtmpUrl: config.stream.rtmpUrl, profile: config.stream.profile, label: config.stream.profile === 'custom' ? `${prof.width}x${prof.height} / ${prof.fps} fps (custom)` : PROFILES[config.stream.profile].label, requested: prof, streamKeySet: !!config.streamKey },
    health: { ffmpeg: ctx.binaries.ffmpeg, ffprobe: ctx.binaries.ffprobe, configOk: problems.length === 0, problems },
    metrics: m,
    events: log.recent(['info', 'warn', 'error'], 12).filter((e) => e.source !== 'publisher' || e.level !== 'info').slice(0, 10),
    counts: { errors: log.entries.filter((e) => e.level === 'error').length, warnings: log.entries.filter((e) => e.level === 'warn').length },
  };
}

function createApp(ctx) {
  const { config, log, media, playlist, engine, importer, auth } = ctx;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: https://i.ytimg.com https://img.youtube.com; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', cacheControl: false, etag: true }));

  const api = express.Router();
  app.use('/api', api);
  api.post('/login', (req, res) => auth.login(req, res));
  api.post('/logout', (req, res) => auth.logout(req, res));
  api.get('/session', (req, res) => res.json({ authed: auth.isAuthed(req) }));
  api.use(auth.middleware());

  // ---- status + live events ----
  api.get('/status', (req, res) => res.json(ctx.buildStatus()));
  api.get('/events', (req, res) => {
    if (ctx.sse.size >= 20) return res.status(503).json({ error: 'Too many open dashboards.' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const client = { res };
    ctx.sse.add(client);
    res.write(`event: status\ndata: ${JSON.stringify(ctx.buildStatus())}\n\n`);
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); ctx.sse.delete(client); });
  });

  // ---- engine ----
  const engineRoute = (name) => wrap(async (req, res) => { await engine[name](); res.json(engine.snapshot()); });
  api.post('/engine/start', engineRoute('start'));
  api.post('/engine/stop', engineRoute('stop'));
  api.post('/engine/restart', engineRoute('restart'));
  api.post('/engine/skip', engineRoute('skip'));
  api.post('/engine/previous', engineRoute('previous'));
  api.post('/engine/restart-item', engineRoute('restartItem'));
  api.get('/engine/preflight', (req, res) => { const problems = engine.preflight(); res.json({ ok: !problems.length, problems }); });

  // ---- media ----
  api.get('/media', (req, res) => res.json({ items: media.list(), allowedExt: ALLOWED_EXT, maxUploadMB: config.settings.maxUploadMB, freeBytes: media.freeBytes() }));
  api.get('/media/:id/thumb', (req, res) => {
    const m = media.get(req.params.id);
    if (!m || !m.thumb || !fs.existsSync(media.thumbPath(m))) return res.status(404).end();
    res.setHeader('Cache-Control', 'private, max-age=3600'); res.type('jpg').sendFile(media.thumbPath(m));
  });
  const precheck = (req, res, next) => {
    const limit = config.settings.maxUploadMB * 1048576;
    const cl = parseInt(req.headers['content-length'] || '0', 10);
    if (cl > limit + 1048576) return next(fail(413, 'TOO_LARGE', `That file is larger than the ${config.settings.maxUploadMB} MB upload limit.`));
    try { media.checkDisk(cl, config.settings.minFreeDiskMB); } catch (e) { return next(e); }
    next();
  };
  api.post('/media/upload', precheck, (req, res, next) => {
    const up = multer({
      storage: multer.diskStorage({ destination: (r, f, cb) => cb(null, path.dirname(media.tmpPath())), filename: (r, f, cb) => cb(null, uid(8) + '.part') }),
      limits: { fileSize: config.settings.maxUploadMB * 1048576, files: 1 },
      // Type checks happen in media.ingest(): rejecting mid-stream would reset the connection and hide the real error from the browser.
    }).single('file');
    up(req, res, (err) => {
      if (err && err.code === 'LIMIT_FILE_SIZE') return next(fail(413, 'TOO_LARGE', `That file is larger than the ${config.settings.maxUploadMB} MB upload limit.`));
      if (err) return next(err);
      if (req.badExt !== undefined) return next(fail(415, 'UNSUPPORTED_TYPE', `"${req.badExt || 'no extension'}" files are not supported. Allowed: ${ALLOWED_EXT.join(', ')}.`));
      if (!req.file) return next(fail(400, 'NO_FILE', 'No file was received.'));
      next();
    });
  }, wrap(async (req, res) => {
    const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const m = await media.ingest(req.file.path, name, { source: 'upload' });
    res.status(201).json(m);
  }));
  api.delete('/media/:id', wrap(async (req, res) => {
    const m = media.get(req.params.id);
    if (!m) throw fail(404, 'NOT_FOUND', 'Media item not found.');
    if (['live', 'starting'].includes(engine.state) && engine.current?.mediaId === m.id) throw fail(409, 'IN_USE', 'This item is on air right now. Skip it or stop the broadcast first.');
    const refs = playlist.items.filter((i) => i.mediaId === m.id).length;
    playlist.removeMedia(m.id); media.remove(m.id);
    res.json({ ok: true, removedFromPlaylist: refs });
  }));
  api.get('/imports', (req, res) => res.json({ jobs: importer.list() }));
  api.post('/imports', wrap(async (req, res) => res.status(202).json(await importer.start(req.body?.url))));
  api.delete('/imports/:id', wrap(async (req, res) => { importer.cancel(req.params.id); res.json({ ok: true }); }));

  // ---- playlist ----
  api.get('/playlist', (req, res) => res.json({ ...playlist.view(), presets: playlist.listPresets(), current: engine.snapshot().current?.itemId || null }));
  api.post('/playlist/items', wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.mediaIds) ? req.body.mediaIds : [req.body?.mediaId];
    const added = ids.filter(Boolean).map((id) => playlist.add(id, req.body));
    res.status(201).json({ added: added.length });
  }));
  api.patch('/playlist/items/:id', wrap(async (req, res) => res.json(playlist.update(req.params.id, req.body || {}))));
  api.delete('/playlist/items/:id', wrap(async (req, res) => { playlist.remove(req.params.id); res.json({ ok: true }); }));
  api.put('/playlist/order', wrap(async (req, res) => { playlist.reorder(req.body?.ids); res.json({ ok: true }); }));
  api.put('/playlist/modes', wrap(async (req, res) => { playlist.setModes(req.body || {}); res.json({ repeat: playlist.repeat, shuffle: playlist.shuffle }); }));
  api.post('/playlist/clear', wrap(async (req, res) => { playlist.clear(); res.json({ ok: true }); }));
  api.post('/playlist/validate', (req, res) => res.json(playlist.validate(config.effectiveProfile())));
  api.get('/presets', (req, res) => res.json({ presets: playlist.listPresets() }));
  api.post('/presets', wrap(async (req, res) => res.status(201).json({ presets: playlist.savePreset(req.body?.name) })));
  api.post('/presets/:id/load', wrap(async (req, res) => res.json(playlist.loadPreset(req.params.id))));
  api.delete('/presets/:id', wrap(async (req, res) => { playlist.deletePreset(req.params.id); res.json({ ok: true }); }));

  // ---- stream settings (all locked while a broadcast is running) ----
  const requireIdle = () => { if (!['idle', 'error'].includes(engine.state)) throw fail(409, 'LIVE', 'Stop the broadcast before changing stream settings.'); };
  api.get('/destinations', (req, res) => res.json({ destinations: engine.snapshot().destinations, platforms: DESTINATION_PLATFORMS, maxDestinations: cfgMod.MAX_DESTINATIONS, broadcastState: engine.state }));
  api.post('/destinations', wrap(async (req, res) => { requireIdle(); res.status(201).json({ destination: config.addDestination(req.body || {}) }); }));
  api.put('/destinations/:id', wrap(async (req, res) => { requireIdle(); res.json({ destination: config.updateDestination(req.params.id, req.body || {}) }); }));
  api.delete('/destinations/:id', wrap(async (req, res) => { requireIdle(); config.removeDestination(req.params.id); res.json({ ok: true }); }));
  api.post('/destinations/:id/start', wrap(async (req, res) => res.json(await engine.startDestination(req.params.id))));
  api.post('/destinations/:id/stop', wrap(async (req, res) => res.json(await engine.stopDestination(req.params.id))));
  api.get('/stream', (req, res) => res.json({ stream: config.publicStream(), profiles: PROFILES, limits: LIMITS, encoders: ctx.encoders, problems: configProblems(ctx) }));
  api.put('/stream', wrap(async (req, res) => {
    requireIdle();
    const allowed = ['rtmpUrl', 'profile', 'custom', 'gopSeconds', 'aspect', 'pixFmt', 'sampleRate', 'mode', 'encoder', 'x264Preset'];
    const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    config.updateStream(patch);
    log.info('settings', 'Stream settings saved.');
    res.json({ stream: config.publicStream(), problems: configProblems(ctx) });
  }));
  api.put('/stream/key', wrap(async (req, res) => {
    requireIdle();
    if (process.env.STREAM_KEY) throw fail(409, 'ENV_MANAGED', 'The stream key is provided by the STREAM_KEY environment variable. Change it there.');
    const key = String(req.body?.key || '').trim();
    if (!/^[\x21-\x7e]{8,300}$/.test(key)) throw fail(400, 'BAD_KEY', 'A stream key is 8–300 visible characters with no spaces.');
    config.setStreamKey(key);
    log.info('settings', 'Stream key updated.');
    res.json({ stream: config.publicStream() });
  }));
  api.delete('/stream/key', wrap(async (req, res) => {
    requireIdle();
    if (process.env.STREAM_KEY) throw fail(409, 'ENV_MANAGED', 'The stream key is provided by the STREAM_KEY environment variable.');
    config.setStreamKey(''); log.info('settings', 'Stream key removed.');
    res.json({ stream: config.publicStream() });
  }));
  api.get('/settings', (req, res) => res.json({ settings: config.settings, auth: { credentialSource: ctx.credentials.source }, server: { host: cfgMod.HOST, port: cfgMod.PORT } }));
  api.put('/settings', wrap(async (req, res) => { const s = config.updateSettings(req.body || {}); log.max = s.logRetention; res.json({ settings: s }); }));

  // ---- logs ----
  api.get('/logs', (req, res) => res.json({ entries: log.query({ level: req.query.level, q: req.query.q, limit: parseInt(req.query.limit, 10) || 300 }) }));
  api.get('/logs/download', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="playout-log.txt"'); res.type('text/plain');
    res.send(log.entries.map((e) => `${e.ts} ${e.level.toUpperCase().padEnd(5)} [${e.source}] ${e.message}`).join('\n') + '\n');
  });

  // ---- diagnostics ----
  const diagnostics = () => {
    const p = config.effectiveProfile();
    return {
      generatedAt: new Date().toISOString(),
      binaries: ctx.binaries, encoders: ctx.encoders,
      hardwareNote: Object.values(ctx.encoders.encoders || {}).some((e) => e.hardware && e.available)
        ? 'A hardware H.264 encoder passed a real test encode and can be selected.'
        : 'No hardware H.264 encoder passed a test encode. Only software encoding (libx264) is available; GPU acceleration is NOT active.',
      configProblems: configProblems(ctx),
      streamSettings: { ...config.publicStream(), streamKeyMasked: config.streamKey ? '[set]' : '' },
      effectiveProfile: p, settings: config.settings,
      playlist: playlist.validate(p),
      system: { platform: `${os.type()} ${os.release()}`, arch: os.arch(), cpuModel: os.cpus()[0]?.model, cpuCount: os.cpus().length, memTotalMB: Math.round(os.totalmem() / 1048576), node: process.version, codespaces: !!process.env.CODESPACES },
      disk: ctx.metrics.disk(),
      requirements: [
        { profile: '720p / 30 fps', cpu: 'about 2 modern cores with x264 veryfast', upload: '≥ 5 Mbps sustained', ram: '≈ 1 GB free', note: 'Reasonable on most machines.' },
        { profile: '1080p / 30 fps', cpu: 'about 4 modern cores with x264 veryfast, or a hardware encoder', upload: '≥ 9 Mbps sustained', ram: '≈ 1.5 GB free', note: 'Run the encode benchmark to check your machine.' },
        { profile: '1080p / 60 fps', cpu: '6+ fast cores, or a hardware encoder', upload: '≥ 14 Mbps sustained', ram: '≈ 2 GB free', note: 'Only worthwhile with 60 fps sources; a 30 fps source is simply duplicated.' },
      ],
      recentLog: log.entries.slice(-200).map((e) => `${e.ts} ${e.level} [${e.source}] ${e.message}`),
    };
  };
  api.get('/diagnostics', (req, res) => res.json(diagnostics()));
  api.get('/diagnostics/export', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="playout-diagnostics.json"'); res.type('application/json');
    res.send(redact(JSON.stringify(diagnostics(), null, 2)));
  });
  api.post('/diagnostics/benchmark', wrap(async (req, res) => {
    if (['live', 'starting'].includes(engine.state)) throw fail(409, 'LIVE', 'Run the benchmark while the broadcast is stopped; it would compete with the live encode.');
    if (ctx.benching) throw fail(409, 'BUSY', 'A benchmark is already running.');
    ctx.benching = true;
    try { res.json(await ff.benchmark(config.effectiveProfile())); } finally { ctx.benching = false; }
  }));

  api.use((req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) log.error('http', `${req.method} ${req.path}: ${err.stack || err.message}`);
    res.status(status).json({ error: status >= 500 ? 'Unexpected server error. Details are in the Logs view.' : redact(err.message), code: err.code, problems: err.problems, metadata: err.metadata, guidance: err.guidance, duplicateOf: err.duplicateOf });
  });
  return app;
}

function startBroadcasting(ctx) {
  ctx.log.on('entry', (e) => {
    const msg = `event: log\ndata: ${JSON.stringify(e)}\n\n`;
    for (const c of ctx.sse) c.res.write(msg);
  });
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    ctx.metrics.sample(ctx.engine.stats);
    const msg = `event: status\ndata: ${JSON.stringify(ctx.buildStatus())}\n\n`;
    for (const c of ctx.sse) c.res.write(msg);
    ctx._tick = setTimeout(tick, ctx.config.settings.statusIntervalMs);
  };
  tick();
  return () => { stopped = true; clearTimeout(ctx._tick); for (const c of ctx.sse) c.res.end(); };
}

module.exports = { createContext, createApp, startBroadcasting };
