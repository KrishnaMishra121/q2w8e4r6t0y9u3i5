'use strict';
/* Dashboard, Live Control and Playlist views. */
(() => {
  const { h, icon, icons, mount, fmt, api, busy, ok, err, toast, confirm, dialog, chip, card, stat, spark, progress, setProgress, empty, skeleton } = PO;

  const STATE_LABEL = { idle: 'Idle', starting: 'Starting', live: 'Live', stopping: 'Stopping', error: 'Error' };
  const stateChip = (s) => chip(STATE_LABEL[s] || s, s === 'live' ? 'err' : s === 'error' ? 'err' : s === 'idle' ? '' : 'warn');

  // ---- "program monitor": the current item with timecode and progress (used on Dashboard and Live Control) ----
  function monitor() {
    const img = h('img', { alt: '', hidden: true });
    const pic = h('div', { class: 'pic' }, icon('film'), img);
    const title = h('div', { class: 'title' }, 'Nothing on air');
    const sub = h('div', { class: 'muted small' }, 'Start the broadcast to begin playing the playlist.');
    const tc = h('div', { class: 'tc' }, '00:00:00');
    const tcSmall = h('small', null, '');
    tc.append(tcSmall);
    const bar = progress(0, 100);
    const next = h('div', { class: 'muted small' }, '');
    const el = h('div', { class: 'monitor' }, pic, h('div', null, title, sub, h('div', { class: 'spacer' }), h('div', { class: 'row' }, tc), bar, next));
    let lastMedia = null;
    el.update = (s) => {
      const c = s.engine.current;
      pic.classList.toggle('air', s.engine.state === 'live');
      if (c && !c.slate) {
        title.textContent = c.name;
        sub.textContent = `${c.copy ? 'Stream copy' : 'Transcoded'} · ${fmt.dur(c.duration)} long${c.startSec ? ` · resumed at ${fmt.dur(c.startSec)}` : ''}`;
        tc.firstChild.textContent = fmt.tc(c.elapsedSec); tcSmall.textContent = `/ ${fmt.tc(c.duration)}`;
        setProgress(bar, c.elapsedSec, c.duration || 1);
        if (lastMedia !== c.mediaId) { lastMedia = c.mediaId; img.hidden = false; img.src = `/api/media/${c.mediaId}/thumb`; img.onerror = () => { img.hidden = true; }; }
      } else {
        lastMedia = null; img.hidden = true; tc.firstChild.textContent = '00:00:00'; tcSmall.textContent = ''; setProgress(bar, 0, 100);
        const destinationCount = s.engine.destinations?.length || 0;
        title.textContent = c?.slate ? c.name : s.engine.state === 'starting' ? destinationCount > 1 ? `Connecting to ${destinationCount} destinations…` : 'Connecting to the destination…' : 'Nothing on air';
        sub.textContent = c?.slate ? 'Sending black and silence until the scheduled item starts.' : s.engine.state === 'idle' ? 'Start the broadcast to begin playing the playlist.' : '';
      }
      const n = s.engine.next;
      next.textContent = n ? (n.waitMs ? `Up next: scheduled item, opens in ${fmt.uptime(n.waitMs / 1000)}` : `Up next: ${n.name}`) : (s.engine.state === 'live' ? 'Up next: the playlist ends after this item.' : '');
    };
    return el;
  }

  // ---------------- Dashboard ----------------
  PO.views.dashboard = {
    title: 'Dashboard',
    render(root) {
      const tState = stat('Broadcast'), tAir = stat('On air'), tList = stat('Playlist'), tOut = stat('Output profile');
      const mon = monitor();
      const kv = h('dl', { class: 'kv' });
      const cpuSpark = spark(100), memSpark = spark(100), brSpark = spark();
      const cpuV = h('b', null, '–'), memV = h('b', null, '–'), brV = h('b', null, '–'), diskV = h('b', null, '–');
      const diskBar = progress(0, 100); const cpuSub = h('span', { class: 'muted small' }, ''); const memSub = h('span', { class: 'muted small' }, '');
      const health = h('ul');
      const events = h('div', { class: 'scroll-x' });
      const metric = (label, val, sub, chart) => h('div', { class: 'card card-body metric' }, h('div', { class: 'top' }, h('span', { class: 'muted' }, label), val), chart, sub);
      mount(root,
        h('div', { class: 'grid cols-4' }, tState, tAir, tList, tOut),
        h('div', { class: 'grid cols-2' },
          card('Program', mon),
          card('Output: requested vs actual', kv)),
        h('div', { class: 'grid cols-3' },
          metric('CPU', cpuV, cpuSub, cpuSpark), metric('Memory', memV, memSub, memSpark),
          metric('Stream bitrate', brV, h('span', { class: 'muted small' }, 'Measured by the publisher process'), brSpark)),
        h('div', { class: 'grid cols-2' },
          card('Health checks', health, { flush: true }),
          card('Recent events', events, { flush: true })),
        h('div', { class: 'card card-body metric' }, h('div', { class: 'top' }, h('span', { class: 'muted' }, 'Media disk free'), diskV), diskBar));
      // spacing between grid blocks
      [...root.children].forEach((n) => n.classList.add('mb'));

      const row = (k, v) => [h('dt', null, k), h('dd', null, v)];
      const update = (s) => {
        const e = s.engine, o = e.output, r = o.requested, st = e.stats;
        tState.set(STATE_LABEL[e.state], e.state === 'live' ? `Live for ${fmt.uptime(e.uptimeSec)}` : e.reconnect ? `Reconnecting (${e.reconnect.attempt}/${e.reconnect.max})` : e.lastError ? 'See Live Control' : 'Not broadcasting');
        tAir.set(e.current?.name || '–', e.next && !e.next.waitMs ? `Next: ${e.next.name}` : '');
        tList.set(`${s.playlist.count} item${s.playlist.count === 1 ? '' : 's'}`, `${fmt.dur(s.playlist.totalDuration)} total · repeat ${s.playlist.repeat}${s.playlist.shuffle ? ' · shuffle' : ''}`);
        tOut.set(s.stream.label, `${fmt.kbps(r.videoKbps)} video`);
        mon.update(s);
        kv.replaceChildren(...[
          row('Requested', `${r.width}×${r.height} @ ${r.fps} fps, ${fmt.kbps(r.videoKbps)} H.264, ${r.audioKbps} kbps AAC ${r.sampleRate / 1000} kHz`),
          row('Input now', e.input ? `${fmt.res(e.input)} · ${e.input.codec}` : '–'),
          row('Video encoder', e.state === 'idle' ? `${r.encoder} (configured)` : o.videoEncoder),
          row('Hardware acceleration', o.hardwareAccel ? 'Active' : 'Not active (software encoding)'),
          row('Mode', `${r.mode}${o.activeMode ? ` · now: ${o.activeMode}` : ''}`),
          row('Keyframes / scaling', `every ${r.gopSeconds}s · ${r.aspect} · ${r.pixFmt}`),
          row('Delivered', e.state === 'live' ? `${st.fps ? st.fps.toFixed(1) + ' fps · ' : ''}${fmt.kbps(st.bitrateKbps)} · speed ${st.speed ? st.speed.toFixed(2) + '×' : '–'} · ${st.dropped} dropped` : '–'),
          row('Processes', `${e.processCount} FFmpeg${e.publisher.running ? ` · publisher up ${fmt.uptime(e.publisher.uptimeSec)}` : ''}`),
        ].flat());
        if (o.upscaling) kv.append(...row('Note', 'The source is smaller than the output, so it is being enlarged. Scaling cannot add real detail.'));
        const m = s.metrics; const hist = m.history;
        cpuV.textContent = `${m.cpuPercent.toFixed(0)}%`; cpuSub.textContent = `${m.cpuCount} cores · load ${m.loadAvg[0].toFixed(2)}`; cpuSpark.set(hist.cpu, 'CPU history');
        memV.textContent = `${m.memPercent.toFixed(0)}%`; memSub.textContent = `${fmt.bytes(m.memTotal - m.memFree)} of ${fmt.bytes(m.memTotal)} · server ${fmt.bytes(m.serverRss)}`; memSpark.set(hist.mem, 'Memory history');
        brV.textContent = e.state === 'live' ? fmt.kbps(st.bitrateKbps) : '–'; brSpark.set(hist.bitrate, 'Bitrate history');
        if (m.disk) { const used = (1 - m.disk.freeBytes / m.disk.totalBytes) * 100; diskV.textContent = `${fmt.bytes(m.disk.freeBytes)} of ${fmt.bytes(m.disk.totalBytes)}`; setProgress(diskBar, used, 100, used > 90 ? 'err' : used > 80 ? 'warn' : ''); } else diskV.textContent = 'Unknown on this platform';

        const keysReady = s.engine.destinations?.length ? s.engine.destinations.every((d) => d.streamKeySet) : s.stream.streamKeySet;
        const checks = [
          [s.health.ffmpeg.ok, 'FFmpeg', s.health.ffmpeg.ok ? `Version ${s.health.ffmpeg.version}` : s.health.ffmpeg.error],
          [s.health.ffprobe.ok, 'FFprobe', s.health.ffprobe.ok ? `Version ${s.health.ffprobe.version}` : s.health.ffprobe.error],
          [keysReady, 'Stream keys', keysReady ? 'Set (hidden)' : 'Missing. Check Stream Settings or Destinations.'],
          [s.health.configOk, 'Configuration', s.health.configOk ? 'Valid' : s.health.problems[0]],
          [s.playlist.ready > 0, 'Playlist', s.playlist.ready > 0 ? `${s.playlist.ready} item${s.playlist.ready === 1 ? '' : 's'} ready` : 'No playable items yet.'],
        ];
        mount(health, checks.map(([good, k, v]) => h('li', { class: 'row' }, h('span', { class: `dot ${good ? 'ok' : 'warn'}` }), h('b', null, k), h('span', { class: 'muted' }, v))));
        mount(events, s.events.length ? h('table', { class: 'tbl' }, h('tbody', null, s.events.map((ev) => h('tr', null, h('td', { class: 'muted' }, fmt.time(ev.ts)), h('td', null, chip(ev.level, ev.level === 'error' ? 'err' : ev.level === 'warn' ? 'warn' : '')), h('td', null, ev.message))))) : empty('scroll-text', 'No events yet', 'Starting, stopping and errors will appear here.'));
      };
      if (PO.state.status) update(PO.state.status);
      return { update };
    },
  };

  // ---------------- Live Control ----------------
  PO.views.live = {
    title: 'Live Control',
    render(root) {
      const mon = monitor();
      const startBtn = h('button', { class: 'btn primary lg', type: 'button' }, icon('play'), 'Go live');
      const stopBtn = h('button', { class: 'btn danger lg', type: 'button' }, icon('square'), 'Stop');
      const restartBtn = h('button', { class: 'btn lg', type: 'button' }, icon('rotate-cw'), 'Restart');
      const prevBtn = h('button', { class: 'btn', type: 'button' }, icon('skip-back'), 'Previous');
      const againBtn = h('button', { class: 'btn', type: 'button' }, icon('rotate-ccw'), 'Restart item');
      const skipBtn = h('button', { class: 'btn', type: 'button' }, icon('skip-forward'), 'Skip');
      const notes = h('div'); const problemsBox = h('div'); const stats = h('dl', { class: 'kv' });
      let preflightFor = null;

      const act = (btn, path, msg) => busy(btn, () => api('POST', path), msg);
      startBtn.onclick = async () => {
        const s = PO.state.status;
        const destinations = s.engine.destinations || [];
        const target = destinations.length ? `${destinations.length} configured destinations` : s.stream.rtmpUrl;
        if (!(await confirm({ title: 'Go live?', message: `This starts sending the playlist to ${target}. Check each platform’s Live Producer to confirm ingest.`, confirmLabel: 'Go live' }))) return;
        act(startBtn, '/engine/start', 'Starting the broadcast…');
      };
      stopBtn.onclick = async () => { if (await confirm({ title: 'End the broadcast?', message: 'The stream will stop and viewers will see it end.', confirmLabel: 'Stop broadcast', danger: true })) act(stopBtn, '/engine/stop', 'Broadcast stopped.'); };
      restartBtn.onclick = async () => { if (await confirm({ title: 'Restart the broadcast?', message: 'The stream will drop for a few seconds while it reconnects.', confirmLabel: 'Restart' })) act(restartBtn, '/engine/restart', 'Restarting…'); };
      prevBtn.onclick = () => act(prevBtn, '/engine/previous'); againBtn.onclick = () => act(againBtn, '/engine/restart-item'); skipBtn.onclick = () => act(skipBtn, '/engine/skip');

      mount(root,
        h('div', { class: 'grid cols-2 mb' },
          card('Program', h('div', { class: 'grid' }, mon, h('div', { class: 'transport' }, prevBtn, againBtn, skipBtn),
            h('p', { class: 'hint' }, 'A live stream cannot be paused without dropping the connection, so there is no pause button. Use Stop to end the broadcast.'))),
          card('Broadcast', h('div', { class: 'grid' }, h('div', { class: 'row' }, startBtn, stopBtn, restartBtn), notes, problemsBox))),
        card('Delivery', stats));

      const refreshPreflight = async (key) => {
        if (preflightFor === key) return; preflightFor = key;
        try { const r = await api('GET', '/engine/preflight'); mount(problemsBox, r.ok ? h('div', { class: 'banner info' }, icon('shield-check'), h('div', null, 'All pre-flight checks pass.')) : h('div', { class: 'banner warn' }, icon('triangle-alert'), h('div', null, h('b', null, 'Fix these before going live'), h('ul', null, r.problems.map((p) => h('li', null, p)))))); } catch { /* shown by the connection pill */ }
      };
      const update = (s) => {
        const e = s.engine; const idle = ['idle', 'error'].includes(e.state), running = ['live', 'starting'].includes(e.state);
        mon.update(s);
        startBtn.disabled = !idle; stopBtn.disabled = e.state === 'idle' || e.state === 'stopping'; restartBtn.disabled = !running;
        const t = running && e.current; prevBtn.disabled = !t; againBtn.disabled = !t || e.current?.slate; skipBtn.disabled = !t;
        const blocks = [];
        if (e.reconnect) blocks.push(h('div', { class: 'banner warn' }, icon('rotate-cw'), h('div', null, `Connection lost. Reconnecting in ${Math.ceil(e.reconnect.inMs / 1000)}s (attempt ${e.reconnect.attempt} of ${e.reconnect.max}). Playback will resume where it left off.`)));
        if (e.lastError && e.state === 'error') blocks.push(h('div', { class: 'banner err' }, icon('circle-alert'), h('div', null, h('b', null, 'The broadcast stopped'), h('p', null, e.lastError))));
        if (e.state === 'live') blocks.push(h('div', { class: 'banner info' }, icon('radio'), h('div', null, `Sending for ${fmt.uptime(e.uptimeSec)}. Confirm ingest in each platform’s Live Producer.`)));
        mount(notes, blocks);
        refreshPreflight(`${e.state}|${s.playlist.count}|${s.playlist.ready}|${s.health.configOk}`);
        const st = e.stats, r = e.output.requested;
        mount(stats, [['State', stateChip(e.state)], ['Frame rate', e.state === 'live' && st.fps ? `${st.fps.toFixed(1)} fps (requested ${r.fps})` : '–'], ['Bitrate', e.state === 'live' ? fmt.kbps(st.bitrateKbps) : '–'], ['Speed', e.state === 'live' && st.speed ? `${st.speed.toFixed(2)}× realtime` : '–'], ['Dropped frames', e.state === 'live' ? String(st.dropped) : '–'], ['Reconnect attempts', `${e.retries}`], ['FFmpeg processes', String(e.processCount)]].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
      };
      if (PO.state.status) update(PO.state.status);
      return { update };
    },
  };

  // ---------------- Playlist ----------------
  PO.pickMedia = async function pickMedia({ title = 'Add to playlist' } = {}) {
    const { items } = await api('GET', '/media');
    if (!items.length) { toast('info', 'The media library is empty. Upload a video first.'); return []; }
    const boxes = items.map((m) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: m.id, disabled: m.missing }), h('span', { class: 'thumb' }, m.thumbUrl ? h('img', { src: m.thumbUrl, alt: '', class: 'thumb' }) : icon('film')), h('span', null, m.name, h('small', { class: 'muted' }, ` ${fmt.dur(m.duration)}${m.missing ? ' · file missing' : ''}`))));
    let chosen = [];
    await dialog({ title, body: h('div', { class: 'grid' }, boxes), actions: [{ label: 'Cancel', value: 'no' }, { label: 'Add selected', cls: 'primary', value: 'yes', run: () => { chosen = boxes.map((b) => b.querySelector('input')).filter((i) => i.checked).map((i) => i.value); } }] });
    return chosen;
  };

  PO.views.playlist = {
    title: 'Playlist',
    async render(root) {
      mount(root, card('Playlist', skeleton(4)));
      let data; const rows = new Map(); let dragId = null;
      const body = h('div');
      const load = async () => { data = await api('GET', '/playlist'); draw(); if (PO.state.status) update(PO.state.status); };

      const reorder = async (ids) => { try { await api('PUT', '/playlist/order', { ids }); } catch (e) { err(e); } await load(); };
      const move = (i, d) => { const ids = data.items.map((x) => x.itemId); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; reorder(ids); };

      const statusChip = (it) => it.lastError ? chip('Failed last time', 'err') : it.status === 'missing' ? chip('File missing', 'err') : it.status === 'expired' ? chip('Window ended', 'warn') : it.status === 'scheduled' ? chip('Scheduled', 'blue') : null;
      const editSchedule = async (it) => {
        const s = h('input', { type: 'datetime-local', id: 'sch-s', value: fmt.toLocalInput(it.startAt) }), e = h('input', { type: 'datetime-local', id: 'sch-e', value: fmt.toLocalInput(it.endAt) });
        await dialog({ title: `Schedule: ${it.media?.name || 'item'}`, body: h('div', null, h('p', { class: 'muted' }, 'Optional. Outside this window the item is skipped. Leave both empty to play whenever its turn comes. Times use your browser’s time zone.'), h('div', { class: 'field' }, h('label', { for: 'sch-s' }, 'Start no earlier than'), s), h('div', { class: 'field' }, h('label', { for: 'sch-e' }, 'End no later than'), e)),
          actions: [{ label: 'Cancel', value: 'no' }, { label: 'Save schedule', cls: 'primary', value: 'yes', run: async (btn) => { const r = await busy(btn, () => api('PATCH', `/playlist/items/${it.itemId}`, { startAt: fmt.fromLocalInput(s.value), endAt: fmt.fromLocalInput(e.value) }), 'Schedule saved.'); if (r === undefined) return false; await load(); } }] });
      };

      function rowFor(it, i) {
        const m = it.media;
        const r = h('div', { class: 'pl-row', draggable: 'true', 'data-id': it.itemId, role: 'listitem' },
          h('span', { class: 'grip', 'aria-hidden': 'true' }, icon('grip-vertical')), h('span', { class: 'idx' }, String(i + 1)),
          m?.thumbUrl ? h('img', { class: 'thumb', src: m.thumbUrl, alt: '' }) : h('span', { class: 'thumb' }, icon('film')),
          h('div', { class: 'cell-title' }, h('div', { class: 't' }, m?.name || 'Unknown media', h('small', null, m ? `${fmt.res(m.video)} · ${fmt.dur(m.duration)}${it.startAt ? ` · from ${fmt.dateTime(it.startAt)}` : ''}${it.endAt ? ` · until ${fmt.dateTime(it.endAt)}` : ''}` : ''))),
          h('div', { class: 'row col-status' }, h('span', { 'data-slot': 'air' }), statusChip(it)),
          h('div', { class: 'row' },
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move up', 'data-tip': 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, icon('chevron-up')),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move down', 'data-tip': 'Move down', disabled: i === data.items.length - 1, onclick: () => move(i, 1) }, icon('chevron-down')),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit schedule', 'data-tip': 'Schedule', onclick: () => editSchedule(it) }, icon('calendar-clock')),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Remove ${m?.name || 'item'}`, 'data-tip': 'Remove', onclick: async () => { if (await busy(null, () => api('DELETE', `/playlist/items/${it.itemId}`))) load(); } }, icon('trash-2'))));
        if (it.lastError) r.title = it.lastError.message;
        r.addEventListener('dragstart', (ev) => { dragId = it.itemId; r.classList.add('dragging'); ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', it.itemId); });
        r.addEventListener('dragend', () => { dragId = null; rows.forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after')); });
        r.addEventListener('dragover', (ev) => { if (!dragId || dragId === it.itemId) return; ev.preventDefault(); const b = r.getBoundingClientRect(); const before = ev.clientY < b.top + b.height / 2; r.classList.toggle('drop-before', before); r.classList.toggle('drop-after', !before); r.dataset.pos = before ? 'before' : 'after'; });
        r.addEventListener('dragleave', () => r.classList.remove('drop-before', 'drop-after'));
        r.addEventListener('drop', (ev) => { ev.preventDefault(); if (!dragId || dragId === it.itemId) return; const ids = data.items.map((x) => x.itemId).filter((x) => x !== dragId); const at = ids.indexOf(it.itemId) + (r.dataset.pos === 'after' ? 1 : 0); ids.splice(at, 0, dragId); reorder(ids); });
        rows.set(it.itemId, r); return r;
      }

      const repeatSel = h('select', { id: 'pl-repeat', 'aria-label': 'Repeat mode' }, [['off', 'Repeat: off'], ['one', 'Repeat: current item'], ['all', 'Repeat: whole playlist']].map(([v, l]) => h('option', { value: v }, l)));
      const shuffleBox = h('input', { type: 'checkbox', id: 'pl-shuffle' });
      repeatSel.onchange = () => busy(null, () => api('PUT', '/playlist/modes', { repeat: repeatSel.value }), 'Repeat mode saved.');
      shuffleBox.onchange = () => busy(null, () => api('PUT', '/playlist/modes', { shuffle: shuffleBox.checked }), shuffleBox.checked ? 'Shuffle on.' : 'Shuffle off.');
      const summary = h('span', { class: 'muted' });

      const showValidate = async (btn) => {
        const r = await busy(btn, () => api('POST', '/playlist/validate')); if (!r) return;
        await dialog({ title: r.ok ? 'Playlist checks' : 'Playlist has problems', body: r.issues.length ? h('ul', null, r.issues.map((i) => h('li', { class: 'row' }, chip(i.level, i.level === 'error' ? 'err' : i.level === 'warn' ? 'warn' : ''), h('span', null, i.message)))) : h('p', null, 'Everything looks playable.'), actions: [{ label: 'Close', cls: 'primary', value: 'ok' }] });
      };
      const savePreset = async () => {
        const name = h('input', { type: 'text', id: 'pre-name', maxlength: '80', placeholder: 'e.g. Weeknight rotation' });
        await dialog({ title: 'Save as preset', body: h('div', { class: 'field' }, h('label', { for: 'pre-name' }, 'Preset name'), name, h('p', { class: 'hint' }, 'Saving under an existing name replaces that preset.')), actions: [{ label: 'Cancel', value: 'no' }, { label: 'Save preset', cls: 'primary', value: 'yes', run: async (b) => { const r = await busy(b, () => api('POST', '/presets', { name: name.value }), 'Preset saved.'); if (r === undefined) return false; await load(); } }] });
      };
      const loadPreset = async () => {
        const { presets } = await api('GET', '/presets');
        const list = presets.length ? h('div', { class: 'grid' }, presets.map((p) => h('div', { class: 'row between' }, h('div', null, h('b', null, p.name), h('div', { class: 'muted small' }, `${p.count} items · repeat ${p.repeat}${p.shuffle ? ' · shuffle' : ''}`)),
          h('div', { class: 'row' }, h('button', { class: 'btn sm primary', type: 'button', onclick: async (ev) => { if (!(await confirm({ title: 'Replace the playlist?', message: `Loading "${p.name}" replaces the current playlist.`, confirmLabel: 'Load preset' }))) return; const r = await busy(ev.currentTarget, () => api('POST', `/presets/${p.id}/load`)); if (r) { toast(r.skipped ? 'info' : 'ok', `Loaded ${r.loaded} item${r.loaded === 1 ? '' : 's'}${r.skipped ? `; ${r.skipped} skipped because the media was deleted.` : '.'}`); document.getElementById('dialog').close(); load(); } } }, 'Load'),
            h('button', { class: 'btn sm danger', type: 'button', onclick: async (ev) => { if (await busy(ev.currentTarget, () => api('DELETE', `/presets/${p.id}`), 'Preset deleted.')) { document.getElementById('dialog').close(); loadPreset(); } } }, 'Delete'))))) : empty('save', 'No presets yet', 'Use “Save as preset” to keep this playlist for later.');
        dialog({ title: 'Playlist presets', body: list, actions: [{ label: 'Close', value: 'ok' }] });
      };

      function draw() {
        rows.clear();
        repeatSel.value = data.repeat; shuffleBox.checked = data.shuffle;
        summary.textContent = `${data.count} item${data.count === 1 ? '' : 's'} · ${fmt.dur(data.totalDuration)} total`;
        mount(body, data.items.length ? h('div', { role: 'list' }, data.items.map(rowFor)) : empty('list-video', 'The playlist is empty', 'Add videos from your media library to build the running order.', h('button', { class: 'btn primary', type: 'button', onclick: addMedia }, icon('plus'), 'Add media')));
      }
      async function addMedia() {
        const ids = await PO.pickMedia(); if (!ids.length) return;
        if (await busy(null, () => api('POST', '/playlist/items', { mediaIds: ids }), `Added ${ids.length} item${ids.length === 1 ? '' : 's'}.`)) load();
      }
      const toolbar = h('div', { class: 'row mb' },
        h('button', { class: 'btn primary', type: 'button', onclick: addMedia }, icon('plus'), 'Add media'),
        h('div', null, repeatSel), h('label', { class: 'check', for: 'pl-shuffle' }, shuffleBox, icon('shuffle'), 'Shuffle'),
        h('span', { class: 'spacer' }), summary,
        h('button', { class: 'btn', type: 'button', onclick: (e) => showValidate(e.currentTarget) }, icon('list-checks'), 'Validate'),
        h('button', { class: 'btn', type: 'button', onclick: savePreset }, icon('save'), 'Save as preset'),
        h('button', { class: 'btn', type: 'button', onclick: loadPreset }, icon('folder-open'), 'Presets'),
        h('button', { class: 'btn danger', type: 'button', onclick: async (e) => { if (!data.count) return; if (await confirm({ title: 'Clear the playlist?', message: 'All items are removed from the playlist. Media files stay in the library.', confirmLabel: 'Clear playlist', danger: true })) { if (await busy(e.currentTarget, () => api('POST', '/playlist/clear'))) load(); } } }, icon('trash-2'), 'Clear'));
      mount(root, toolbar, h('div', { class: 'card' }, body));
      try { await load(); } catch (e) { err(e); }

      const update = (s) => {
        const cur = s.engine.current?.itemId, nxt = s.engine.next?.itemId;
        rows.forEach((r, id) => {
          r.classList.toggle('on-air', id === cur && ['live', 'starting'].includes(s.engine.state)); r.classList.toggle('next', id === nxt);
          const slot = r.querySelector('[data-slot="air"]'); slot.replaceChildren(...(id === cur && s.engine.state === 'live' ? [chip('On air', 'err')] : id === nxt && ['live', 'starting'].includes(s.engine.state) ? [chip('Next', 'blue')] : []));
        });
        if (data && (s.playlist.count !== data.count)) load().catch(() => {});
      };
      return { update };
    },
  };

})();
