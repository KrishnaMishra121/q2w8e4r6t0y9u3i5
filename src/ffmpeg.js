'use strict';
const { execFile } = require('child_process');
const { FFMPEG, FFPROBE } = require('./config');
const { redact } = require('./logger');

function run(bin, args, { timeout = 15000, maxBuffer = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    // execFile with an args array: no shell, so file names can never be interpreted as commands.
    execFile(bin, args, { timeout, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), timedOut: !!(err && err.killed) });
    });
  });
}

async function detectBinaries() {
  const [f, p] = await Promise.all([run(FFMPEG, ['-version']), run(FFPROBE, ['-version'])]);
  const ver = (r) => (r.ok ? (r.stdout.split('\n')[0].match(/version\s+(\S+)/) || [])[1] || 'unknown' : null);
  return {
    ffmpeg: { ok: f.ok, version: ver(f), path: FFMPEG, error: f.ok ? null : 'FFmpeg binary not found or not executable. Install ffmpeg or set FFMPEG_PATH.' },
    ffprobe: { ok: p.ok, version: ver(p), path: FFPROBE, error: p.ok ? null : 'FFprobe binary not found or not executable. Install ffmpeg or set FFPROBE_PATH.' },
  };
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
function parseRate(r) {
  if (!r || r === '0/0') return null;
  const [a, b] = String(r).split('/').map(Number);
  return b ? a / b : a;
}

async function probe(file) {
  const r = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30000 });
  if (!r.ok) {
    const e = new Error('FFprobe could not read this file. It may be corrupted, truncated or in an unsupported container. ' + redact(r.stderr.trim().split('\n').slice(-2).join(' ')));
    e.status = 422; e.code = 'PROBE_FAILED'; throw e;
  }
  let j; try { j = JSON.parse(r.stdout); } catch { const e = new Error('FFprobe returned unreadable output.'); e.status = 422; throw e; }
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const duration = num(j.format?.duration) ?? num(v?.duration);
  return {
    formatName: j.format?.format_name || '',
    duration: duration || 0,
    size: num(j.format?.size) || 0,
    bitrateKbps: j.format?.bit_rate ? Math.round(j.format.bit_rate / 1000) : null,
    video: v ? {
      codec: v.codec_name, profile: v.profile || null, width: v.width, height: v.height,
      fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate), pixFmt: v.pix_fmt || null,
      bitDepth: num(v.bits_per_raw_sample), colorTransfer: v.color_transfer || null,
    } : null,
    audio: a ? { codec: a.codec_name, channels: a.channels, sampleRate: num(a.sample_rate) } : null,
  };
}

// Decode the first seconds to catch corruption that ffprobe's header read does not reveal.
async function decodeCheck(file) {
  const r = await run(FFMPEG, ['-v', 'error', '-t', '3', '-i', file, '-f', 'null', '-'], { timeout: 45000 });
  const msg = r.stderr.trim();
  return { ok: r.ok && !msg, message: redact(msg.split('\n').slice(-3).join(' ')) };
}

let decoderCache = null;
async function decoders() {
  if (decoderCache) return decoderCache;
  const r = await run(FFMPEG, ['-hide_banner', '-decoders']);
  const set = new Set();
  for (const line of r.stdout.split('\n')) { const m = line.match(/^\s[VAS][\w.]{5}\s+(\S+)/); if (m) set.add(m[1]); }
  return (decoderCache = set);
}

const HW_CANDIDATES = ['h264_nvenc', 'h264_qsv', 'h264_videotoolbox'];
let encoderCache = null;
async function detectEncoders(force = false) {
  if (encoderCache && !force) return encoderCache;
  const listing = await run(FFMPEG, ['-hide_banner', '-encoders']);
  const names = new Set();
  for (const line of listing.stdout.split('\n')) { const m = line.match(/^\s[VAS][\w.]{5}\s+(\S+)/); if (m) names.add(m[1]); }
  const out = { aac: names.has('aac'), encoders: {} };
  const test = async (enc) => {
    const r = await run(FFMPEG, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x144:r=30', '-frames:v', '3', '-c:v', enc, '-pix_fmt', enc === 'h264_qsv' ? 'nv12' : 'yuv420p', '-f', 'null', '-'], { timeout: 10000 });
    return r.ok ? null : (r.stderr.trim().split('\n').slice(-1)[0] || 'Encoder test failed');
  };
  for (const enc of ['libx264', ...HW_CANDIDATES]) {
    const compiled = names.has(enc);
    if (!compiled) { out.encoders[enc] = { available: false, hardware: enc !== 'libx264', reason: 'Not compiled into this FFmpeg build.' }; continue; }
    const err = await test(enc);
    out.encoders[enc] = { available: !err, hardware: enc !== 'libx264', reason: err ? 'Compiled in, but no usable device: ' + redact(err) : null };
  }
  return (encoderCache = out);
}

// Is the source already a stream we can pass through untouched for this output profile?
function copyCompat(meta, p) {
  const why = [];
  if (!meta.video) why.push('no video stream');
  else {
    if (meta.video.codec !== 'h264') why.push(`video is ${meta.video.codec}, not H.264`);
    if (meta.video.pixFmt !== 'yuv420p') why.push(`pixel format is ${meta.video.pixFmt}, not yuv420p`);
    if (meta.video.width !== p.width || meta.video.height !== p.height) why.push(`resolution ${meta.video.width}x${meta.video.height} differs from ${p.width}x${p.height}`);
    if (!meta.video.fps || Math.abs(meta.video.fps - p.fps) > 0.5) why.push(`frame rate ${meta.video.fps ? meta.video.fps.toFixed(2) : '?'} differs from ${p.fps}`);
  }
  if (!meta.audio) why.push('no audio track (silence has to be encoded)');
  else {
    if (meta.audio.codec !== 'aac') why.push(`audio is ${meta.audio.codec}, not AAC`);
    if (meta.audio.sampleRate && meta.audio.sampleRate !== p.sampleRate) why.push(`audio sample rate ${meta.audio.sampleRate} differs from ${p.sampleRate}`);
  }
  return { ok: why.length === 0, reasons: why };
}

function videoFilter(p) {
  const { width: W, height: H, fps, aspect, pixFmt } = p;
  const pix = p.encoder === 'h264_qsv' ? 'nv12' : pixFmt;
  const scale = aspect === 'fill' ? `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=bicubic,crop=${W}:${H}`
    : aspect === 'stretch' ? `scale=${W}:${H}:flags=bicubic`
      : `scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black`;
  return `fps=${fps},${scale},setsar=1,format=${pix}`;
}

function encoderArgs(p) {
  const gop = Math.round(p.fps * p.gopSeconds);
  const v = `${p.videoKbps}k`, buf = `${p.videoKbps * 2}k`;
  const common = ['-b:v', v, '-g', String(gop)];
  switch (p.encoder) {
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'cbr', ...common, '-maxrate', v, '-bufsize', buf];
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'veryfast', ...common, '-maxrate', v];
    case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', ...common];
    default: return ['-c:v', 'libx264', '-preset', p.x264Preset, '-profile:v', 'high', ...common, '-maxrate', v, '-bufsize', buf, '-keyint_min', String(gop), '-sc_threshold', '0'];
  }
}

const audioEncArgs = (p) => ['-c:a', 'aac', '-b:a', `${p.audioKbps}k`, '-ar', String(p.sampleRate), '-ac', '2'];
const TS_OUT = ['-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1'];

/**
 * One "feeder" per playlist item. Each feeder normalises its item to MPEG-TS on stdout; the long-lived
 * publisher process reads those segments back-to-back. -output_ts_offset keeps timestamps continuous.
 */
function buildFeederArgs({ file, meta, profile: p, startSec = 0, durationSec, tsOffset = 0, copy = false, realtime = true }) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostats', '-nostdin'];
  if (realtime) args.push('-re');
  if (startSec > 0) args.push('-ss', String(startSec.toFixed(3)));
  args.push('-i', file);
  const needSilence = !meta.audio;
  if (needSilence && !copy) args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${p.sampleRate}`);
  args.push('-map', '0:v:0', '-map', needSilence && !copy ? '1:a:0' : '0:a:0', '-sn', '-dn');
  if (copy) args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero');
  else args.push('-vf', videoFilter(p), ...encoderArgs(p), '-af', 'aresample=async=1:first_pts=0', ...audioEncArgs(p));
  if (needSilence && !copy) args.push('-shortest');
  if (durationSec) args.push('-t', String(durationSec.toFixed(3)));
  args.push('-output_ts_offset', String(tsOffset.toFixed(3)), ...TS_OUT);
  return args;
}

// Black + silence, used while waiting for a scheduled item so the stream never drops.
function buildSlateArgs({ profile: p, durationSec, tsOffset = 0 }) {
  return ['-hide_banner', '-loglevel', 'warning', '-nostats', '-nostdin', '-re',
    '-f', 'lavfi', '-i', `color=c=black:s=${p.width}x${p.height}:r=${p.fps}`,
    '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${p.sampleRate}`,
    '-vf', `format=${p.encoder === 'h264_qsv' ? 'nv12' : p.pixFmt}`, ...encoderArgs(p), ...audioEncArgs(p),
    '-t', String(durationSec.toFixed(3)), '-output_ts_offset', String(tsOffset.toFixed(3)), ...TS_OUT];
}

function buildPublisherArgs(outputUrl) {
  return ['-hide_banner', '-loglevel', 'info', '-nostats', '-progress', 'pipe:1',
    '-fflags', '+genpts', '-analyzeduration', '1000000', '-probesize', '2000000',
    '-f', 'mpegts', '-i', 'pipe:0', '-c', 'copy', '-flvflags', 'no_duration_filesize', '-f', 'flv', outputUrl];
}

async function makeThumbnail(file, out, duration) {
  const at = Math.max(0, Math.min(duration * 0.1, 10));
  const r = await run(FFMPEG, ['-v', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', '-y', out], { timeout: 30000 });
  return r.ok;
}

module.exports = { run, detectBinaries, probe, decodeCheck, decoders, detectEncoders, copyCompat, videoFilter, encoderArgs, buildFeederArgs, buildSlateArgs, buildPublisherArgs, makeThumbnail };

// Real encode-speed test at the selected output profile (synthetic source, so it measures the encoder, not the content).
async function benchmark(p) {
  const t0 = Date.now();
  const r = await run(FFMPEG, ['-hide_banner', '-v', 'info', '-stats', '-f', 'lavfi', '-i', `testsrc2=size=${p.width}x${p.height}:rate=${p.fps}`,
    '-t', '6', '-vf', `format=${p.encoder === 'h264_qsv' ? 'nv12' : p.pixFmt}`, ...encoderArgs(p), '-an', '-f', 'null', '-'], { timeout: 40000 });
  if (!r.ok) return { ok: false, error: redact(r.stderr.trim().split('\n').slice(-2).join(' ')) || 'Benchmark failed.' };
  const speeds = [...r.stderr.matchAll(/speed=\s*([\d.]+)x/g)].map((m) => parseFloat(m[1]));
  const speed = speeds.length ? speeds[speeds.length - 1] : null;
  return { ok: true, speed, seconds: (Date.now() - t0) / 1000, verdict: speed === null ? 'unknown' : speed >= 1.3 ? 'comfortable' : speed >= 1.05 ? 'marginal' : 'too slow' };
}
module.exports.benchmark = benchmark;
