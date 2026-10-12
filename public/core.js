'use strict';
/* Core helpers shared by every view: DOM builder, API client, toasts, dialogs, formatting. */
window.PO = (() => {
  const PO = { views: {}, state: { status: null, lastStatusAt: 0, view: null, logs: [] } };

  // ---- DOM builder (always uses textContent, never innerHTML, so server data cannot inject markup) ----
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v === null || v === undefined) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') { if (v) el[k] = true; }
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (c) => {
      if (Array.isArray(c)) return c.forEach(add);
      if (c === null || c === undefined || c === false) return;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    };
    kids.forEach(add);
    return el;
  }
  const icon = (name) => h('i', { 'data-lucide': name, 'aria-hidden': 'true' });
  function icons() { if (window.lucide) window.lucide.createIcons(); }
  function mount(el, ...kids) { el.replaceChildren(...kids.flat().filter(Boolean)); icons(); }

  // ---- formatting ----
  const fmt = {
    bytes(n) { if (n == null) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`; },
    dur(s) { s = Math.max(0, Math.round(s || 0)); const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; },
    tc(s) { s = Math.max(0, Math.floor(s || 0)); return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':'); },
    uptime(s) { s = Math.floor(s || 0); const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`; },
    time(iso) { return new Date(iso).toLocaleTimeString([], { hour12: false }); },
    dateTime(iso) { return iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : ''; },
    kbps(k) { return k >= 1000 ? `${(k / 1000).toFixed(2)} Mbps` : `${Math.round(k)} kbps`; },
    res(v) { return v ? `${v.width}×${v.height}${v.fps ? ' @ ' + Number(v.fps).toFixed(v.fps % 1 ? 2 : 0) : ''}` : '–'; },
    toLocalInput(iso) { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; },
    fromLocalInput(v) { return v ? new Date(v).toISOString() : null; },
  };

  // ---- API ----
  class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
  async function api(method, path, body, { timeout = 30000 } = {}) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch('/api' + path, { method, signal: ctl.signal, headers: { 'X-Playout': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && path !== '/login') { PO.showLogin(); throw new ApiError('Your session has ended. Sign in again.', 401, data); }
      if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new ApiError('The server did not respond in time.', 0, {});
      if (e instanceof TypeError) throw new ApiError('Cannot reach the server. Check that it is still running.', 0, {});
      throw e;
    } finally { clearTimeout(t); }
  }

  // ---- toasts ----
  function toast(kind, message, ms = 5000) {
    const el = h('div', { class: `toast ${kind}` }, icon(kind === 'ok' ? 'circle-check' : kind === 'err' ? 'circle-alert' : 'info'), h('p', null, message));
    const box = document.getElementById('toasts'); box.append(el); icons();
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => el.remove(), kind === 'err' ? Math.max(ms, 8000) : ms);
  }
  const ok = (m) => toast('ok', m); const info = (m) => toast('info', m); const err = (e) => toast('err', e.message || String(e));

  // Run an async action with a busy button and error toast. Returns the result or undefined on failure.
  async function busy(btn, fn, successMsg) {
    if (btn) { btn.setAttribute('aria-busy', 'true'); btn.disabled = true; }
    try { const r = await fn(); if (successMsg) ok(successMsg); return r === undefined ? true : r; }
    catch (e) { err(e); return undefined; }
    finally { if (btn) { btn.removeAttribute('aria-busy'); btn.disabled = false; } }
  }

  // ---- dialogs ----
  function dialog({ title, body, actions, onClose }) {
    const dlg = document.getElementById('dialog');
    const close = (v) => { dlg.close(v); };
    const foot = h('div', { class: 'dlg-foot' }, actions.map((a) => h('button', { class: `btn ${a.cls || ''}`, type: 'button', onclick: async (e) => { const r = await a.run?.(e.currentTarget, close); if (a.close !== false && r !== false) close(a.value); } }, a.label)));
    mount(dlg, h('div', { class: 'dlg' }, h('div', { class: 'dlg-head' }, h('h3', null, title)), h('div', { class: 'dlg-body' }, body), foot));
    return new Promise((resolve) => {
      dlg.onclose = () => { dlg.onclose = null; onClose?.(); resolve(dlg.returnValue); };
      dlg.returnValue = ''; dlg.showModal();
      dlg.querySelector('input, select, button.primary, button')?.focus();
    });
  }
  async function confirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
    const v = await dialog({ title, body: h('p', null, message), actions: [{ label: 'Cancel', value: 'no' }, { label: confirmLabel, cls: danger ? 'danger solid' : 'primary', value: 'yes' }] });
    return v === 'yes';
  }

  // ---- small UI parts ----
  const chip = (text, kind = '') => h('span', { class: `chip ${kind}` }, text);
  const skeleton = (n = 3) => h('div', { class: 'card-body', 'aria-busy': 'true' }, Array.from({ length: n }, () => h('div', { class: 'sk' })));
  const empty = (ic, title, text, action) => h('div', { class: 'empty' }, icon(ic), h('h3', null, title), h('p', null, text), action);
  function card(title, body, { actions, flush } = {}) {
    return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, title), actions), h('div', { class: `card-body${flush ? ' flush' : ''}` }, body));
  }
  function stat(k) { const v = h('div', { class: 'v' }, '–'), s = h('div', { class: 's' }, ''); const el = h('div', { class: 'card stat' }, h('div', { class: 'k' }, k), v, s); el.set = (val, sub) => { v.textContent = val; s.textContent = sub || ''; }; return el; }
  function spark(max) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 100 40'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img');
    const g = document.createElementNS(NS, 'line'); g.setAttribute('class', 'grid-line'); g.setAttribute('x1', 0); g.setAttribute('x2', 100); g.setAttribute('y1', 20); g.setAttribute('y2', 20);
    const area = document.createElementNS(NS, 'polygon'); area.setAttribute('class', 'area');
    const line = document.createElementNS(NS, 'polyline'); line.setAttribute('class', 'line');
    svg.append(g, area, line);
    svg.set = (vals, label) => {
      const m = max || Math.max(1, ...vals) * 1.15; const n = Math.max(2, vals.length);
      const pts = vals.map((v, i) => `${(i / (n - 1)) * 100},${40 - Math.min(1, v / m) * 38 - 1}`);
      line.setAttribute('points', pts.join(' ')); area.setAttribute('points', pts.length ? `0,40 ${pts.join(' ')} ${((vals.length - 1) / (n - 1)) * 100},40` : '');
      if (label) svg.setAttribute('aria-label', label);
    };
    return svg;
  }
  function progress(value, max = 100, kind = '') { return h('progress', { value, max, class: kind }); }
  function setProgress(el, value, max, kind) { el.max = max; el.value = value; el.className = kind || ''; }

  Object.assign(PO, { h, icon, icons, mount, fmt, api, ApiError, toast, ok, info, err, busy, dialog, confirm, chip, skeleton, empty, card, stat, spark, progress, setProgress });
  return PO;
})();
