'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'po-unit-'));
process.env.DATA_DIR = path.join(tmp, 'data'); process.env.MEDIA_DIR = path.join(tmp, 'media');
delete process.env.STREAM_KEY;

const { redact, registerSecret } = require('../src/logger');
const { Auth, loadCredentials } = require('../src/auth');
const { isPrivateAddress, isYouTubeVideoUrl } = require('../src/importer');
const { ConfigStore } = require('../src/config');
const ff = require('../src/ffmpeg');
const { Playlist } = require('../src/playlist');

test('first-run credentials are generated securely and persisted with private permissions', () => {
  const names = ['APP_USERNAME', 'APP_PASSWORD'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const first = loadCredentials();
    const second = loadCredentials();
    assert.strictEqual(first.generated, true);
    assert.match(first.username, /^admin-[a-f0-9]{16}$/);
    assert.ok(first.password.length >= 40);
    assert.strictEqual(second.generated, false);
    assert.strictEqual(second.username, first.username);
    assert.strictEqual(second.password, first.password);
    assert.strictEqual((fs.statSync(path.join(process.env.DATA_DIR, 'admin-credentials.json')).mode & 0o777), 0o600);
    assert.throws(() => new Auth('short', 'too-short'), /APP_USERNAME/);
    assert.throws(() => new Auth('valid-admin', 'too-short'), /APP_PASSWORD/);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('redact hides stream keys, URL credentials and registered secrets', () => {
  registerSecret('abcd-1234-efgh');
  const out = redact('push rtmp://a.rtmp.youtube.com/live2/abcd-1234-efgh failed; also https://u:p@host/x token=zzz999 Bearer abc.def');
  assert.ok(!out.includes('abcd-1234-efgh')); assert.ok(!out.includes('u:p@')); assert.ok(!out.includes('zzz999')); assert.ok(!out.includes('abc.def'));
  assert.match(out, /rtmp:\/\/a\.rtmp\.youtube\.com\/live2\/\[REDACTED\]/);
});

test('SSRF guard classifies private addresses', () => {
  for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.9', '172.16.5.5', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(isPrivateAddress(a), a);
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isPrivateAddress(a), a);
});

test('YouTube URL validation accepts videos and rejects pages or unrelated hosts', () => {
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://youtube.com/shorts/dQw4w9WgXcQ', 'https://youtube.com/live/dQw4w9WgXcQ']) assert.ok(isYouTubeVideoUrl(url), url);
  for (const url of ['https://youtube.com/@channel', 'https://youtube.com/channel/UC12345678901234567890', 'https://notyoutube.com/watch?v=dQw4w9WgXcQ', 'not a url']) assert.ok(!isYouTubeVideoUrl(url), url);
});

test('config validation rejects bad destinations and custom values; key is masked', () => {
  const c = new ConfigStore();
  assert.throws(() => c.updateStream({ rtmpUrl: 'http://x/y' }), /rtmp/);
  assert.throws(() => c.updateStream({ profile: 'custom', custom: { width: 1921, height: 1080, fps: 30, videoKbps: 6000, audioKbps: 160 } }), /even/);
  assert.throws(() => c.updateStream({ profile: 'custom', custom: { width: 1920, height: 1080, fps: 144, videoKbps: 6000, audioKbps: 160 } }), /fps/i);
  assert.ok(c.streamConfigProblems().some((p) => /stream key/i.test(p)));
  c.setStreamKey('supersecretkey-9876');
  assert.strictEqual(c.maskedKey().endsWith('9876'), true); assert.ok(!c.maskedKey().includes('supersecret'));
  assert.ok(!JSON.stringify(c.publicStream()).includes('supersecretkey'));
  assert.strictEqual((fs.statSync(c.secretFile).mode & 0o600), 0o600);
});

test('destination config validates platform ingest protocols and keeps nine stream keys private', () => {
  const c = new ConfigStore();
  const platforms = ['youtube', 'youtube', 'youtube', 'facebook', 'facebook', 'facebook', 'instagram', 'instagram', 'instagram'];
  const added = platforms.map((platform, i) => c.addDestination({
    name: `${platform} ${i + 1}`,
    platform,
    rtmpUrl: platform === 'youtube' ? 'rtmps://a.rtmps.youtube.com:443/live2' : `rtmps://ingest.example/${platform}/`,
    key: `private-key-${platform}-${i}-1234`,
  }));
  assert.strictEqual(added.length, 9);
  assert.strictEqual(c.publicDestinations().length, 9);
  assert.ok(!JSON.stringify(c.publicDestinations()).includes('private-key-'));
  assert.ok(added[0].streamKeyMasked.endsWith('1234'));
  assert.strictEqual((fs.statSync(c.secretFile).mode & 0o777), 0o600);
  assert.ok(redact('private-key-youtube-0-1234').includes('[REDACTED]'));
  assert.throws(() => c.addDestination({ name: 'Bad Facebook', platform: 'facebook', rtmpUrl: 'rtmp://ingest.example/live', key: 'valid-key-123456' }), /RTMPS/);
  assert.throws(() => c.addDestination({ name: 'Bad URL', platform: 'instagram', rtmpUrl: 'https://ingest.example/live', key: 'valid-key-123456' }), /RTMP/);
  const updated = c.updateDestination(added[0].id, { name: 'Updated YouTube', key: 'replacement-key-9876' });
  assert.strictEqual(updated.streamKeyMasked.endsWith('9876'), true);
  assert.strictEqual(c.destinationWithKey(added[0].id).key, 'replacement-key-9876');
  c.removeDestination(added[0].id);
  assert.strictEqual(c.destinationWithKey(added[0].id), null);
  for (const d of added.slice(1)) c.removeDestination(d.id);
  const sharedKey = 'shared-secret-key-7788';
  const first = c.addDestination({ name: 'Shared YouTube', platform: 'youtube', rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2', key: sharedKey });
  const second = c.addDestination({ name: 'Shared Facebook', platform: 'facebook', rtmpUrl: 'rtmps://ingest.example/live', key: sharedKey });
  c.removeDestination(first.id);
  assert.ok(!redact(sharedKey).includes(sharedKey));
  c.removeDestination(second.id);
  assert.ok(redact(sharedKey).includes(sharedKey));
});

test('environment overrides can raise upload and import limits without changing the file settings', () => {
  const prev = { MAX_UPLOAD_MB: process.env.MAX_UPLOAD_MB, MAX_IMPORT_MB: process.env.MAX_IMPORT_MB, MIN_FREE_DISK_MB: process.env.MIN_FREE_DISK_MB };
  try {
    process.env.MAX_UPLOAD_MB = '8192';
    process.env.MAX_IMPORT_MB = '10240';
    process.env.MIN_FREE_DISK_MB = '2048';
    const c = new ConfigStore();
    assert.strictEqual(c.settings.maxUploadMB, 8192);
    assert.strictEqual(c.settings.maxImportMB, 10240);
    assert.strictEqual(c.settings.minFreeDiskMB, 2048);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('FFmpeg args are arrays and encode the requested profile', () => {
  const p = { width: 1280, height: 720, fps: 30, videoKbps: 3500, audioKbps: 128, gopSeconds: 2, aspect: 'fit', pixFmt: 'yuv420p', sampleRate: 48000, encoder: 'libx264', x264Preset: 'veryfast', mode: 'transcode' };
  const meta = { audio: null, video: { codec: 'h264' } };
  const args = ff.buildFeederArgs({ file: '/m/a b; rm -rf.mp4', meta, profile: p, durationSec: 5, tsOffset: 1.5 });
  assert.ok(Array.isArray(args)); assert.ok(args.includes('/m/a b; rm -rf.mp4'));
  assert.ok(args.includes('anullsrc=channel_layout=stereo:sample_rate=48000'));
  assert.strictEqual(args[args.indexOf('-g') + 1], '60'); assert.ok(args.includes('-output_ts_offset'));
  assert.match(args[args.indexOf('-vf') + 1], /scale=1280:720.*pad=1280:720.*fps=30|fps=30.*scale=1280:720/);
});

test('copy compatibility explains mismatches', () => {
  const p = { width: 1920, height: 1080, fps: 30, sampleRate: 48000 };
  const good = { video: { codec: 'h264', pixFmt: 'yuv420p', width: 1920, height: 1080, fps: 30 }, audio: { codec: 'aac', sampleRate: 48000 } };
  assert.ok(ff.copyCompat(good, p).ok);
  const bad = ff.copyCompat({ ...good, video: { ...good.video, codec: 'hevc', width: 1280 } }, p);
  assert.ok(!bad.ok && bad.reasons.length >= 2);
  assert.ok(!ff.copyCompat({ ...good, audio: null }, p).ok);
});

test('playlist selection: sequential, repeat, shuffle, schedule', () => {
  const m = { get: () => ({}), exists: () => true };
  const pl = new Playlist({ media: m, config: {}, logger: {} });
  pl.items = ['a', 'b', 'c'].map((x) => ({ itemId: x, mediaId: x }));
  pl.save = () => {};
  assert.strictEqual(pl.pick({ currentId: 'a' }).item.itemId, 'b');
  assert.strictEqual(pl.pick({ currentId: 'c' }).item, null);
  pl.repeat = 'all'; const w = pl.pick({ currentId: 'c' }); assert.strictEqual(w.item.itemId, 'a'); assert.ok(w.resetPlayed);
  pl.repeat = 'one'; assert.strictEqual(pl.pick({ currentId: 'b' }).item.itemId, 'b');
  pl.repeat = 'off'; pl.shuffle = true;
  const played = new Set(['a']); const seen = new Set();
  for (let i = 0; i < 20; i++) seen.add(pl.pick({ currentId: 'a', played }).item.itemId);
  assert.deepStrictEqual([...seen].sort(), ['b', 'c']);
  pl.shuffle = false; pl.items[1].startAt = new Date(Date.now() + 60000).toISOString();
  assert.strictEqual(pl.pick({ currentId: 'a' }).item.itemId, 'c');
  pl.items = [pl.items[1]]; const r = pl.pick({}); assert.strictEqual(r.item, null); assert.ok(r.waitMs > 0);
});
