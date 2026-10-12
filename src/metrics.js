'use strict';
const os = require('os');
const fs = require('fs');
const { MEDIA_DIR } = require('./config');

class Metrics {
  constructor(size = 90) {
    this.size = size;
    this.hist = { cpu: [], mem: [], bitrate: [], fps: [] };
    this.prev = this._cpuTimes();
    this.cpu = 0;
  }
  _cpuTimes() { return os.cpus().reduce((a, c) => { for (const k in c.times) a.total += c.times[k]; a.idle += c.times.idle; return a; }, { idle: 0, total: 0 }); }
  sample(engineStats) {
    const now = this._cpuTimes();
    const dt = now.total - this.prev.total, di = now.idle - this.prev.idle;
    this.cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : this.cpu;
    this.prev = now;
    const mem = (1 - os.freemem() / os.totalmem()) * 100;
    const push = (k, v) => { this.hist[k].push(Math.round(v * 10) / 10); if (this.hist[k].length > this.size) this.hist[k].shift(); };
    push('cpu', this.cpu); push('mem', mem); push('bitrate', engineStats?.bitrateKbps || 0); push('fps', engineStats?.fps || 0);
  }
  disk() {
    try { const s = fs.statfsSync(MEDIA_DIR); return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) }; } catch { return null; }
  }
  snapshot() {
    const mu = process.memoryUsage();
    return {
      cpuPercent: this.cpu, cpuCount: os.cpus().length, loadAvg: os.loadavg(),
      memTotal: os.totalmem(), memFree: os.freemem(), memPercent: (1 - os.freemem() / os.totalmem()) * 100,
      serverRss: mu.rss, disk: this.disk(), history: this.hist, platform: `${os.type()} ${os.release()}`,
    };
  }
}
module.exports = { Metrics };
