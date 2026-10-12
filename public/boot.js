'use strict';
/* Shell: navigation, hash router, live event stream with reconnect + polling fallback, sign-in. */
(() => {
  const { h, icon, icons, mount, fmt, api } = PO;
  const NAV = [['dashboard', 'Dashboard', 'layout-dashboard'], ['playlist', 'Playlist', 'list-video'], ['media', 'Media Library', 'library'], ['live', 'Live Control', 'radio'], ['destinations', 'Destinations', 'radio-tower'], ['stream', 'Stream Settings', 'sliders-horizontal'], ['logs', 'Logs', 'scroll-text'], ['diagnostics', 'Diagnostics', 'activity'], ['settings', 'Settings', 'settings']];
  const $ = (id) => document.getElementById(id);
  let current = null, es = null, pollT = null, backoff = 1000, reconnectT = null, navToken = 0;

  const navEl = $('nav');
  const errBadge = h('span', { class: 'badge', hidden: true });
  mount(navEl, NAV.map(([id, label, ic]) => h('li', null, h('a', { href: `#/${id}`, 'data-view': id }, icon(ic), label, id === 'logs' ? errBadge : null))));

  async function route() {
    const id = (location.hash.match(/^#\/(\w+)/) || [])[1];
    const key = PO.views[id] ? id : 'dashboard';
    if (!PO.views[id]) { history.replaceState(null, '', '#/dashboard'); }
    const token = ++navToken;
    current?.destroy?.(); current = null;
    navEl.querySelectorAll('a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.view === key) || (a.dataset.view === key ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    navEl.querySelectorAll('a').forEach((a) => { if (a.dataset.view === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    $('view-title').textContent = PO.views[key].title; document.title = `${PO.views[key].title} · Playout Console`;
    closeNav();
    const main = $('main');
    const result = await PO.views[key].render(main);
    if (token !== navToken) { result?.destroy?.(); return; }
    current = result || null; PO.state.view = key;
    main.focus({ preventScroll: true }); icons();
  }
  window.addEventListener('hashchange', route);

  // ----- mobile nav -----
  const openNav = () => { $('sidebar').classList.add('open'); $('scrim').hidden = false; $('menu-btn').setAttribute('aria-expanded', 'true'); };
  function closeNav() { $('sidebar').classList.remove('open'); $('scrim').hidden = true; $('menu-btn').setAttribute('aria-expanded', 'false'); }
  $('menu-btn').onclick = openNav; $('scrim').onclick = closeNav;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNav(); });

  // ----- top bar -----
  function paintTop(s) {
    const st = s.engine.state; const dot = $('state-pill').querySelector('.dot');
    dot.className = `dot tally ${st}`; $('state-text').textContent = ({ idle: 'Idle', starting: 'Starting', live: 'Live', stopping: 'Stopping', error: 'Error' })[st];
    if (st === 'live') $('state-text').textContent = `Live · ${fmt.uptime(s.engine.uptimeSec)}`;
    const n = s.counts.errors; errBadge.hidden = !n; errBadge.textContent = n > 99 ? '99+' : n;
  }
  function setConn(kind, text) { const p = $('conn-pill').querySelector('.dot'); p.className = `dot ${kind}`; $('conn-text').textContent = text; }

  // ----- live data: Server-Sent Events with reconnect, backed by a polling watchdog -----
  function onStatus(s) { PO.state.status = s; PO.state.lastStatusAt = Date.now(); setConn('ok', 'Connected'); paintTop(s); current?.update?.(s); }
  function connect() {
    clearTimeout(reconnectT); es?.close();
    es = new EventSource('/api/events');
    es.addEventListener('status', (e) => { backoff = 1000; try { onStatus(JSON.parse(e.data)); } catch {} });
    es.addEventListener('log', (e) => { try { const l = JSON.parse(e.data); PO.onLog?.(l); } catch {} });
    es.onerror = async () => {
      setConn('warn', 'Reconnecting');
      if (es.readyState === EventSource.CLOSED) { // the browser gave up (e.g. 401): check the session, then retry with backoff
        es.close();
        try { const r = await fetch('/api/session'); const j = await r.json(); if (!j.authed) return showLogin(); } catch { setConn('err', 'Server offline'); }
        reconnectT = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000);
      }
    };
  }
  function startPolling() {
    clearInterval(pollT);
    pollT = setInterval(async () => {
      if (Date.now() - PO.state.lastStatusAt < 9000) return;
      try { onStatus(await api('GET', '/status', null, { timeout: 5000 })); } catch (e) { if (e.status !== 401) setConn('err', 'Server offline'); }
    }, 5000);
  }
  function stopLive() { es?.close(); es = null; clearInterval(pollT); clearTimeout(reconnectT); }

  // ----- sign in / out -----
  function applyTheme(theme) {
    const t = ['dark', 'light', 'skyblue'].includes(theme) ? theme : 'dark';
    document.body.classList.remove('theme-dark', 'theme-light', 'theme-skyblue');
    document.body.classList.add(`theme-${t}`);
    document.body.dataset.theme = t;
    document.documentElement.style.colorScheme = t === 'light' ? 'light' : 'dark';
    try { localStorage.setItem('playout-theme', t); } catch {}
  }
  function getStoredTheme() {
    try { const saved = localStorage.getItem('playout-theme'); return ['dark', 'light', 'skyblue'].includes(saved) ? saved : 'dark'; } catch { return 'dark'; }
  }
  PO.applyTheme = applyTheme;
  PO.getStoredTheme = getStoredTheme;
  function showLogin() { stopLive(); current?.destroy?.(); current = null; $('shell').hidden = true; $('login').hidden = false; applyTheme(getStoredTheme()); $('login-username').focus(); icons(); }
  PO.showLogin = showLogin;
  PO.logout = async () => { try { await api('POST', '/logout'); } catch {} showLogin(); };
  $('logout-btn').onclick = PO.logout;
  $('login-form').onsubmit = async (e) => {
    e.preventDefault(); const err = $('login-error'); err.hidden = true; const b = e.submitter; b.disabled = true;
    try {
      await api('POST', '/login', { username: $('login-username').value, password: $('login-password').value });
      await enter();
    }
    catch (x) { err.textContent = x.message; err.hidden = false; }
    finally { b.disabled = false; }
  };
  async function enter() {
    $('login').hidden = true; $('shell').hidden = false; icons();
    try {
      const d = await api('GET', '/settings');
      applyTheme(d.settings?.theme || getStoredTheme());
    } catch {}
    try { onStatus(await api('GET', '/status')); } catch {}
    connect(); startPolling(); await route();
  }

  (async () => {
    icons();
    applyTheme(getStoredTheme());
    try { const r = await (await fetch('/api/session')).json(); r.authed ? await enter() : showLogin(); }
    catch { $('login').hidden = false; $('login-error').textContent = 'Cannot reach the server.'; $('login-error').hidden = false; }
  })();
  window.addEventListener('beforeunload', stopLive);
})();
