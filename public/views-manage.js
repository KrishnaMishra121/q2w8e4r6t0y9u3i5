'use strict';
/* Media Library, Stream Settings, Logs, Diagnostics and Settings views. */
(() => {
  const { h, icon, mount, fmt, api, busy, ok, err, toast, confirm, dialog, chip, card, progress, setProgress, empty, skeleton } = PO;

  // ---------------- Media Library ----------------
  PO.views.media = {
    title: 'Media Library',
    async render(root) {
      mount(root, card('Media Library', skeleton(4)));
      let lib = { items: [], allowedExt: [], maxUploadMB: 0, freeBytes: null };
      let q = '', sort = 'new', filt = 'all';
      const queue = []; let uploading = false; let pollTimer = null; let alive = true;
      const jobsBox = h('div'), importBox = h('div'), gridBox = h('div'), countEl = h('span', { class: 'muted' });
      const fileInput = h('input', { type: 'file', multiple: true, hidden: true, accept: '' });

      // ----- uploads (XHR gives real upload progress and cancellation) -----
      const addFiles = (files) => {
        for (const f of files) {
          const ext = '.' + f.name.split('.').pop().toLowerCase();
          const job = { id: Math.random().toString(36).slice(2), file: f, state: 'queued', pct: 0, error: null, xhr: null };
          if (!lib.allowedExt.includes(ext)) { job.state = 'error'; job.error = `"${ext}" is not a supported format. Allowed: ${lib.allowedExt.join(', ')}.`; }
          else if (f.size > lib.maxUploadMB * 1048576) { job.state = 'error'; job.error = `${fmt.bytes(f.size)} is over the ${lib.maxUploadMB} MB upload limit (change it in Settings).`; }
          else if (lib.freeBytes !== null && f.size > lib.freeBytes) { job.state = 'error'; job.error = `Only ${fmt.bytes(lib.freeBytes)} of disk space is free.`; }
          queue.push(job);
        }
        drawJobs(); pump();
      };
      const pump = () => {
        if (uploading) return; const job = queue.find((j) => j.state === 'queued'); if (!job) return;
        uploading = true; job.state = 'uploading';
        const xhr = new XMLHttpRequest(); job.xhr = xhr;
        xhr.open('POST', '/api/media/upload'); xhr.setRequestHeader('X-Playout', '1');
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) { job.pct = (e.loaded / e.total) * 100; if (e.loaded >= e.total) job.state = 'processing'; drawJobs(); } };
        xhr.onload = () => {
          let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
          if (xhr.status === 401) PO.showLogin();
          if (xhr.status >= 200 && xhr.status < 300) { job.state = 'done'; job.pct = 100; ok(`Added "${data.name}".`); loadLib(); }
          else { job.state = 'error'; job.error = data.error || `Upload failed (${xhr.status}).`; }
          done();
        };
        xhr.onerror = () => { job.state = 'error'; job.error = 'The connection dropped during upload.'; done(); };
        xhr.onabort = () => { job.state = 'cancelled'; done(); };
        const done = () => { uploading = false; drawJobs(); pump(); };
        const fd = new FormData(); fd.append('file', job.file, job.file.name); xhr.send(fd); drawJobs();
      };
      const drawJobs = () => {
        const recent = queue.slice(-8).reverse();
        mount(jobsBox, recent.length ? h('div', { class: 'card mb' }, recent.map((j) => h('div', { class: 'job' },
          h('div', { class: 'n' }, j.file.name, h('span', { class: 'muted small' }, `  ${fmt.bytes(j.file.size)}`)),
          h('div', { class: 'row' }, j.state === 'error' ? chip('Failed', 'err') : j.state === 'done' ? chip('Added', 'ok') : j.state === 'cancelled' ? chip('Cancelled') : j.state === 'processing' ? chip('Checking file…', 'blue') : j.state === 'uploading' ? chip(`${j.pct.toFixed(0)}%`, 'blue') : chip('Queued'),
            ['queued', 'uploading'].includes(j.state) ? h('button', { class: 'btn sm', type: 'button', onclick: () => { j.state === 'uploading' ? j.xhr.abort() : (j.state = 'cancelled', drawJobs()); } }, 'Cancel') : null),
          j.error ? h('div', { class: 'field-error', style: undefined }, j.error) : progress(j.pct, 100, j.state === 'error' ? 'err' : '')))) : null);
      };

      const drop = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Choose video files to upload' }, icon('upload'), h('b', null, 'Drop videos here or click to browse'), h('span', { class: 'small' }, 'MP4, MOV and other formats listed in the library limits. Files are checked with FFprobe before they are added.'));
      drop.onclick = () => fileInput.click(); drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); }; drop.ondragleave = () => drop.classList.remove('over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); };
      fileInput.onchange = () => { addFiles([...fileInput.files]); fileInput.value = ''; };

      // ----- URL import -----
      const urlIn = h('input', { type: 'url', id: 'imp-url', placeholder: 'https://www.youtube.com/watch?v=... or https://youtu.be/...', 'aria-describedby': 'imp-hint', autocomplete: 'off' });
      const impBtn = h('button', { class: 'btn primary', type: 'button' }, icon('download'), 'Download');
      const impMsg = h('div');
      impBtn.onclick = async () => {
        impMsg.replaceChildren();
        try { await busy(impBtn, async () => { await api('POST', '/imports', { url: urlIn.value }); urlIn.value = ''; pollJobs(); }); }
        catch (e) { err(e); }
      };
      // busy() swallows errors into a toast; for YouTube links we want the richer explanation, so call the API directly.
      impBtn.onclick = async () => {
        impMsg.replaceChildren(); impBtn.setAttribute('aria-busy', 'true'); impBtn.disabled = true;
        try { await api('POST', '/imports', { url: urlIn.value }); urlIn.value = ''; ok('Import started.'); pollJobs(); }
        catch (e) {
          mount(impMsg, h('div', { class: 'banner err' }, icon('circle-alert'), h('div', null, e.message)));
        } finally { impBtn.removeAttribute('aria-busy'); impBtn.disabled = false; }
      };
      const pollJobs = async () => {
        clearTimeout(pollTimer); if (!alive) return;
        try {
          const { jobs } = await api('GET', '/imports');
          mount(importBox, jobs.length ? h('div', { class: 'card' }, jobs.slice(0, 5).map((j) => h('div', { class: `job${j.thumbnail ? ' youtube-job' : ''}` },
            j.thumbnail ? h('img', { class: 'import-job-thumb', src: j.thumbnail, alt: '', loading: 'lazy' }) : null,
            h('div', { class: 'n', title: j.title || j.url }, j.title || j.url),
            h('div', { class: 'row' }, j.state === 'running' ? chip(j.total ? `${((j.received / j.total) * 100).toFixed(0)}%` : j.progressPct ? `${j.progressPct.toFixed(0)}%` : fmt.bytes(j.received), 'blue') : j.state === 'processing' ? chip('Checking file…', 'blue') : j.state === 'done' ? chip('Added', 'ok') : j.state === 'cancelled' ? chip('Cancelled') : chip('Failed', 'err'),
              ['running', 'processing'].includes(j.state) ? h('button', { class: 'btn sm', type: 'button', onclick: () => busy(null, () => api('DELETE', `/imports/${j.id}`)) }, 'Cancel') : null),
            j.error ? h('div', { class: 'field-error' }, j.error) : j.progressPct ? progress(j.progressPct, 100) : progress(j.total ? j.received : 0, j.total || 1)))) : null);
          if (jobs.some((j) => ['running', 'processing'].includes(j.state))) pollTimer = setTimeout(pollJobs, 1000);
          else if (jobs.some((j) => j.state === 'done')) loadLib();
        } catch { pollTimer = setTimeout(pollJobs, 4000); }
      };

      // ----- library -----
      const search = h('input', { type: 'search', placeholder: 'Search by name', 'aria-label': 'Search media' });
      const sortSel = h('select', { 'aria-label': 'Sort' }, [['new', 'Newest first'], ['name', 'Name'], ['dur', 'Longest first'], ['size', 'Largest first']].map(([v, l]) => h('option', { value: v }, l)));
      const filtSel = h('select', { 'aria-label': 'Filter' }, [['all', 'All media'], ['audio', 'Has audio'], ['noaudio', 'No audio'], ['hd', '1080p or larger'], ['sd', 'Below 720p'], ['warn', 'Has warnings'], ['missing', 'File missing']].map(([v, l]) => h('option', { value: v }, l)));
      search.oninput = () => { q = search.value.toLowerCase(); drawGrid(); }; sortSel.onchange = () => { sort = sortSel.value; drawGrid(); }; filtSel.onchange = () => { filt = filtSel.value; drawGrid(); };

      const drawGrid = () => {
        let list = lib.items.filter((m) => m.name.toLowerCase().includes(q));
        list = list.filter((m) => ({ all: true, audio: !!m.audio, noaudio: !m.audio, hd: m.video.height >= 1080, sd: m.video.height < 720, warn: m.warnings?.length, missing: m.missing })[filt]);
        list.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'dur' ? b.duration - a.duration : sort === 'size' ? b.size - a.size : b.addedAt.localeCompare(a.addedAt));
        countEl.textContent = `${list.length} of ${lib.items.length} · ${lib.freeBytes !== null ? fmt.bytes(lib.freeBytes) + ' free' : ''}`;
        mount(gridBox, list.length ? h('div', { class: 'media-grid' }, list.map(cardFor)) : lib.items.length ? empty('search', 'Nothing matches', 'Try a different search or filter.') : empty('film', 'Your library is empty', 'Upload a video above, or import one from a direct link you are authorised to use.'));
      };
      const cardFor = (m) => h('article', { class: 'media-card' },
        h('div', { class: 'pic' }, m.thumbUrl ? h('img', { src: m.thumbUrl, alt: '', loading: 'lazy' }) : icon('film'), h('span', { class: 'dur' }, fmt.dur(m.duration))),
        h('div', { class: 'info' }, h('div', { class: 'name', title: m.name }, m.name),
          h('div', { class: 'row' }, chip(fmt.res(m.video)), chip(m.video.codec), chip(m.audio ? m.audio.codec : 'no audio', m.audio ? '' : 'warn'), chip(fmt.bytes(m.size)), m.missing ? chip('File missing', 'err') : null),
          m.warnings?.length ? h('div', { class: 'muted small' }, m.warnings.join(' ')) : null),
        h('div', { class: 'actions' },
          h('button', { class: 'btn sm primary', type: 'button', disabled: m.missing, onclick: (e) => busy(e.currentTarget, () => api('POST', '/playlist/items', { mediaId: m.id }), `Added “${m.name}” to the playlist.`) }, icon('plus'), 'Playlist'),
          h('button', { class: 'btn sm danger', type: 'button', onclick: async (e) => { if (await confirm({ title: 'Delete this video?', message: `“${m.name}” is removed from the library, the playlist and the disk. This cannot be undone.`, confirmLabel: 'Delete', danger: true })) { const r = await busy(e.currentTarget, () => api('DELETE', `/media/${m.id}`)); if (r) { toast('ok', r.removedFromPlaylist ? `Deleted, and removed ${r.removedFromPlaylist} playlist entr${r.removedFromPlaylist === 1 ? 'y' : 'ies'}.` : 'Deleted.'); loadLib(); } } } }, icon('trash-2'), 'Delete')));

      async function loadLib() { try { lib = await api('GET', '/media'); fileInput.accept = lib.allowedExt.join(','); drawGrid(); } catch (e) { err(e); } }

      mount(root,
        h('div', { class: 'grid cols-2 mb' },
          card('Upload from this computer', h('div', null, drop, fileInput, h('p', { class: 'hint' }, `Limit ${lib.maxUploadMB || '…'} MB per file. Duplicates are detected by content hash.`))),
          card('Download from a YouTube link', h('div', null, h('div', { class: 'field' }, h('label', { for: 'imp-url' }, 'YouTube video URL'), h('div', { class: 'row' }, h('div', { class: 'spacer' }, urlIn), impBtn),
            h('p', { class: 'hint', id: 'imp-hint' }, 'Download public videos with yt-dlp. Choose a YouTube video, Short, or youtu.be link. Private, blocked, or login-required videos may not be downloadable.')), impMsg, importBox))),
        jobsBox,
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Library'), countEl), h('div', { class: 'card-body row' }, h('div', { class: 'spacer' }, search), sortSel, filtSel), gridBox));
      await loadLib(); pollJobs();
      return { destroy() { alive = false; clearTimeout(pollTimer); queue.filter((j) => j.state === 'uploading').forEach((j) => j.xhr?.abort()); } };
    },
  };

  // ---------------- Streaming Destinations ----------------
  PO.views.destinations = {
    title: 'Destinations',
    async render(root) {
      mount(root, card('Destinations', skeleton(4)));
      let data;
      try { data = await api('GET', '/destinations'); } catch (e) { err(e); return; }
      let destinations = data.destinations;
      let editingId = null;
      let broadcastState = data.broadcastState;
      const list = h('div'), count = h('span', { class: 'muted' });
      const nameIn = h('input', { id: 'dest-name', type: 'text', maxlength: '60', autocomplete: 'off', placeholder: 'e.g. Main YouTube channel', required: true });
      const platformIn = h('select', { id: 'dest-platform' }, [['youtube', 'YouTube Live'], ['facebook', 'Facebook Live'], ['instagram', 'Instagram Live']].map(([v, label]) => h('option', { value: v }, label)));
      const urlIn = h('input', { id: 'dest-url', type: 'url', spellcheck: 'false', autocomplete: 'off', placeholder: 'rtmps://a.rtmps.youtube.com:443/live2', required: true });
      const urlHint = h('p', { class: 'hint' });
      const keyIn = h('input', { id: 'dest-key', type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: 'Paste the stream key', required: true });
      const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, icon('plus'), 'Add destination');
      const cancelEdit = h('button', { class: 'btn', type: 'button', hidden: true }, icon('x'), 'Cancel');
      const form = h('form', { class: 'destination-form' },
        h('div', { class: 'field' }, h('label', { for: 'dest-platform' }, 'Platform'), platformIn),
        h('div', { class: 'field' }, h('label', { for: 'dest-name' }, 'Destination name'), nameIn),
        h('div', { class: 'field destination-url' }, h('label', { for: 'dest-url' }, 'RTMP(S) server URL'), urlIn, urlHint),
        h('div', { class: 'field' }, h('label', { for: 'dest-key' }, 'Stream key'), keyIn),
        h('div', { class: 'row destination-form-actions' }, saveBtn, cancelEdit));

      const setPlaceholder = () => {
        urlIn.placeholder = platformIn.value === 'youtube' ? 'rtmps://a.rtmps.youtube.com:443/live2' : platformIn.value === 'facebook' ? 'RTMPS ingest URL from Meta Live Producer' : 'RTMPS server URL from Instagram Live Producer';
        urlHint.textContent = platformIn.value === 'youtube'
          ? 'Copy the server URL and key from YouTube Studio. RTMP or RTMPS is accepted.'
          : platformIn.value === 'facebook'
            ? 'Use the RTMPS server URL and key shown by Meta Live Producer.'
            : 'Use the RTMPS URL and key from Instagram Live Producer. Live Producer availability depends on account eligibility.';
      };
      platformIn.onchange = setPlaceholder;
      const clearForm = () => {
        editingId = null; form.reset(); keyIn.required = true; keyIn.placeholder = 'Paste the stream key';
        saveBtn.replaceChildren(icon('plus'), 'Add destination'); cancelEdit.hidden = true; setPlaceholder();
      };
      cancelEdit.onclick = clearForm;
      form.onsubmit = async (event) => {
        event.preventDefault(); saveBtn.disabled = true;
        const body = { name: nameIn.value, platform: platformIn.value, rtmpUrl: urlIn.value };
        if (keyIn.value) body.key = keyIn.value;
        try {
          await api(editingId ? 'PUT' : 'POST', editingId ? `/destinations/${editingId}` : '/destinations', body);
          clearForm(); await load();
        } catch (e) { err(e); }
        finally { saveBtn.disabled = false; }
      };

      const statusInfo = (status) => ({
        live: ['Sending', 'ok'], connecting: ['Connecting', 'blue'], reconnecting: ['Retrying', 'warn'],
        error: ['Error', 'err'], stopped: ['Stopped', ''], disabled: ['Disabled', ''],
      }[status] || [status || 'Stopped', '']);
      const draw = () => {
        count.textContent = `${destinations.length} / ${data.maxDestinations} destinations`;
        mount(list, destinations.length ? h('div', { class: 'destinations-grid' }, destinations.map((d) => {
          const [label, tone] = statusInfo(d.state);
          const running = ['live', 'connecting', 'reconnecting'].includes(d.state);
          const canControl = ['live', 'starting'].includes(broadcastState);
          const edit = h('button', { class: 'icon-btn', type: 'button', title: 'Edit destination', 'aria-label': `Edit ${d.name}`, disabled: canControl, onclick: () => {
            editingId = d.id; nameIn.value = d.name; platformIn.value = d.platform; urlIn.value = d.rtmpUrl;
            keyIn.value = ''; keyIn.required = false; keyIn.placeholder = 'Leave blank to keep the current key';
            saveBtn.replaceChildren(icon('save'), 'Save changes'); cancelEdit.hidden = false; setPlaceholder(); nameIn.focus();
          } }, icon('pencil'));
          const remove = h('button', { class: 'icon-btn danger', type: 'button', title: 'Remove destination', 'aria-label': `Remove ${d.name}`, disabled: canControl, onclick: async () => {
            if (await confirm({ title: 'Remove destination?', message: `${d.name} and its saved stream key will be removed.`, confirmLabel: 'Remove', danger: true })) {
              try { await api('DELETE', `/destinations/${d.id}`); if (editingId === d.id) clearForm(); await load(); } catch (e) { err(e); }
            }
          } }, icon('trash-2'));
          const control = h('button', { class: `btn sm ${running ? 'danger' : 'primary'}`, type: 'button', disabled: !canControl, onclick: async (event) => {
            await busy(event.currentTarget, () => api('POST', `/destinations/${d.id}/${running ? 'stop' : 'start'}`));
            await load();
          } }, icon(running ? 'square' : 'play'), running ? 'Stop output' : 'Start output');
          return h('article', { class: 'card destination-card' },
            h('div', { class: 'row destination-card-head' }, h('div', null, h('div', { class: 'destination-platform' }, d.platform), h('h3', null, d.name)), chip(label, tone),
              h('div', { class: 'row destination-icon-actions' }, edit, remove)),
            h('div', { class: 'destination-endpoint mono', title: d.rtmpUrl }, d.rtmpUrl),
            h('div', { class: 'row destination-meta' }, h('span', { class: 'muted small' }, d.streamKeySet ? `Key ${d.streamKeyMasked}` : 'Key not set'), d.bitrateKbps ? h('span', { class: 'muted small' }, `${Math.round(d.bitrateKbps)} kbps`) : null),
            d.lastError ? h('p', { class: 'field-error small' }, d.lastError) : null,
            h('div', { class: 'row destination-actions' }, control));
        })) : empty('radio-tower', 'No destinations configured', 'Add your platform ingest URLs and stream keys to enable simultaneous streaming.'));
      };
      async function load() {
        try { data = await api('GET', '/destinations'); destinations = data.destinations; broadcastState = data.broadcastState; draw(); }
        catch (e) { err(e); }
      }
      mount(root,
        h('div', { class: 'row mb destination-page-head' }, h('div', null, h('h3', null, 'Multi-platform outputs'), h('p', { class: 'muted small' }, 'Every output shares the same video profile. Egress adds up: 9 outputs at 6.16 Mbps need at least 55 Mbps plus overhead. “Sending” means FFmpeg reports output progress; confirm ingest in each platform’s Live Producer.')), h('span', { class: 'spacer' }), count),
        card('Add or edit a destination', form),
        h('div', { class: 'mb' }), list);
      draw();
      return { update(status) {
        broadcastState = status.engine.state;
        const runtime = new Map(status.engine.destinations.map((d) => [d.id, d]));
        destinations = destinations.map((d) => ({ ...d, ...(runtime.get(d.id) || {}) }));
        draw();
      } };
    },
  };

  // ---------------- Stream Settings ----------------
  PO.views.stream = {
    title: 'Stream Settings',
    async render(root) {
      mount(root, card('Stream Settings', skeleton(5)));
      let d; try { d = await api('GET', '/stream'); } catch (e) { err(e); return; }
      const s = d.stream; const inputs = {};
      const f = (key, label, el, hint) => { inputs[key] = el; el.id = `st-${key}`; return h('div', { class: 'field' }, h('label', { for: el.id }, label), el, hint ? h('p', { class: 'hint' }, hint) : null); };
      const sel = (opts, val, disabledMap = {}) => h('select', null, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(val), disabled: !!disabledMap[v], title: disabledMap[v] || '' }, l + (disabledMap[v] ? ' (unavailable)' : ''))));
      const num = (val, lo, hi) => h('input', { type: 'number', value: String(val), min: lo, max: hi, step: '1', inputmode: 'numeric' });
      const L = d.limits;

      const lockBanner = h('div'); const customBox = h('div', { class: 'grid cols-2' });
      const encInfo = Object.fromEntries(Object.entries(d.encoders.encoders || {}).map(([k, v]) => [k, v.available ? '' : v.reason]));
      const anyHw = Object.values(d.encoders.encoders || {}).some((e) => e.hardware && e.available);

      const profile = f('profile', 'Output profile', sel([...Object.entries(d.profiles).map(([k, p]) => [k, p.label]), ['custom', 'Custom']], s.profile));
      const url = f('rtmpUrl', 'RTMP / RTMPS destination (without the key)', h('input', { type: 'text', value: s.rtmpUrl, spellcheck: 'false', autocomplete: 'off' }), 'YouTube: rtmp://a.rtmp.youtube.com/live2 or rtmps://a.rtmps.youtube.com:443/live2');
      const custom = {
        width: f('c-width', 'Width (px)', num(s.custom.width, ...L.width)), height: f('c-height', 'Height (px)', num(s.custom.height, ...L.height)),
        fps: f('c-fps', 'Frame rate', num(s.custom.fps, ...L.fps)), videoKbps: f('c-videoKbps', 'Video bitrate (kbps)', num(s.custom.videoKbps, ...L.videoKbps)), audioKbps: f('c-audioKbps', 'Audio bitrate (kbps)', num(s.custom.audioKbps, ...L.audioKbps)),
      };
      const syncCustom = () => { customBox.hidden = inputs.profile.value !== 'custom'; };
      mount(customBox, Object.values(custom)); inputs.profile.onchange = syncCustom;

      const mode = f('mode', 'Processing mode', sel([['transcode', 'Transcode every item (most compatible)'], ['auto', 'Stream copy when compatible, else transcode'], ['copy', 'Stream copy only (items must already match)']], s.mode), 'Stream copy uses almost no CPU, but only works when the source is already H.264/AAC at the exact output resolution and frame rate.');
      const enc = f('encoder', 'Video encoder', sel([['libx264', 'libx264 (software)'], ['h264_nvenc', 'NVIDIA NVENC'], ['h264_qsv', 'Intel Quick Sync'], ['h264_videotoolbox', 'Apple VideoToolbox']], s.encoder, encInfo), anyHw ? 'A hardware encoder passed a real test encode on this machine.' : 'No hardware encoder passed a test encode here, so only software encoding is active. This server never claims GPU acceleration it is not using.');
      const preset = f('x264Preset', 'x264 speed preset', sel(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].map((x) => [x, x]), s.x264Preset), 'Faster presets use less CPU but need more bitrate for the same quality.');
      const aspect = f('aspect', 'Aspect-ratio handling', sel([['fit', 'Fit (letterbox with black bars)'], ['fill', 'Fill (crop the edges)'], ['stretch', 'Stretch (distorts the picture)']], s.aspect));
      const pix = f('pixFmt', 'Pixel format', sel([['yuv420p', 'yuv420p (recommended)'], ['nv12', 'nv12'], ['yuv422p', 'yuv422p (not accepted by most platforms)']], s.pixFmt));
      const sr = f('sampleRate', 'Audio sample rate', sel([[48000, '48 kHz'], [44100, '44.1 kHz']], s.sampleRate));
      const gop = f('gopSeconds', 'Keyframe interval (seconds)', num(s.gopSeconds, ...L.gopSeconds), 'YouTube asks for a keyframe at least every 4 seconds; 2 is the recommended value.');

      const saveBtn = h('button', { class: 'btn primary', type: 'button' }, icon('save'), 'Save stream settings');
      saveBtn.onclick = () => busy(saveBtn, async () => {
        const body = { rtmpUrl: inputs.rtmpUrl.value, profile: inputs.profile.value, mode: inputs.mode.value, encoder: inputs.encoder.value, x264Preset: inputs.x264Preset.value, aspect: inputs.aspect.value, pixFmt: inputs.pixFmt.value, sampleRate: Number(inputs.sampleRate.value), gopSeconds: Number(inputs.gopSeconds.value),
          custom: { width: +inputs['c-width'].value, height: +inputs['c-height'].value, fps: +inputs['c-fps'].value, videoKbps: +inputs['c-videoKbps'].value, audioKbps: +inputs['c-audioKbps'].value } };
        await api('PUT', '/stream', body);
      }, 'Stream settings saved.');

      // ----- stream key (write-only) -----
      const keyState = h('div'); const keyInput = h('input', { type: 'password', id: 'st-key', autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste the stream key from YouTube Studio' });
      const keyDraw = (st) => mount(keyState, st.streamKeySet ? h('p', null, chip('Set', 'ok'), ' ', h('span', { class: 'mono' }, st.streamKeyMasked), h('span', { class: 'muted' }, st.keySource === 'env' ? '  (from the STREAM_KEY environment variable)' : '  (stored on the server only)')) : h('p', null, chip('Not set', 'warn')));
      keyDraw(s);
      const keySave = h('button', { class: 'btn primary', type: 'button' }, icon('key-round'), 'Save key');
      keySave.onclick = async () => { const r = await busy(keySave, () => api('PUT', '/stream/key', { key: keyInput.value }), 'Stream key saved. It is never shown again.'); if (r) { keyInput.value = ''; keyDraw(r.stream); } };
      const keyDel = h('button', { class: 'btn danger', type: 'button' }, 'Remove key');
      keyDel.onclick = async () => { if (await confirm({ title: 'Remove the stream key?', message: 'You will need to paste it again before going live.', confirmLabel: 'Remove key', danger: true })) { const r = await busy(keyDel, () => api('DELETE', '/stream/key'), 'Stream key removed.'); if (r) keyDraw(r.stream); } };

      // ----- benchmark -----
      const benchOut = h('div'); const benchBtn = h('button', { class: 'btn', type: 'button' }, icon('gauge'), 'Run encode benchmark');
      benchBtn.onclick = async () => {
        const r = await busy(benchBtn, () => api('POST', '/diagnostics/benchmark', null, { timeout: 60000 })); if (!r) return;
        mount(benchOut, r.ok ? h('div', { class: `banner ${r.verdict === 'comfortable' ? 'info' : 'warn'}` }, icon(r.verdict === 'comfortable' ? 'circle-check' : 'triangle-alert'), h('div', null, h('b', null, r.speed ? `${r.speed.toFixed(2)}× realtime (${r.verdict})` : 'Finished'), h('p', null, 'Measured with a synthetic test pattern at the selected profile and encoder. Complex footage and the scaling filter use more CPU, so keep a healthy margin above 1.0×; below about 1.3× is risky for a long live stream.'))) : h('div', { class: 'banner err' }, icon('circle-alert'), h('div', null, r.error)));
      };

      const requirements = h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Profile', 'CPU (software x264)', 'Upload bandwidth', 'Free RAM'].map((x) => h('th', null, x)))),
        h('tbody', null, [['720p / 30 fps', 'about 2 modern cores', '≥ 5 Mbps sustained', '≈ 1 GB'], ['1080p / 30 fps', 'about 4 modern cores, or a hardware encoder', '≥ 9 Mbps sustained', '≈ 1.5 GB'], ['1080p / 60 fps', '6+ fast cores, or a hardware encoder', '≥ 14 Mbps sustained', '≈ 2 GB']].map((r) => h('tr', null, r.map((c) => h('td', null, c)))))));

      mount(root,
        lockBanner,
        h('div', { class: 'grid cols-2 mb' },
          h('div', { class: 'grid' },
            card('Destination', h('div', null, url, h('div', { class: 'field' }, h('label', { for: 'st-key' }, 'Stream key'), keyState, h('div', { class: 'row' }, h('div', { class: 'spacer' }, keyInput), keySave, keyDel),
              h('p', { class: 'hint' }, 'The key is stored on the server and never sent back to this page. Keep it private; if it is ever exposed, reset it in YouTube Studio.')))),
            card('Disk and bandwidth guide', h('div', null, requirements, h('p', { class: 'hint' }, 'Rules of thumb only. Real needs depend on your footage and hardware, and nothing here guarantees a fixed quality or latency. Run the benchmark below to measure your machine. Codespaces machines are small: start with 720p or stream copy.'), h('div', { class: 'row' }, benchBtn), benchOut))),
          card('Output', h('div', null, profile, customBox, mode, enc, preset, aspect, pix, sr, gop, h('div', { class: 'row end' }, saveBtn)))));

      const update = (st) => {
        const locked = !['idle', 'error'].includes(st.engine.state);
        mount(lockBanner, locked ? h('div', { class: 'banner warn' }, icon('triangle-alert'), h('div', null, 'The broadcast is running, so stream settings are locked. Stop it to make changes.')) : null);
        Object.values(inputs).forEach((el) => { el.disabled = locked; }); saveBtn.disabled = keySave.disabled = locked; keyDel.disabled = locked || s.keySource === 'env'; benchBtn.disabled = locked;
        if (!locked) Object.values(inputs).forEach((el) => { if (el.options) [...el.options].forEach((o) => { if (encInfo[o.value]) o.disabled = true; }); });
      };
      syncCustom(); if (PO.state.status) update(PO.state.status);
      return { update };
    },
  };

  // ---------------- Logs ----------------
  PO.views.logs = {
    title: 'Logs',
    async render(root) {
      let level = 'info', q = ''; let follow = true; let entries = [];
      const box = h('div', { class: 'logbox', tabindex: '0', role: 'log', 'aria-live': 'off', 'aria-label': 'Log output' });
      const lvl = h('select', { 'aria-label': 'Minimum level' }, [['debug', 'Debug and above'], ['info', 'Info and above'], ['warn', 'Warnings and errors'], ['error', 'Errors only']].map(([v, l]) => h('option', { value: v, selected: v === level }, l)));
      const search = h('input', { type: 'search', placeholder: 'Filter log text', 'aria-label': 'Filter log text' });
      const followBox = h('input', { type: 'checkbox', checked: true, id: 'lg-follow' });
      const rank = { debug: 0, info: 1, warn: 2, error: 3 };
      const line = (e) => h('div', { class: `logline lv-${e.level}` }, h('span', { class: 'faint' }, fmt.time(e.ts)), h('span', null, e.level.toUpperCase()), h('span', { class: 'faint' }, e.source), h('span', { class: 'm' }, e.message));
      const matches = (e) => rank[e.level] >= rank[level] && (!q || (e.message + e.source).toLowerCase().includes(q));
      const scroll = () => { if (follow) box.scrollTop = box.scrollHeight; };
      const load = async () => { const r = await api('GET', `/logs?level=${level}&q=${encodeURIComponent(q)}&limit=600`); entries = r.entries; mount(box, entries.length ? entries.map(line) : empty('scroll-text', 'No log lines match', 'Lower the level or clear the filter.')); scroll(); };
      lvl.onchange = () => { level = lvl.value; load().catch(err); };
      let t; search.oninput = () => { clearTimeout(t); t = setTimeout(() => { q = search.value.toLowerCase(); load().catch(err); }, 250); };
      followBox.onchange = () => { follow = followBox.checked; scroll(); };
      mount(root, h('div', { class: 'row mb' }, h('div', null, lvl), h('div', { class: 'spacer' }, search), h('label', { class: 'check', for: 'lg-follow' }, followBox, 'Follow new lines'),
        h('a', { class: 'btn', href: '/api/logs/download', download: 'playout-log.txt' }, icon('download'), 'Download'), h('button', { class: 'btn', type: 'button', onclick: () => { entries = []; mount(box, empty('scroll-text', 'View cleared', 'New lines will appear here. The server log is unchanged.')); } }, 'Clear view')),
        h('div', { class: 'card' }, box), h('p', { class: 'hint' }, 'Stream keys and credentials are redacted before they reach this log.'));
      await load().catch(err);
      PO.onLog = (e) => { if (!matches(e)) return; if (!entries.length) box.replaceChildren(); entries.push(e); box.append(line(e)); while (box.children.length > 800) box.firstChild.remove(); scroll(); };
      return { destroy() { PO.onLog = null; clearTimeout(t); } };
    },
  };

  // ---------------- Diagnostics ----------------
  PO.views.diagnostics = {
    title: 'Diagnostics',
    async render(root) {
      mount(root, card('Diagnostics', skeleton(5)));
      let d; try { d = await api('GET', '/diagnostics'); } catch (e) { err(e); return; }
      const kv = (pairs) => h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
      const encRows = Object.entries(d.encoders.encoders || {}).map(([k, v]) => h('tr', null, h('td', null, h('span', { class: 'mono' }, k)), h('td', null, v.hardware ? 'Hardware' : 'Software'), h('td', null, v.available ? chip('Works', 'ok') : chip('Unavailable', 'warn')), h('td', { class: 'muted' }, v.reason || 'Passed a real test encode')));
      mount(root,
        h('div', { class: 'row mb' }, h('span', { class: 'muted' }, `Generated ${fmt.dateTime(d.generatedAt)}`), h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: () => PO.views.diagnostics.render(root) }, icon('rotate-cw'), 'Re-run'), h('a', { class: 'btn primary', href: '/api/diagnostics/export', download: 'playout-diagnostics.json' }, icon('download'), 'Export (secrets redacted)')),
        d.configProblems.length ? h('div', { class: 'banner warn mb' }, icon('triangle-alert'), h('div', null, h('b', null, 'Configuration problems'), h('ul', null, d.configProblems.map((p) => h('li', null, p))))) : h('div', { class: 'banner info mb' }, icon('shield-check'), h('div', null, 'Configuration is valid.')),
        h('div', { class: 'grid cols-2 mb' },
          card('Binaries', kv([['FFmpeg', d.binaries.ffmpeg.ok ? `${d.binaries.ffmpeg.version} (${d.binaries.ffmpeg.path})` : d.binaries.ffmpeg.error], ['FFprobe', d.binaries.ffprobe.ok ? `${d.binaries.ffprobe.version} (${d.binaries.ffprobe.path})` : d.binaries.ffprobe.error], ['AAC encoder', d.encoders.aac ? 'Available' : 'Missing']])),
          card('System', kv([['Platform', `${d.system.platform} (${d.system.arch})`], ['CPU', `${d.system.cpuCount} × ${d.system.cpuModel || 'unknown'}`], ['Memory', `${d.system.memTotalMB} MB`], ['Node.js', d.system.node], ['Environment', d.system.codespaces ? 'GitHub Codespaces' : 'Local / server'], ['Media disk', d.disk ? `${fmt.bytes(d.disk.freeBytes)} free of ${fmt.bytes(d.disk.totalBytes)}` : 'Unknown']]))),
        card('Encoders', h('div', null, h('p', { class: 'muted' }, d.hardwareNote), h('div', { class: 'scroll-x' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['Encoder', 'Type', 'Status', 'Detail'].map((x) => h('th', null, x)))), h('tbody', null, encRows)))), { flush: false }),
        h('div', { class: 'mb' }),
        card('Playlist checks', d.playlist.issues.length ? h('ul', null, d.playlist.issues.map((i) => h('li', { class: 'row' }, chip(i.level, i.level === 'error' ? 'err' : i.level === 'warn' ? 'warn' : ''), h('span', null, i.message)))) : h('p', null, 'No issues found.')),
        h('div', { class: 'mb' }),
        card('Recent log lines (redacted)', h('pre', { class: 'mono small' }, d.recentLog.slice(-25).join('\n') || 'No log lines yet.')));
    },
  };

  // ---------------- Settings ----------------
  PO.views.settings = {
    title: 'Settings',
    async render(root) {
      mount(root, card('Settings', skeleton(4)));
      let d; try { d = await api('GET', '/settings'); } catch (e) { err(e); return; }
      const S = d.settings; const inp = {};
      const f = (key, label, el, hint) => { inp[key] = el; el.id = `se-${key}`; return h('div', { class: 'field' }, h('label', { for: el.id }, label), el, hint ? h('p', { class: 'hint' }, hint) : null); };
      const n = (v, lo, hi) => h('input', { type: 'number', value: String(v), min: lo, max: hi, step: '1' });
      const sel = (opts, val) => h('select', null, opts.map(([v, l]) => h('option', { value: v, selected: v === val }, l)));
      const save = h('button', { class: 'btn primary', type: 'button' }, icon('save'), 'Save settings');
      save.onclick = () => busy(save, async () => {
        const patch = Object.fromEntries(Object.entries(inp).map(([k, el]) => [k, el.tagName === 'SELECT' ? el.value : Number(el.value)]));
        const saved = await api('PUT', '/settings', patch);
        if (saved.settings?.theme) PO.applyTheme(saved.settings.theme);
        return saved;
      }, 'Settings saved.');
      mount(root, h('div', { class: 'grid cols-2' },
        card('Media and storage', h('div', null, f('maxUploadMB', 'Upload size limit (MB)', n(S.maxUploadMB, 1, 51200)), f('maxImportMB', 'Link import size limit (MB)', n(S.maxImportMB, 1, 51200)), f('minFreeDiskMB', 'Keep this much disk free (MB)', n(S.minFreeDiskMB, 0, 1048576), 'Uploads and imports are refused if they would leave less than this free.'))),
        card('Reliability', h('div', null, f('maxRetries', 'Reconnect attempts before giving up', n(S.maxRetries, 0, 50)), f('backoffBaseSec', 'First retry delay (seconds)', n(S.backoffBaseSec, 1, 60), 'Each further attempt doubles the delay.'), f('backoffMaxSec', 'Longest retry delay (seconds)', n(S.backoffMaxSec, 1, 600)),
          f('onItemFail', 'When a playlist item fails', sel([['skip', 'Skip it and continue'], ['stop', 'Stop the broadcast']], S.onItemFail)), f('onPlaylistEnd', 'When the playlist ends (repeat off)', sel([['stop', 'Stop the broadcast'], ['restart', 'Start again from the top']], S.onPlaylistEnd)))),
        card('Interface and logs', h('div', null, f('logRetention', 'Log lines kept in memory', n(S.logRetention, 200, 20000)), f('statusIntervalMs', 'Dashboard refresh (ms)', n(S.statusIntervalMs, 1000, 10000)), f('theme', 'Theme', sel([['dark', 'Dark'], ['light', 'White'], ['skyblue', 'Sky blue']], S.theme || 'dark')))),
        card('Access and security', h('div', null, kv2([['Login credential source', d.auth.credentialSource], ['Listening on', `${d.server.host}:${d.server.port}`], ['Login', 'Use the configured server credentials']]),
          h('p', { class: 'muted' }, 'Keep the dashboard port private. In Codespaces leave it set to Private; never make an unauthenticated admin tool public. If a stream key may have leaked, reset it in YouTube Studio and paste the new one under Stream Settings.'),
          h('button', { class: 'btn', type: 'button', onclick: () => PO.logout() }, icon('log-out'), 'Sign out')))),
        h('div', { class: 'row end' }, save));
      function kv2(pairs) { return h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])); }
    },
  };
})();
