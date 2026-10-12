'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const { spawn, execFileSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'po-int-'));
const TEST_USERNAME = 'integration-admin';
const TEST_PASSWORD = 'integration-password-with-more-than-20-chars';
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: path.join(tmp, 'data'),
  MEDIA_DIR: path.join(tmp, 'media'),
  APP_USERNAME: TEST_USERNAME,
  APP_PASSWORD: TEST_PASSWORD,
  ALLOW_PRIVATE_IMPORTS: '1',
});
delete process.env.STREAM_KEY;
const { createContext, createApp } = require('../src/app');

const clipA = path.join(tmp, 'a.mp4'), clipB = path.join(tmp, 'b.mp4');
let ctx, server, base, sessionCookie;
const call = async (method, p, body) => {
  const r = await fetch(base + '/api' + p, { method, headers: { ...(sessionCookie ? { cookie: sessionCookie, 'X-Playout': '1' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const upload = async (file, name = path.basename(file)) => {
  const fd = new FormData(); fd.append('file', new Blob([fs.readFileSync(file)]), name);
  const r = await fetch(base + '/api/media/upload', { method: 'POST', headers: { cookie: sessionCookie, 'X-Playout': '1' }, body: fd });
  return { status: r.status, body: await r.json() };
};
const waitFor = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; };

test.before(async () => {
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clipA]);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x240:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', clipB]);
  ctx = await createContext(); const app = createApp(ctx);
  server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await ctx.engine.stop().catch(() => {}); ctx.engine.killAllNow(); server.close(); });

test('API requires strict username/password login and persists the theme setting', async () => {
  assert.strictEqual((await fetch(base + '/api/status')).status, 401);
  const bad = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: TEST_USERNAME, password: 'wrong-secret' }) });
  assert.strictEqual(bad.status, 401);
  const good = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }) });
  assert.strictEqual(good.status, 200);
  sessionCookie = good.headers.get('set-cookie').split(';')[0];
  const cookie = sessionCookie;
  assert.match(good.headers.get('set-cookie'), /HttpOnly/); assert.match(good.headers.get('set-cookie'), /SameSite=Strict/);
  assert.strictEqual((await fetch(base + '/api/engine/stop', { method: 'POST', headers: { cookie } })).status, 403);
  assert.strictEqual((await fetch(base + '/api/status', { headers: { cookie } })).status, 200);
  assert.strictEqual((await fetch(base + '/api/status', { headers: { Authorization: 'Bearer retired-test-token' } })).status, 401);
  const settings = await call('GET', '/settings');
  assert.strictEqual(settings.body.settings.theme, 'dark');
  const saved = await call('PUT', '/settings', { theme: 'skyblue' });
  assert.strictEqual(saved.status, 200);
  assert.strictEqual(saved.body.settings.theme, 'skyblue');
  assert.strictEqual(settings.body.auth.credentialSource, 'environment');
});

test('destination API manages nine platform outputs without exposing keys', async () => {
  const created = [];
  try {
    for (const [index, platform] of ['youtube', 'youtube', 'youtube', 'facebook', 'facebook', 'facebook', 'instagram', 'instagram', 'instagram'].entries()) {
      const result = await call('POST', '/destinations', {
        name: `${platform} ${index + 1}`, platform,
        rtmpUrl: platform === 'youtube' ? 'rtmps://a.rtmps.youtube.com:443/live2' : `rtmps://ingest.example/${platform}/`,
        key: `integration-private-${platform}-${index}-7788`,
      });
      assert.strictEqual(result.status, 201, JSON.stringify(result.body));
      created.push(result.body.destination.id);
    }
    const list = await call('GET', '/destinations');
    assert.strictEqual(list.body.destinations.length, 9);
    assert.ok(!JSON.stringify(list.body).includes('integration-private-'));
    assert.ok(list.body.destinations.every((d) => d.streamKeySet && d.streamKeyMasked.endsWith('7788')));
    const bad = await call('POST', '/destinations', { name: 'Bad Facebook', platform: 'facebook', rtmpUrl: 'rtmp://ingest.example/live', key: 'valid-key-123456' });
    assert.strictEqual(bad.status, 400); assert.match(bad.body.error, /RTMPS/);
    assert.strictEqual((fs.statSync(path.join(process.env.DATA_DIR, 'secrets.json')).mode & 0o777), 0o600);
  } finally {
    for (const id of created) await call('DELETE', `/destinations/${id}`);
  }
});

test('upload validates, extracts metadata, makes a thumbnail and rejects duplicates, bad types and corrupt files', async () => {
  const a = await upload(clipA); assert.strictEqual(a.status, 201);
  assert.strictEqual(a.body.video.width, 640); assert.ok(a.body.duration > 3.5); assert.ok(a.body.thumb);
  assert.strictEqual((await upload(clipA, 'copy.mp4')).status, 409);
  const b = await upload(clipB); assert.strictEqual(b.status, 201); assert.strictEqual(b.body.audio, null); assert.ok(b.body.warnings.length);
  assert.strictEqual((await upload(clipA, 'evil.exe')).status, 415);
  const junk = path.join(tmp, 'junk.mp4'); fs.writeFileSync(junk, Buffer.from('not a video at all '.repeat(500)));
  const j = await upload(junk); assert.strictEqual(j.status, 422);
  assert.deepStrictEqual(fs.readdirSync(path.join(process.env.MEDIA_DIR, '.tmp')), []);
  const thumb = await fetch(base + `/api/media/${a.body.id}/thumb`, { headers: { cookie: sessionCookie } });
  assert.strictEqual(thumb.headers.get('content-type'), 'image/jpeg');
});

test('URL import: direct video files work and HTML or non-video YouTube pages are refused', async () => {
  const fresh = path.join(tmp, 'fresh.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:r=24:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', fresh]);
  const srv = http.createServer((q, r) => { if (q.url === '/v.mp4') { r.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fs.statSync(fresh).size }); fs.createReadStream(fresh).pipe(r); } else { r.writeHead(200, { 'Content-Type': 'text/html' }); r.end('<html></html>'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const origin = `http://127.0.0.1:${srv.address().port}`;
  const j = await call('POST', '/imports', { url: origin + '/v.mp4' }); assert.strictEqual(j.status, 202);
  assert.ok(await waitFor(async () => (await call('GET', '/imports')).body.jobs.find((x) => x.id === j.body.id)?.state === 'done'));
  const h = await call('POST', '/imports', { url: origin + '/page' });
  assert.ok(await waitFor(async () => (await call('GET', '/imports')).body.jobs.find((x) => x.id === h.body.id)?.state === 'error'));
  const yt = await call('POST', '/imports', { url: 'https://www.youtube.com/@channel' });
  assert.strictEqual(yt.status, 422); assert.strictEqual(yt.body.code, 'YOUTUBE_NOT_DOWNLOADABLE');
  assert.strictEqual((await call('POST', '/imports', { url: 'ftp://x/y.mp4' })).status, 400);
  srv.close();
});

test('preflight blocks going live without a key; settings and key handling never leak the key', async () => {
  const items = (await call('GET', '/media')).body.items;
  for (const m of items.slice(0, 2)) await call('POST', '/playlist/items', { mediaId: m.id });
  const pre = await call('POST', '/engine/start'); assert.strictEqual(pre.status, 400); assert.match(pre.body.error, /stream key/i);
  assert.strictEqual((await call('PUT', '/stream/key', { key: 'short' })).status, 400);
  const saved = await call('PUT', '/stream/key', { key: 'live-key-SECRET-7788' }); assert.strictEqual(saved.status, 200);
  assert.ok(!JSON.stringify(saved.body).includes('SECRET')); assert.ok(saved.body.stream.streamKeyMasked.endsWith('7788'));
  const st = JSON.stringify((await call('GET', '/status')).body) + JSON.stringify((await call('GET', '/stream')).body);
  assert.ok(!st.includes('live-key-SECRET'));
  const exp = await fetch(base + '/api/diagnostics/export', { headers: { cookie: sessionCookie } });
  assert.ok(!(await exp.text()).includes('live-key-SECRET'));
  assert.strictEqual((await call('PUT', '/stream', { rtmpUrl: 'rtmp://127.0.0.1:19350/live', profile: '720p30' })).status, 200);
});

test('broadcast pipeline (FLV output to file): goes live, plays the playlist in order, controls work, output is valid, no stray processes', async (t) => {
  const out = path.join(tmp, 'received.flv');
  process.env.PLAYOUT_TEST_OUTPUT = out; // writes the FLV the publisher would send to a file (no RTMP server needed)
  ctx.config.updateSettings({ maxRetries: 0 });
  const start = await call('POST', '/engine/start'); assert.strictEqual(start.status, 200, JSON.stringify(start.body));
  assert.strictEqual((await call('POST', '/engine/start')).status, 409, 'second start must be refused');
  assert.ok(await waitFor(() => ctx.engine.state === 'live', 20000), 'reaches live: ' + ctx.engine.lastError);
  assert.ok(ctx.engine.snapshot().current.name);
  assert.ok(ctx.engine.pids.size <= 3);
  const skip = await call('POST', '/engine/skip'); assert.strictEqual(skip.status, 200);
  assert.ok(await waitFor(() => ctx.engine.current?.name === 'b.mp4'), 'skip moved to second item');
  assert.strictEqual((await call('PUT', '/stream', { profile: '1080p30' })).status, 409, 'settings locked while live');
  assert.strictEqual((await call('DELETE', `/media/${ctx.engine.current.mediaId}`)).status, 409, 'on-air media cannot be deleted');
  await call('POST', '/engine/previous');
  assert.ok(await waitFor(() => ctx.engine.current?.name === 'a.mp4'), 'previous returned to first item');
  assert.ok(await waitFor(() => ctx.engine.state === 'idle', 30000), 'playlist ends and engine stops by itself');
  delete process.env.PLAYOUT_TEST_OUTPUT;
  assert.strictEqual(ctx.engine.pids.size, 0, 'no FFmpeg processes left');
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video'), a = probe.streams.find((s) => s.codec_type === 'audio');
  assert.strictEqual(v.codec_name, 'h264'); assert.strictEqual(v.width, 1280); assert.strictEqual(v.height, 720); assert.ok(a && a.codec_name === 'aac');
  assert.ok(parseFloat(probe.format.duration) > 8, 'received ' + probe.format.duration);
  const logs = JSON.stringify((await call('GET', '/logs?level=debug&limit=2000')).body);
  assert.ok(!logs.includes('live-key-SECRET'), 'key must not appear in logs');
});

test('failed destination: engine retries with backoff, then reports the real error', async () => {
  await call('PUT', '/stream', { rtmpUrl: 'rtmp://127.0.0.1:19999/live' });
  ctx.config.updateSettings({ maxRetries: 1, backoffBaseSec: 1, backoffMaxSec: 1 });
  assert.strictEqual((await call('POST', '/engine/start')).status, 200);
  assert.ok(await waitFor(() => ctx.engine.state === 'error', 30000), 'ends in error state');
  assert.match(ctx.engine.lastError, /retries/); assert.ok(!ctx.engine.lastError.includes('SECRET'));
  assert.ok(await waitFor(() => ctx.engine.pids.size === 0, 5000), 'no stray FFmpeg processes');
});

test('multi-destination broadcast reports three refused RTMP outputs and cleans every FFmpeg process', async () => {
  const ids = [];
  try {
    ctx.config.updateSettings({ maxRetries: 0 });
    for (let i = 0; i < 3; i++) {
      const result = await call('POST', '/destinations', {
        name: `Local YouTube ${i + 1}`, platform: 'youtube',
        rtmpUrl: `rtmp://127.0.0.1:${19990 + i}/live`, key: `multi-test-secret-${i}-7788`,
      });
      assert.strictEqual(result.status, 201);
      ids.push(result.body.destination.id);
    }
    const start = await call('POST', '/engine/start');
    assert.strictEqual(start.status, 200, JSON.stringify(start.body));
    assert.ok(await waitFor(() => ctx.engine.state === 'error', 20000), 'all refusing outputs end in engine error');
    const statuses = ctx.engine.snapshot().destinations;
    assert.strictEqual(statuses.length, 3);
    assert.ok(statuses.every((d) => d.state === 'error'), JSON.stringify(statuses));
    assert.ok(statuses.every((d) => d.state !== 'live'), 'refused outputs are never reported as sending');
    assert.ok(await waitFor(() => ctx.engine.pids.size === 0, 5000), 'all output and feeder processes are cleaned up');
    assert.ok(!JSON.stringify(statuses).includes('multi-test-secret-'));
  } finally {
    if (ctx.engine.state !== 'idle') await ctx.engine.stop('Test cleanup').catch(() => {});
    for (const id of ids) await call('DELETE', `/destinations/${id}`);
  }
});

test('individual destination controls manage three concurrent publisher processes without claiming a handshake', async () => {
  const sockets = new Set();
  const ingest = net.createServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await new Promise((resolve) => ingest.listen(0, '127.0.0.1', resolve));
  const ids = [];
  try {
    ctx.config.updateSettings({ maxRetries: 0 });
    for (let i = 0; i < 3; i++) {
      const result = await call('POST', '/destinations', {
        name: `Handshake test ${i + 1}`, platform: 'youtube',
        rtmpUrl: `rtmp://127.0.0.1:${ingest.address().port}/live/${i}`, key: `control-test-secret-${i}-7788`,
      });
      assert.strictEqual(result.status, 201);
      ids.push(result.body.destination.id);
    }
    assert.strictEqual((await call('POST', '/engine/start')).status, 200);
    assert.ok(await waitFor(() => ctx.engine.pids.size >= 4, 10000), 'three publisher processes plus the feeder are running');
    let live = await call('GET', '/destinations');
    assert.ok(live.body.destinations.every((d) => d.state !== 'live'), 'an uncompleted RTMP handshake is not reported as live');

    assert.strictEqual((await call('POST', `/destinations/${ids[0]}/stop`)).status, 200);
    let stopped = await call('GET', '/destinations');
    assert.strictEqual(stopped.body.destinations.find((d) => d.id === ids[0]).state, 'stopped');
    assert.strictEqual((await call('POST', `/destinations/${ids[0]}/start`)).status, 200);
    assert.strictEqual((await call('POST', `/destinations/${ids[1]}/stop`)).status, 200);
    assert.strictEqual((await call('POST', `/destinations/${ids[2]}/stop`)).status, 200);
  } finally {
    if (ctx.engine.state !== 'idle') await ctx.engine.stop('Test cleanup').catch(() => {});
    for (const id of ids) await call('DELETE', `/destinations/${id}`);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => ingest.close(resolve));
  }
  assert.strictEqual(ctx.engine.pids.size, 0, 'all publisher and feeder processes are cleaned up');
});
