'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MEDIA_DIR, DATA_DIR } = require('./config');
const { uid, readJson, writeJson, ensureDir, safeName } = require('./util');
const ff = require('./ffmpeg');

const ALLOWED_EXT = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.ts'];
const TMP_DIR = path.join(MEDIA_DIR, '.tmp');
const THUMB_DIR = path.join(MEDIA_DIR, '.thumbs');

const fail = (status, code, message, extra) => Object.assign(new Error(message), { status, code, ...extra });

class MediaLibrary {
  constructor(logger) {
    this.log = logger;
    this.file = path.join(DATA_DIR, 'media.json');
    ensureDir(MEDIA_DIR); ensureDir(TMP_DIR); ensureDir(THUMB_DIR);
    this.items = readJson(this.file, []);
    this.cleanTmp();
  }
  save() { writeJson(this.file, this.items); }
  cleanTmp() { // leftovers from aborted uploads / crashes
    for (const f of fs.readdirSync(TMP_DIR)) fs.rm(path.join(TMP_DIR, f), { force: true }, () => {});
  }
  tmpPath() { return path.join(TMP_DIR, uid(8) + '.part'); }
  list() { return this.items.map((m) => this.view(m)); }
  get(id) { return this.items.find((m) => m.id === id) || null; }
  filePath(m) { return path.join(MEDIA_DIR, m.file); }
  exists(m) { return !!m && fs.existsSync(this.filePath(m)); }
  view(m) { return { ...m, missing: !this.exists(m), thumbUrl: m.thumb ? `/api/media/${m.id}/thumb` : null }; }
  thumbPath(m) { return path.join(THUMB_DIR, m.id + '.jpg'); }

  freeBytes() {
    try { const s = fs.statfsSync(MEDIA_DIR); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
  }
  checkDisk(incomingBytes, minFreeMB) {
    const free = this.freeBytes();
    if (free === null) return;
    const need = incomingBytes + minFreeMB * 1024 * 1024;
    if (free < need) {
      throw fail(507, 'DISK_FULL', `Not enough disk space: ${(free / 1048576).toFixed(0)} MB free, ${(need / 1048576).toFixed(0)} MB needed (file plus the ${minFreeMB} MB reserve).`);
    }
  }

  async hashFile(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
  }

  /** Validate a downloaded/uploaded temp file and move it into the library. Always removes the temp file on failure. */
  async ingest(tmpFile, originalName, { source = 'upload', sourceUrl = null } = {}) {
    const rm = () => fs.rmSync(tmpFile, { force: true });
    try {
      const { base, ext } = safeName(originalName);
      if (!ALLOWED_EXT.includes(ext)) throw fail(415, 'UNSUPPORTED_TYPE', `"${ext || 'no extension'}" files are not supported. Allowed: ${ALLOWED_EXT.join(', ')}.`);
      const stat = fs.statSync(tmpFile);
      if (stat.size === 0) throw fail(422, 'EMPTY_FILE', 'The file is empty.');

      // ffprobe needs a recognisable extension for some containers; probe via a temp name with the real extension.
      const probeFile = tmpFile + ext;
      fs.renameSync(tmpFile, probeFile);
      const rm2 = () => fs.rmSync(probeFile, { force: true });
      try {
        const meta = await ff.probe(probeFile);
        if (!meta.video) throw fail(422, 'NO_VIDEO', 'No video stream found in this file.');
        if (!meta.duration || meta.duration < 0.5) throw fail(422, 'NO_DURATION', 'The file has no usable duration (live captures or truncated files cannot be scheduled).');
        const dec = await ff.decoders();
        if (!dec.has(meta.video.codec)) throw fail(422, 'CODEC_UNSUPPORTED', `This FFmpeg build cannot decode the video codec "${meta.video.codec}".`);
        if (meta.audio && !dec.has(meta.audio.codec)) throw fail(422, 'CODEC_UNSUPPORTED', `This FFmpeg build cannot decode the audio codec "${meta.audio.codec}".`);
        const dc = await ff.decodeCheck(probeFile);
        if (!dc.ok) throw fail(422, 'CORRUPT', 'The file appears to be corrupted: ' + (dc.message || 'decoding failed') );

        const sha256 = await this.hashFile(probeFile);
        const dup = this.items.find((m) => m.sha256 === sha256);
        if (dup) throw fail(409, 'DUPLICATE', `Already in the library as "${dup.name}".`, { duplicateOf: dup.id });

        const id = uid(6);
        const stored = `${id}-${base}${ext}`;
        fs.renameSync(probeFile, path.join(MEDIA_DIR, stored));
        const warnings = [];
        if (!meta.audio) warnings.push('No audio track: silence will be generated when this item plays.');
        if (meta.video.bitDepth && meta.video.bitDepth > 8) warnings.push('10-bit source: it will be converted to 8-bit for H.264 output.');
        if (meta.video.colorTransfer && /smpte2084|arib-std-b67/.test(meta.video.colorTransfer)) warnings.push('HDR source: colours will look flat on an SDR stream without tone mapping.');
        const entry = {
          id, name: path.basename(String(originalName)).slice(0, 200), file: stored, size: stat.size, sha256,
          duration: meta.duration, formatName: meta.formatName, bitrateKbps: meta.bitrateKbps,
          video: meta.video, audio: meta.audio, thumb: false, addedAt: new Date().toISOString(), source, sourceUrl, warnings,
        };
        entry.thumb = await ff.makeThumbnail(path.join(MEDIA_DIR, stored), this.thumbPath(entry), meta.duration);
        this.items.push(entry); this.save();
        this.log.info('media', `Added "${entry.name}" (${meta.video.width}x${meta.video.height}, ${meta.duration.toFixed(1)}s)`);
        return this.view(entry);
      } catch (e) { rm2(); throw e; }
    } catch (e) { rm(); throw e; }
  }

  remove(id) {
    const m = this.get(id);
    if (!m) throw fail(404, 'NOT_FOUND', 'Media item not found.');
    fs.rmSync(this.filePath(m), { force: true });
    fs.rmSync(this.thumbPath(m), { force: true });
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
    this.log.info('media', `Deleted "${m.name}"`);
  }
}

module.exports = { MediaLibrary, ALLOWED_EXT, TMP_DIR, fail };
