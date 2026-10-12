'use strict';
const path = require('path');
const { DATA_DIR } = require('./config');
const { uid, readJson, writeJson } = require('./util');
const { fail } = require('./media');

const REPEAT = ['off', 'one', 'all'];

function parseTime(v) {
  if (v === null || v === undefined || v === '') return null;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw fail(400, 'BAD_TIME', 'Invalid date/time.');
  return new Date(t).toISOString();
}

class Playlist {
  constructor({ media, config, logger }) {
    this.media = media; this.config = config; this.log = logger;
    this.file = path.join(DATA_DIR, 'playlist.json');
    this.presetFile = path.join(DATA_DIR, 'presets.json');
    const saved = readJson(this.file, {});
    this.items = Array.isArray(saved.items) ? saved.items : [];
    this.repeat = REPEAT.includes(saved.repeat) ? saved.repeat : 'off';
    this.shuffle = !!saved.shuffle;
    this.presets = readJson(this.presetFile, []);
    // Drop entries whose media record is gone; keep entries whose file is merely missing so the UI can flag them.
    this.items = this.items.filter((i) => this.media.get(i.mediaId));
  }
  save() { writeJson(this.file, { items: this.items, repeat: this.repeat, shuffle: this.shuffle }); }

  find(itemId) { return this.items.find((i) => i.itemId === itemId) || null; }

  isEligible(item, now = Date.now()) {
    const m = this.media.get(item.mediaId);
    if (!m || !this.media.exists(m)) return false;
    if (item.startAt && Date.parse(item.startAt) > now) return false;
    if (item.endAt && Date.parse(item.endAt) <= now) return false;
    return true;
  }
  eligibility(item, now = Date.now()) {
    const m = this.media.get(item.mediaId);
    if (!m || !this.media.exists(m)) return 'missing';
    if (item.startAt && Date.parse(item.startAt) > now) return 'scheduled';
    if (item.endAt && Date.parse(item.endAt) <= now) return 'expired';
    return 'ready';
  }

  view(now = Date.now()) {
    let total = 0;
    const items = this.items.map((i, index) => {
      const m = this.media.get(i.mediaId);
      if (m) total += m.duration || 0;
      return { ...i, index, status: this.eligibility(i, now), media: m ? this.media.view(m) : null };
    });
    return { items, repeat: this.repeat, shuffle: this.shuffle, totalDuration: total, count: items.length };
  }

  add(mediaId, { startAt, endAt } = {}) {
    if (!this.media.get(mediaId)) throw fail(404, 'NOT_FOUND', 'That media item does not exist.');
    const item = { itemId: uid(5), mediaId, startAt: parseTime(startAt), endAt: parseTime(endAt), addedAt: new Date().toISOString(), lastError: null };
    this.checkWindow(item);
    this.items.push(item); this.save();
    return item;
  }
  checkWindow(i) { if (i.startAt && i.endAt && Date.parse(i.endAt) <= Date.parse(i.startAt)) throw fail(400, 'BAD_WINDOW', 'The end time must be after the start time.'); }
  update(itemId, patch) {
    const i = this.find(itemId); if (!i) throw fail(404, 'NOT_FOUND', 'Playlist item not found.');
    const next = { ...i };
    if ('startAt' in patch) next.startAt = parseTime(patch.startAt);
    if ('endAt' in patch) next.endAt = parseTime(patch.endAt);
    this.checkWindow(next);
    Object.assign(i, next); this.save(); return i;
  }
  setError(itemId, msg) { const i = this.find(itemId); if (i) { i.lastError = msg ? { message: msg, at: new Date().toISOString() } : null; this.save(); } }
  remove(itemId) {
    if (!this.find(itemId)) throw fail(404, 'NOT_FOUND', 'Playlist item not found.');
    this.items = this.items.filter((i) => i.itemId !== itemId); this.save();
  }
  removeMedia(mediaId) { this.items = this.items.filter((i) => i.mediaId !== mediaId); this.save(); }
  reorder(ids) {
    if (!Array.isArray(ids) || ids.length !== this.items.length || new Set(ids).size !== ids.length || !ids.every((id) => this.find(id))) {
      throw fail(400, 'BAD_ORDER', 'The new order must list every playlist item exactly once.');
    }
    this.items = ids.map((id) => this.find(id)); this.save();
  }
  setModes({ repeat, shuffle }) {
    if (repeat !== undefined) { if (!REPEAT.includes(repeat)) throw fail(400, 'BAD_MODE', 'Repeat must be off, one or all.'); this.repeat = repeat; }
    if (shuffle !== undefined) this.shuffle = !!shuffle;
    this.save();
  }
  clear() { this.items = []; this.save(); }

  /**
   * Choose the next item. Pure with respect to the playlist: callers own `played` (a Set of itemIds).
   * Returns { item, waitMs, resetPlayed }.
   *  - item: next playable item, or null
   *  - waitMs: when item is null but something is scheduled in the future, how long until it opens
   */
  pick({ currentId = null, played = new Set(), now = Date.now(), onPlaylistEnd = 'stop', random = Math.random } = {}) {
    const eligible = this.items.filter((i) => this.isEligible(i, now));
    const future = this.items.filter((i) => i.startAt && Date.parse(i.startAt) > now && this.media.exists(this.media.get(i.mediaId)));
    const result = (item, resetPlayed = false) => {
      if (item) return { item, waitMs: 0, resetPlayed };
      const nextOpen = future.length ? Math.max(0, Math.min(...future.map((f) => Date.parse(f.startAt))) - now) : 0;
      return { item: null, waitMs: nextOpen, resetPlayed };
    };
    if (!eligible.length) return result(null);

    const cur = currentId ? this.find(currentId) : null;
    if (this.repeat === 'one' && cur && this.isEligible(cur, now)) return result(cur);

    if (this.shuffle) {
      let pool = eligible.filter((i) => !played.has(i.itemId) && i.itemId !== currentId);
      if (!pool.length) {
        if (this.repeat === 'all' || onPlaylistEnd === 'restart') {
          pool = eligible.length > 1 ? eligible.filter((i) => i.itemId !== currentId) : eligible;
          return result(pool[Math.floor(random() * pool.length)], true);
        }
        return result(null);
      }
      return result(pool[Math.floor(random() * pool.length)]);
    }

    const idx = cur ? this.items.indexOf(cur) : -1;
    for (let k = 1; k <= this.items.length; k++) {
      const pos = idx + k;
      if (pos >= this.items.length) {
        if (this.repeat !== 'all' && onPlaylistEnd !== 'restart') return result(null);
        const wrapped = this.items[pos % this.items.length];
        if (this.isEligible(wrapped, now)) return result(wrapped, true);
        continue;
      }
      if (this.isEligible(this.items[pos], now)) return result(this.items[pos]);
    }
    return result(cur && this.isEligible(cur, now) && this.repeat === 'all' ? cur : null);
  }

  /** Pre-flight checks, shared by the "Validate" button and engine start. */
  validate(profile) {
    const issues = [];
    if (!this.items.length) issues.push({ level: 'error', message: 'The playlist is empty.' });
    for (const i of this.items) {
      const m = this.media.get(i.mediaId);
      const name = m ? m.name : i.mediaId;
      const st = this.eligibility(i);
      if (st === 'missing') issues.push({ level: 'error', itemId: i.itemId, message: `"${name}": the media file is missing on disk.` });
      if (st === 'expired') issues.push({ level: 'warn', itemId: i.itemId, message: `"${name}": its scheduled window has ended, so it will be skipped.` });
      if (st === 'scheduled') issues.push({ level: 'info', itemId: i.itemId, message: `"${name}": waits for ${i.startAt}.` });
      if (i.lastError) issues.push({ level: 'warn', itemId: i.itemId, message: `"${name}": failed last time (${i.lastError.message}).` });
      if (m && profile) {
        if (m.video.height < profile.height * 0.9) issues.push({ level: 'warn', itemId: i.itemId, message: `"${name}" is ${m.video.width}x${m.video.height}; scaling to ${profile.width}x${profile.height} enlarges it but cannot add real detail.` });
        if (m.video.fps && m.video.fps + 0.5 < profile.fps) issues.push({ level: 'info', itemId: i.itemId, message: `"${name}" is ${m.video.fps.toFixed(0)} fps; the ${profile.fps} fps output repeats frames, it does not create motion.` });
        for (const w of m.warnings || []) issues.push({ level: 'info', itemId: i.itemId, message: `"${name}": ${w}` });
      }
    }
    return { ok: !issues.some((x) => x.level === 'error'), issues };
  }

  // ----- presets -----
  listPresets() { return this.presets.map((p) => ({ id: p.id, name: p.name, count: p.items.length, repeat: p.repeat, shuffle: p.shuffle, createdAt: p.createdAt })); }
  savePreset(name) {
    name = String(name || '').trim().slice(0, 80);
    if (!name) throw fail(400, 'BAD_NAME', 'Give the preset a name.');
    if (!this.items.length) throw fail(400, 'EMPTY', 'Add items to the playlist before saving a preset.');
    const existing = this.presets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const body = { name, items: this.items.map(({ mediaId, startAt, endAt }) => ({ mediaId, startAt, endAt })), repeat: this.repeat, shuffle: this.shuffle, createdAt: new Date().toISOString() };
    if (existing) Object.assign(existing, body); else this.presets.push({ id: uid(5), ...body });
    writeJson(this.presetFile, this.presets);
    return this.listPresets();
  }
  loadPreset(id) {
    const p = this.presets.find((x) => x.id === id);
    if (!p) throw fail(404, 'NOT_FOUND', 'Preset not found.');
    const kept = p.items.filter((i) => this.media.get(i.mediaId));
    this.items = kept.map((i) => ({ itemId: uid(5), mediaId: i.mediaId, startAt: i.startAt || null, endAt: i.endAt || null, addedAt: new Date().toISOString(), lastError: null }));
    this.repeat = p.repeat; this.shuffle = p.shuffle; this.save();
    return { loaded: kept.length, skipped: p.items.length - kept.length };
  }
  deletePreset(id) {
    if (!this.presets.some((p) => p.id === id)) throw fail(404, 'NOT_FOUND', 'Preset not found.');
    this.presets = this.presets.filter((p) => p.id !== id); writeJson(this.presetFile, this.presets);
  }
}

module.exports = { Playlist };
