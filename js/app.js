// StreamScope UI: file intake → sessions table → session detail (range, markers, charts, benchmark,
// client stats, diagnostics) → history & compare.
(() => {
  // Version = the ?v= stamp on this script tag (bumped on every release), shown so stale caches are easy to spot.
  {
    const v = ((document.currentScript && document.currentScript.src.match(/[?&]v=(\d+)/)) || [])[1];
    const el = document.getElementById('appVersion');
    if (el && v) el.textContent = 'wersja ' + v.replace(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)$/, '$1-$2-$3 $4:$5');
  }
  const $ = s => document.querySelector(s);
  const { fmt: tfmt, parse: tparse, clock, date } = SS.time;
  const { num, esc } = SS.fmt;
  const DIAG_OPTS = { trimStart: 60, trimEnd: 20 };
  const statusLabel = { ok: 'Czysta', warn: 'Uwagi', crit: 'Problem' };

  const state = {
    hosts: new Map(), logs: new Map(), diag: new Map(), steam: new Map(), steamSel: new Map(), hidden: new Set(),
    agent: null, fileIndex: new Map(), traces: new Map(), streamtweak: null, compareWith: null,
    sessions: [], selected: null, ranges: new Map(), timeBase: 'client', compare: new Set(),
    filter: (() => { try { return localStorage.getItem('streamscope.filter') || 'all'; } catch (e) { return 'all'; } })()
  };

  // ---------- file intake ----------
  // Parses one file into state. Returns { key, kind } when added, throws with a user-facing reason otherwise.
  function ingest(n, text, msgs) {
    // Only .json files (or extension-less text that starts with "{") go to the JSON path; plain-text logs
    // often start with "[timestamp]" and must not be reported as broken JSON.
    if (/^\s*\[/.test(text.slice(0, 20)) && /"RttTimeSeries"|"QualityStats"/.test(text.slice(0, 200000))) {
      // StreamTweak history: replaces any earlier copy (it is one growing file).
      state.streamtweak = SS.parseStreamTweak(n, text);
      return { key: 'w:streamtweak', kind: 'streamtweak' };
    }
    if (/\.json$/i.test(n) || (!/\.(log|txt|csv)$/i.test(n) && /^\s*\{/.test(text.slice(0, 50)))) {
      if (/^CapFrameX/i.test(n) || /"Runs"\s*:/.test(text.slice(0, 4000))) throw new Error('CapFrameX jeszcze nieobsługiwany');
      if (/"schema"\s*:\s*"streamscope-client-trace"/.test(text.slice(-4000)) || /"schema":"streamscope-client-trace"/.test(text)) {
        // Per-second client timeline the agent builds from Moonlight's VRR diagnostic capture (.vrrtrace).
        const t = JSON.parse(text);
        if (!Array.isArray(t.t) || !t.first_frame_unix) throw new Error('niepełne podsumowanie vrrtrace');
        t.name = n;
        state.traces.set(n, t);
        return { key: 't:' + n, kind: 'trace' };
      }
      const h = SS.parseVibepollo(n, text);
      if (state.hosts.has(h.key)) throw new Error(`duplikat ${state.hosts.get(h.key).name}`);
      h.gameplay = SS.Gameplay.detect(h);
      state.hosts.set(h.key, h);
      state.diag.set(h.key, SS.Diag.analyze(h, DIAG_OPTS));
      if (h.truncated) msgs.push(`${n}: Vibepollo obciął próbki lub zdarzenia (samples_truncated).`);
      return { key: 'h:' + h.key, kind: 'host' };
    }
    if (/(StreamLight|Moonlight)-\d+/i.test(n) || /SDL Info \(\d+\)|Global video stats/.test(text.slice(0, 200000))) {
      const c = SS.parseClientLog(n, text);
      if (state.logs.has(c.key)) throw new Error('duplikat');
      if (!c.streams.length) throw new Error('log bez żadnego streamu (tylko uruchomienie aplikacji)');
      if (c.epoch == null) msgs.push(`${n}: brak czasu uniksowego w nazwie pliku, nie da się go zsynchronizować z hostem.`);
      state.logs.set(c.key, c);
      return { key: 'c:' + c.key, kind: 'client' };
    }
    if (/streaming_log/i.test(n) || /"SessionStats"|\] Streaming started to /.test(text.slice(0, 2000000))) {
      const st = SS.parseSteamLog(n, text);
      if (!st.conns.length) throw new Error('log Steama bez sesji Remote Play (np. log z klienta albo bez statystyk)');
      // A newer streaming_log.txt is a superset of the old one: same name replaces, connections dedupe by start.
      state.steam.set(st.key, st);
      return { key: 's:' + st.key, kind: 'steam' };
    }
    throw new Error('nieobsługiwany format');
  }

  async function addFiles(list) {
    const msgs = [], skipped = [];
    let added = 0, unsaved = 0;
    for (const file of list) {
      const n = file.name;
      if (file.size > 80 * 1024 * 1024) { skipped.push(`${n}: za duży`); continue; }
      if (/\.csv$/i.test(n)) { skipped.push(`${n}: PresentMon/CSV jeszcze nieobsługiwany`); continue; }
      try {
        const text = await file.text();
        const r = ingest(n, text, msgs);
        added++;
        try { await SS.Store.putFile({ key: r.key, kind: r.kind, name: n, text }); } catch (e) { unsaved++; }
      } catch (e) { skipped.push(`${n}: ${e.message}`); }
    }
    if (unsaved) msgs.push(`Nie udało się zapisać ${unsaved} plików w pamięci przeglądarki; po zamknięciu strony trzeba je będzie wczytać ponownie.`);
    const head = `Dodano ${added} z ${list.length} ${list.length === 1 ? 'pliku' : 'plików'}.${skipped.length ? ` Pominięto ${skipped.length}:` : ''}`;
    notice([head, ...skipped.map(x => '• ' + x), ...msgs].join('\n'), skipped.length && !added ? 'err' : added ? 'ok' : '');
    if (added) { state.selected = null; SS.Store.persist(); }
    rebuild();
    storageInfo();
  }

  // Startup: bring back every file and range saved in earlier visits (this browser, or the agent's archive).
  async function restore() {
    const agent = await SS.Store.detectAgent();
    if (agent) {
      state.agent = agent;
      $('#clearBtn').hidden = true;   // the archive belongs to the agent; single sessions can still be hidden
      $('#tabSettings').hidden = false;
      await SS.History.useAgent().catch(() => {});
      renderHistory();
    }
    let files = [], ranges = [];
    try { [files, ranges] = await Promise.all([SS.Store.allFiles(), SS.Store.allRanges()]); }
    catch (e) {
      notice(agent ? 'Nie udało się pobrać plików z agenta.' : 'Pamięć przeglądarki jest niedostępna (np. tryb prywatny). Wczytane pliki nie zostaną zapamiętane.', 'err');
      return;
    }
    ranges.forEach(r => {
      if (r.hidden) state.hidden.add(r.id);
      else if (r.segs) state.steamSel.set(r.id, new Set(r.segs));
      else state.ranges.set(r.id, { a: r.a, b: r.b, trimMin: r.trimMin || 0 });
    });
    const msgs = [];
    files.sort((a, b) => a.savedAt - b.savedAt).forEach(f => loadArchived(f, msgs));
    if (files.length) rebuild();
    storageInfo();
  }

  // Agent archive bookkeeping: id → { size, mtime, key } so changed files (a growing log) are re-parsed.
  function loadArchived(f, msgs) {
    let key = null;
    try { key = ingest(f.name, f.text, msgs).key; } catch (e) { /* duplicate or unsupported: remember it anyway */ }
    if (f.id) state.fileIndex.set(f.id, { size: f.size, mtime: f.mtime, key });
  }
  function unload(key) {
    if (!key) return;
    const k = key.slice(2);
    if (key[0] === 'h') { state.hosts.delete(k); state.diag.delete(k); }
    else if (key[0] === 'c') state.logs.delete(k);
    else if (key[0] === 's') state.steam.delete(k);
    else if (key[0] === 't') state.traces.delete(k);
    else if (key[0] === 'w') state.streamtweak = null;
  }
  let polling = false;
  async function pollAgent() {
    if (polling) return;
    polling = true;
    try {
      const list = await SS.Store.listFiles();
      let changed = 0;
      for (const f of list) {
        const prev = state.fileIndex.get(f.id);
        if (prev && prev.size === f.size && prev.mtime === f.mtime) continue;
        if (prev) unload(prev.key);
        loadArchived({ ...f, text: await SS.Store.readFile(f.id) }, []);
        changed++;
      }
      state.agent = await SS.Store.info();
      if (changed) { rebuild(); if (!$('#viewHistory').hidden) renderHistory(); }
      storageInfo();
    } catch (e) { /* agent briefly unreachable (PC asleep): try again next minute */ }
    polling = false;
  }

  async function storageInfo() {
    const el = $('#storeInfo'); if (!el) return;
    if (state.agent) { el.innerHTML = agentStatusHtml(); const b = $('#collectBtn'); if (b) b.onclick = collectNow; return; }
    const n = state.hosts.size + state.logs.size + state.steam.size;
    const u = await SS.Store.usage();
    const word = n === 1 ? 'plik' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'pliki' : 'plików';
    el.textContent = n ? `Zapamiętane w tej przeglądarce: ${n} ${word}${u && u.usage ? ` (${num(u.usage / 1048576, 1)} MB)` : ''}. Wczytają się same przy następnym otwarciu.` : '';
  }

  const SOURCE_LABEL = { vibepollo: 'Vibepollo', steam: 'Steam', client: 'Logi K12', watch: 'Obserwacja K12', vrr: 'Diagnostyka VRR', vrr_watch: 'Obserwacja VRR', streamtweak: 'StreamTweak' };
  function agentStatusHtml() {
    const a = state.agent, src = a.sources || {};
    const items = Object.keys(SOURCE_LABEL).filter(k => src[k]).map(k => {
      const s = src[k];
      return `<span class="chip ${s.ok ? 'good' : 'bad'}" title="${esc(s.msg)}">${SOURCE_LABEL[k]}: ${esc(s.ok ? s.msg.replace(/^OK,?\s*/, '') || 'OK' : s.msg)}</span>`;
    }).join(' ');
    return `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
      <button class="primary small" type="button" id="collectBtn" ${a.running ? 'disabled' : ''}>${a.running ? 'Agent pobiera dane…' : 'Pobierz nowe dane'}</button>
      <span><b>Agent na ${esc(a.host)}</b> · ${a.files} plików w archiwum${a.last_run ? ` · ostatnie pobranie ${shortDate(a.last_run)}` : ''}. Logi K12 dochodzą same po uruchomieniu i zamknięciu StreamLighta; Vibepollo i Steam pobiera przycisk.</span>
      ${items}</div>`;
  }
  async function collectNow() {
    const b = $('#collectBtn'); if (b) { b.disabled = true; b.textContent = 'Pobieram…'; }
    try { await SS.Store.collectNow(); } catch (e) { /* agent unreachable: status below shows the last known state */ }
    await pollAgent();
  }

  function notice(msg, kind) {
    const n = $('#notice');
    n.hidden = !msg; n.className = 'notice' + (kind ? ' ' + kind : ''); n.textContent = msg || '';
  }

  function rebuild() {
    const steamById = new Map();
    for (const f of state.steam.values()) for (const c of f.conns) {
      const id = 's:' + c.key;
      // The same connection can appear in streaming_log.txt and .previous.txt; keep the more complete copy.
      if (!steamById.has(id) || steamById.get(id).steam.segments.length < c.segments.length) {
        steamById.set(id, { id, steam: c, sdiag: SS.steamDiag(c), file: f, host: null, clients: [], markers: [], events: [], log: null, clientBase: null, offset: 0, t0: c.u0, t1: c.u1, app: c.game });
      }
    }
    state.sessions = SS.Session.build([...state.hosts.values()], [...state.logs.values()], [...state.traces.values()],
      state.streamtweak ? state.streamtweak.sessions : [])
      .concat([...steamById.values()])
      .filter(s => !state.hidden.has(s.id))
      .sort((a, b) => b.t0 - a.t0);
    if (!state.sessions.find(s => s.id === state.selected)) {
      const paired = state.sessions.find(s => s.host && s.clients.length);
      state.selected = (paired || state.sessions[0] || {}).id || null;
    }
    renderSessions();
    renderDetail();
    renderSideBySide();
  }

  const current = () => state.sessions.find(s => s.id === state.selected);
  const diagOf = s => s && s.host ? state.diag.get(s.host.key) : null;

  // ---------- sessions table ----------
  function modeOf(s) {
    if (s.steam) {
      const c = s.steam, g = c.segments[c.segments.length - 1], mc = c.maxCapture;
      return `${shortEnc(g.encoder)} ${mc ? `${mc.w}×${mc.h}@${Math.round(g.fpsLimit || mc.fps)}` : ''} ${g.bandwidthLimitKbps ? num(g.bandwidthLimitKbps / 1000, 0) + ' Mb/s' : ''}`.trim();
    }
    if (!s.host && !s.clients.length && s.st) {
      const q = s.st.stats, enc = (s.st.streams[0] || {}).encoder || '';
      return `${enc} ${q.TargetFps ? '@' + q.TargetFps : ''} ${q.TargetBitrateMbps ? num(q.TargetBitrateMbps, 0) + ' Mb/s' : ''}`.trim() || '—';
    }
    const h = s.host, st = s.clients[0] && s.clients[0].stream;
    const w = h ? h.width : st && st.width, hh = h ? h.height : st && st.height;
    const fps = h ? h.target : st && st.fps, codec = (h && h.codec) || (st && st.codec) || '';
    return w ? `${codec} ${w}×${hh}@${fps}` : '—';
  }
  function clientCell(s) {
    if (s.steam) return `Steam → ${esc(s.steam.client)}`;
    if (!s.clients.length && s.st) return 'StreamLight <span class="muted small">(StreamTweak)</span>';
    if (!s.clients.length) return '<span class="muted">—</span>';
    const names = [...new Set(s.clients.map(c => c.log.client))].join(', ');
    const n = s.clients.length > 1 ? ` ×${s.clients.length}` : '';
    const off = s.host && s.log ? ` <span class="muted small">(${s.offset >= 0 ? '+' : ''}${num(s.offset, 1)} s)</span>` : '';
    return `${esc(names)}${n}${off}`;
  }
  const plural = (n, one, few, many) => n === 1 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
  const kindOf = s => s.steam ? 'steam' : 'sunshine';
  const shortDate = u => new Date(u * 1000).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
  function renderSessions() {
    const body = $('#sessBody');
    const all = state.sessions;
    const counts = { all: all.length, sunshine: all.filter(s => kindOf(s) === 'sunshine').length, steam: all.filter(s => s.steam).length };
    if (!counts[state.filter]) state.filter = 'all';
    document.querySelectorAll('#sessFilter [data-f]').forEach(b => {
      const f = b.dataset.f;
      b.setAttribute('aria-pressed', f === state.filter);
      b.textContent = `${{ all: 'Wszystkie', sunshine: 'Vibepollo / Moonlight', steam: 'Steam' }[f]} (${counts[f]})`;
      b.disabled = !counts[f];
    });
    const S = state.filter === 'all' ? all : all.filter(s => kindOf(s) === state.filter);
    $('#sessCount').textContent = all.length ? `${state.hosts.size} ${plural(state.hosts.size, 'plik', 'pliki', 'plików')} Vibepollo · ${state.logs.size} ${plural(state.logs.size, 'log', 'logi', 'logów')} klienta${state.steam.size ? ` · ${state.steam.size} ${plural(state.steam.size, 'log', 'logi', 'logów')} Steama` : ''}` : '';
    const hi = $('#hiddenInfo');
    hi.hidden = !state.hidden.size;
    if (state.hidden.size) {
      hi.innerHTML = `Ukryte sesje: ${state.hidden.size} · <button class="small" type="button" id="unhideBtn">Przywróć wszystkie</button>`;
      $('#unhideBtn').onclick = restoreHidden;
    }
    if (!S.length) { body.innerHTML = `<tr><td colspan="7" class="empty">Brak plików. Przeciągnij pliki powyżej.</td></tr>`; return; }
    const row = (s, pill, fps, tags) => `<tr class="pick${s.id === state.selected ? ' sel' : ''}" data-id="${esc(s.id)}" tabindex="0">
        <td>${pill}</td>
        <td class="num">${scoreChip(sessionScore(s))}</td>
        <td><div class="app">${esc(s.app)}</div><div class="mono small muted">${esc(modeOf(s))}</div></td>
        <td class="mono"><div style="white-space:nowrap">${shortDate(s.t0)}</div><div class="small muted">${tfmt(s.t1 - s.t0)}</div></td>
        <td>${clientCell(s)}</td>
        <td class="num">${fps}</td>
        <td class="small tags">${esc(tags)}</td></tr>`;
    body.innerHTML = S.map(s => {
      if (s.steam) {
        const sum = SS.steamSummary(steamSegs(s));
        const sd = s.sdiag;
        const tags = sd.findings.filter(x => x.sev !== 'info').map(x => x.title).join(' · ') || 'brak';
        return row(s, `<span class="pill ${sd.status}">Steam · ${statusLabel[sd.status]}</span>`, `${num(sum.fps, 0)}`, tags);
      }
      if (!s.host && !s.clients.length && s.st) {
        const sc = sessionScore(s);
        return row(s, '<span class="pill raw">StreamTweak</span>', `${num(s.st.stats.FpsAvg, 0)} <span class="muted small">klient</span>`, sc ? sc.reason : '');
      }
      const d = diagOf(s);
      const tags = d ? d.findings.filter(f => f.sev !== 'info').map(f => f.title).join(' · ') || 'brak' : '';
      const fps = d ? `${num(d.stats.baseline, 0)} <span class="muted small">/ ${s.host.target}</span>` : (s.clients[0].stream.stats ? `${num(s.clients[0].stream.stats.incoming, 0)} <span class="muted small">klient</span>` : '—');
      return row(s, d ? `<span class="pill ${d.status}">${statusLabel[d.status]}</span>` : '<span class="pill raw">bez hosta</span>', fps, tags);
    }).join('');
    body.querySelectorAll('tr.pick').forEach(tr => {
      const pick = () => { state.selected = tr.dataset.id; renderSessions(); renderDetail(); $('#detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      tr.addEventListener('click', pick);
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
  }

  // ---------- time base & range ----------
  const useClientBase = s => state.timeBase === 'client' && s.clientBase != null;
  const base0 = s => useClientBase(s) ? s.clientBase : s.t0;
  const fmtU = (s, u) => tfmt(u - base0(s));
  const baseName = s => useClientBase(s) ? `czas ${s.log.client}` : 'czas od startu pliku hosta';

  function rangeOf(s) {
    if (!state.ranges.has(s.id)) state.ranges.set(s.id, { ...SS.Session.defaultRange(s), trimMin: 0 });
    return state.ranges.get(s.id);
  }
  function effRange(s) {
    const r = rangeOf(s);
    const b = Math.max(r.a + 1, r.b - (r.trimMin || 0) * 60);
    return { a: r.a, b };
  }
  function setRange(s, patch) {
    const r = rangeOf(s);
    Object.assign(r, patch);
    r.a = Math.max(s.t0 - 60, Math.min(r.a, s.t1));
    r.b = Math.max(r.a + 1, Math.min(r.b, s.t1 + 60));
    SS.Store.putRange({ id: s.id, a: r.a, b: r.b, trimMin: r.trimMin || 0 }).catch(() => {});
    updateRangeViews();
    renderSessions();   // the table's score follows the chosen range
    if (state.compareWith) renderSideBySide();
  }

  // Bring back sessions hidden with "Usuń sesję z pamięci" (agent mode / Steam keep files and only hide).
  async function restoreHidden() {
    const ids = [...state.hidden];
    state.hidden.clear();
    await Promise.all(ids.map(id => SS.Store.deleteRange(id).catch(() => {})));
    rebuild();
  }

  // Forget one session: its host file plus client logs that pair with nothing else.
  async function removeSession(s) {
    if (!confirm(`Usunąć sesję „${s.app}” z ${date(s.t0)} z pamięci przeglądarki? Zapisane podsumowania w Historii zostaną.`)) return;
    if (s.steam || state.agent) {
      // One Steam log holds many connections, and the agent would re-collect deleted files from their
      // sources, so the session is hidden (remembered) rather than deleting any file.
      state.hidden.add(s.id);
      await SS.Store.putRange({ id: s.id, hidden: true }).catch(() => {});
      state.selected = null; rebuild(); return;
    }
    const keys = [];
    if (s.host) { state.hosts.delete(s.host.key); state.diag.delete(s.host.key); keys.push('h:' + s.host.key); }
    for (const log of new Set(s.clients.map(c => c.log))) {
      const usedElsewhere = state.sessions.some(o => o !== s && o.clients.some(c => c.log === log));
      if (!usedElsewhere) { state.logs.delete(log.key); keys.push('c:' + log.key); }
    }
    state.ranges.delete(s.id);
    await Promise.all(keys.map(k => SS.Store.deleteFile(k).catch(() => {})));
    state.selected = null;
    rebuild(); storageInfo();
  }

  // ---------- Steam Remote Play ----------
  // PyroWave encodes with GPU compute, so the NVENC encoder utilisation says nothing about it.
  const isPyro = s => /pyro/i.test((s.host && s.host.codec) || '') || (s.clients || []).some(c => /pyro/i.test(c.stream.codec || '')) || !!(s.steam && (s.steam.segments.at(-1) || {}).pyrowave);
  const shortEnc = e => (e || '?').replace(/\s*\[.*\]$/, '').replace(/^Pyrowave\b/i, 'PyroWave');
  // Default benchmark set: game-capture segments of meaningful length (desktop/menu segments skew FPS).
  function steamSelection(s) {
    if (!state.steamSel.has(s.id)) {
      const segs = s.steam.segments;
      let pick = segs.map((g, i) => (g.source === 'gra' && g.dur >= 20 ? i : -1)).filter(i => i >= 0);
      if (!pick.length) pick = segs.map((g, i) => (g.dur > 0 ? i : -1)).filter(i => i >= 0);
      state.steamSel.set(s.id, new Set(pick));
    }
    return state.steamSel.get(s.id);
  }
  const steamSegs = s => { const sel = steamSelection(s); return s.steam.segments.filter((_, i) => sel.has(i)); };
  const SLOW_LABEL = { game: 'gra', capture: 'przechwytywanie', convert: 'konwersja', encode: 'enkodowanie', network: 'sieć', decode: 'dekodowanie', display: 'wyświetlanie' };
  function steamBottlenecks(sum) {
    return Object.entries(sum.slow).filter(([, v]) => v != null && v >= 1).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `wolne: ${SLOW_LABEL[k]} ${num(v, 1)}%`).join(' · ');
  }

  function renderSteamDetail(el, s) {
    const c = s.steam, segs = c.segments, sel = steamSelection(s);
    const sum = SS.steamSummary(steamSegs(s));
    const last = segs[segs.length - 1];
    const bitrates = [...new Set(c.bitrates.map(b => b.kbps))].map(k => num(k / 1000, 0) + ' Mb/s').join(' → ');
    const chips = [date(c.u0), tfmt(c.u1 - c.u0), modeOf(s), `dekoder: ${last.decoder || '?'}`, `adres klienta ${c.addr}`];
    const slowTimes = c.slow.length ? c.slow : [];
    const bogus = segs.some(g => g.displayBogus);
    el.innerHTML = `
      <section class="panel" aria-labelledby="dTitle">
        <div class="panel-head">
          <div style="display:grid;gap:6px;min-width:0">
            <div class="eyebrow">Sesja Steam Remote Play</div>
            <h2 id="dTitle">${esc(s.app)} <span class="muted" style="font-weight:500">· Steam → ${esc(c.client)}</span></h2>
            <div class="chips">${chips.map(x => `<span class="chip">${esc(x)}</span>`).join('')}${last.pyrowave ? '<span class="chip good">PyroWave</span>' : ''}</div>
            ${bitrates ? `<div class="muted small">Docelowy bitrate ustawiany przez Steam: ${esc(bitrates)}</div>` : ''}
          </div>
          <div class="actions"><button class="small" type="button" data-compare>Porównaj z…</button><button class="small" type="button" id="removeBtn">Usuń sesję z pamięci</button></div>
        </div>
        <p class="caveat">Steam zapisuje tylko podsumowania odcinków (nowy odcinek przy każdej zmianie przechwytywania, np. pulpit ↔ gra), bez próbek co kilka sekund. Dlatego zamiast wykresu i zakresu czasu wybierasz odcinki, a średnie są ważone ich długością.</p>
      </section>
      <section class="panel" aria-labelledby="sgTitle">
        <div class="panel-head"><h2 id="sgTitle">Odcinki</h2><span class="muted small">Zaznacz odcinki do benchmarku. Domyślnie: przechwytywanie gry, min. 20 s.</span></div>
        <div class="tablewrap"><table>
          <thead><tr><th></th><th class="num">Koniec</th><th class="num">Długość</th><th>Źródło</th><th>Enkoder</th><th class="num">Rozdz.</th><th class="num">FPS</th><th class="num">Ping</th><th class="num">Sieć</th><th class="num">Dekod.</th><th class="num">Wyśw.</th><th class="num">Bitrate</th><th>Wolne &gt; 1%</th></tr></thead>
          <tbody>${segs.map((g, i) => `<tr>
            <td><input type="checkbox" data-sg="${i}" ${sel.has(i) ? 'checked' : ''} aria-label="Uwzględnij odcinek ${i + 1}"></td>
            <td class="num">${clock(g.u1)}</td><td class="num">${tfmt(g.dur)}</td><td>${g.source}</td><td class="small">${esc(shortEnc(g.encoder))}</td>
            <td class="num small">${g.width ? `${g.width}×${g.height}` : '—'}</td>
            <td class="num">${num(g.fps, 1)}</td><td class="num">${num(g.pingMs, 1)}</td><td class="num">${num(g.networkMs, 1)}</td><td class="num">${num(g.decodeMs, 2)}</td>
            <td class="num">${g.displayMs == null ? (g.displayBogus ? '<span class="muted">bł.</span>' : '—') : num(g.displayMs, 2)}</td>
            <td class="num">${num(g.serverMbps, 0)}</td>
            <td class="small">${esc(Object.entries(g.slow).filter(([, v]) => v >= 1).map(([k, v]) => `${SLOW_LABEL[k]} ${num(v, 1)}%`).join(', '))}</td></tr>`).join('')}</tbody>
        </table></div>
        ${bogus ? '<p class="caveat">„bł.” = Steam zapisał niemożliwy czas wyświetlania (ujemny albo w sekundach), pomijany w średnich.</p>' : ''}
      </section>
      <section class="panel" aria-labelledby="bTitle">
        <div class="panel-head"><h2 id="bTitle">Benchmark odcinków</h2><span class="muted small">${sum.n} odc., łącznie ${tfmt(sum.dur)}</span></div>
        ${sum.n ? scoreHtml(SS.Score.steam(steamSegs(s), sum)) : ''}
        ${sum.n ? `<div class="stats">
          ${stat('Śr. FPS (Steam)', num(sum.fps, 1), last.fpsLimit ? '/ ' + last.fpsLimit : '', true)}
          ${stat('Czas klatki śr.', num(sum.frameMs, 2), 'ms', true)}
          ${stat('Bitrate serwera śr.', num(sum.serverMbps, 1), 'Mb/s', true)}
          ${stat('Przepustowość łącza', num(sum.linkMbps, 0), 'Mb/s')}
          ${stat('Ping', num(sum.pingMs, 2), 'ms', true)}
          ${stat('Sieć (transfer klatki)', num(sum.networkMs, 2), 'ms')}
          ${stat('Przechwytywanie', num(sum.captureMs, 2), sum.captureMs == null ? 'nie mierzone' : 'ms')}
          ${stat('Konwersja', num(sum.convertMs, 2), sum.convertMs == null ? 'nie mierzone' : 'ms')}
          ${stat('Enkodowanie', num(sum.encodeMs, 2), sum.encodeMs == null ? 'nie mierzone' : 'ms')}
          ${stat('Dekodowanie', num(sum.decodeMs, 2), 'ms')}
          ${stat('Wyświetlanie', num(sum.displayMs, 2), 'ms')}
          ${Object.entries(sum.slow).map(([k, v]) => stat(`Wolne: ${SLOW_LABEL[k]}`, num(v, 2), '% czasu')).join('')}
        </div>` : '<p class="muted">Zaznacz przynajmniej jeden odcinek.</p>'}
        <p class="caveat">AvgFPS Steama to metryka streamu, nie FPS gry, a menu i ekrany ładowania go zaniżają. Przy PyroWave w przechwytywaniu gry Steam raportuje 0 ms dla przechwytywania, konwersji i enkodowania; takie zera są traktowane jako „nie mierzone”.</p>
      </section>
      <section class="panel" aria-labelledby="sdTitle">
        <div class="panel-head"><h2 id="sdTitle">Diagnostyka całej sesji</h2>
          <div class="actions"><span class="muted small">Analiza:</span><span class="pill ${s.sdiag.status}">${statusLabel[s.sdiag.status]}</span></div></div>
        <div class="findings">${(s.sdiag.findings.length ? s.sdiag.findings : [{ sev: 'ok', title: 'Nic nie wymaga uwagi', text: 'Brak istotnych wąskich gardeł, FPS blisko limitu, ping i bitrate w normie.' }])
          .map(x => `<div class="finding ${x.sev}"><span class="bar"></span><div><h3>${esc(x.title)}</h3><p>${esc(x.text)}</p></div></div>`).join('')}</div>
        <p class="caveat">Ocena obejmuje wszystkie odcinki połączenia (wąskie gardła, FPS i sieć liczone z odcinków gry, jeśli są), niezależnie od zaznaczenia powyżej.</p>
      </section>
      ${slowTimes.length ? `<section class="panel"><details><summary>Zdarzenia „Slow framerate” (${slowTimes.length})</summary><div class="tablewrap"><table>
        <thead><tr><th class="num">Godzina</th><th>Przyczyna</th><th class="num">Gra</th><th class="num">Przechw.</th><th class="num">Konw.</th><th class="num">Enk.</th><th class="num">Sieć</th><th class="num">Dekod.</th><th class="num">Wyśw.</th></tr></thead>
        <tbody>${slowTimes.map(e => `<tr><td class="num">${clock(e.u)}</td><td>${esc(e.causes.map(k => SLOW_LABEL[k] || k).join(', ') || '—')}</td>${['game', 'capture', 'convert', 'encode', 'network', 'decode', 'display'].map(k => `<td class="num">${e[k] == null || Math.abs(e[k]) > 10000 ? '—' : num(e[k], 1)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div></details></section>` : ''}
      <section class="panel">
        <div class="actions">
          <button class="primary" id="saveBtn" type="button" ${sum.n ? '' : 'disabled'}>Zapisz do historii</button>
          <button id="copyBtn" type="button" ${sum.n ? '' : 'disabled'}>Kopiuj raport dla AI</button>
          <button id="jsonBtn" type="button" ${sum.n ? '' : 'disabled'}>Pobierz podsumowanie JSON</button>
          <span class="muted small" id="actMsg"></span>
        </div>
        <textarea class="fallback" id="copyFallback" readonly hidden></textarea>
      </section>`;

    el.querySelectorAll('[data-sg]').forEach(cb => cb.addEventListener('change', () => {
      const set = steamSelection(s);
      cb.checked ? set.add(+cb.dataset.sg) : set.delete(+cb.dataset.sg);
      SS.Store.putRange({ id: s.id, segs: [...set] }).catch(() => {});
      renderSteamDetail(el, s); renderSessions();
    }));
    $('#removeBtn').addEventListener('click', () => removeSession(s));
    wireCompare(el, s);
    const summary = () => {
      const segs = steamSegs(s), sum = SS.steamSummary(segs);
      return { ...SS.Report.steamSummary(s, segs, sum, s.sdiag), scores: SS.Score.compact(SS.Score.steam(segs, sum)) };
    };
    $('#saveBtn').addEventListener('click', () => {
      const ok = SS.History.add(summary());
      actMsg(ok ? 'Zapisano w historii tej przeglądarki.' : 'Zapisano tylko do zamknięcia karty: przeglądarka blokuje pamięć lokalną.');
      renderHistory();
    });
    $('#copyBtn').addEventListener('click', () => copyText(SS.Report.text(summary())));
    $('#jsonBtn').addEventListener('click', () => {
      const x = summary();
      download(`streamscope-steam-${x.app.replace(/\W+/g, '_')}-${new Date(x.date * 1000).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, JSON.stringify(x, null, 2));
    });
  }

  // ---------- compare two sessions side by side ----------
  const sessLabel = s => `${shortDate(s.t0)} · ${s.app} · ${s.steam ? 'Steam ' + shortEnc((s.steam.segments.at(-1) || {}).encoder) : s.clients[0] ? `${s.clients[0].log.client} ${(s.host && s.host.codec) || ''}` : s.st ? 'StreamLight (StreamTweak)' : (s.host && s.host.codec) || ''}`;

  function wireCompare(el, s) {
    const b = el.querySelector('[data-compare]');
    if (!b) return;
    b.addEventListener('click', () => {
      if (b.nextElementSibling && b.nextElementSibling.tagName === 'SELECT') { b.nextElementSibling.remove(); return; }
      const sel = document.createElement('select');
      sel.innerHTML = `<option value="">Wybierz sesję do porównania…</option>` +
        state.sessions.filter(o => o.id !== s.id).map(o => `<option value="${esc(o.id)}">${esc(sessLabel(o))}</option>`).join('');
      sel.addEventListener('change', () => { if (sel.value) { state.compareWith = { a: s.id, b: sel.value }; renderSideBySide(); $('#cmpView').scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
      b.after(sel); sel.focus();
    });
  }

  // Everything the comparison needs about one session, for its current range (or chosen Steam segments).
  function sessionView(s) {
    if (s.steam) {
      const segs = steamSegs(s), sum = SS.steamSummary(segs), sc = SS.Score.steam(segs, sum);
      return { s, sc, dur: sum.dur, range: `${segs.length} odc. Steama`, series: {}, m: {
        fps: sum.fps, encode: sum.encodeMs, bitrate: sum.serverMbps, rtt: sum.pingMs, clientLat: (sum.networkMs || 0) + (sum.decodeMs || 0) + (sum.displayMs || 0) } };
    }
    const e = effRange(s), b = SS.Benchmark.compute(s, e.a, e.b), sc = SS.Score.vibepollo(s, b), H = b.host, T = b.clientTrace, ST = b.st;
    const c = b.clients[0] && b.clients[0].stream.stats;
    const rel = pts => pts.filter(p => p.u >= e.a && p.u <= e.b && p.v != null).map(p => ({ u: p.u - e.a, v: p.v }));
    const series = {};
    if (s.host) {
      const W = s.host.samples.filter(x => x.timestamp_unix >= e.a && x.timestamp_unix <= e.b);
      series.fps = W.map(x => ({ u: x.timestamp_unix - e.a, v: x.actual_fps }));
      series.bitrate = W.map(x => ({ u: x.timestamp_unix - e.a, v: (x.actual_bitrate_kbps || 0) / 1000 }));
      series.encode = W.filter(x => x.encode_latency_ms > 0).map(x => ({ u: x.timestamp_unix - e.a, v: x.encode_latency_ms }));
    }
    const tc = b.clients.find(x => x.trace);
    if (tc) {
      series.shown = rel(tc.trace.t.map((t, i) => ({ u: tc.traceU0 + t, v: tc.trace.pres[i] })));
      series.clientLat = rel(tc.trace.t.map((t, i) => ({ u: tc.traceU0 + t, v: tc.trace.lat50[i] })));
    }
    if (s.st) {
      series.hostLat = rel(s.st.series.hostLat || []);
      if (!series.bitrate) series.bitrate = rel(s.st.series.bitrate || []);
    }
    return { s, sc, dur: e.b - e.a, range: `${fmtU(s, e.a)}–${fmtU(s, e.b)}`, series, m: {
      fps: H ? (H.fpsAvgActive ?? H.fpsAvg) : ST && ST.fpsAvg, fpsP1: H ? (H.fpsP1Active ?? H.fpsP1) : null,
      encode: H && H.encAvg, hostLat: ST && ST.hostLatAvg, bitrate: H ? H.bitrateAvg : ST && ST.bitrateAvg,
      shown: T ? T.fpsShown : c && c.rendering, clientLat: T ? T.lat50 : null, clientLat95: T ? T.lat95 : null,
      drops: T && T.lostPct != null ? T.lostPct + T.dropped / Math.max(1, T.fpsRecv * T.seconds) * 100 : ST ? ST.dropPct : c ? (c.netLossPct || 0) + (c.jitterLossPct || 0) : null,
      rtt: ST ? ST.rttAvg : c && c.netLatency, late: ST ? ST.latePct : H && H.encOver2Pct, pacing: c && c.smoothness,
      gpuEnc: H && !isPyro(s) ? H.gpuEncAvg : null, cpu: H && H.cpuAvg, netTx: H && H.netTxAvg,
      targetBitrate: s.host && s.host.reqBitrate ? s.host.reqBitrate / 1000 : ST && ST.targetBitrate } };
  }

  const CMP_METRICS = [
    ['FPS hosta (bez ekranów ładowania)', 'fps', 1, ''], ['FPS hosta P1', 'fpsP1', 1, ''], ['Wyświetlane FPS u klienta', 'shown', 1, ''],
    ['Enkodowanie (Vibepollo)', 'encode', 2, 'ms'], ['Opóźnienie hosta (StreamTweak)', 'hostLat', 2, 'ms'],
    ['Odbiór → ekran u klienta P50', 'clientLat', 1, 'ms'], ['Odbiór → ekran u klienta P95', 'clientLat95', 1, 'ms'],
    ['Straty / dropy klatek', 'drops', 2, '%'], ['RTT / ping', 'rtt', 1, 'ms'], ['Spóźnione klatki', 'late', 2, '%'],
    ['Płynność u klienta', 'pacing', 2, '%'], ['Bitrate docelowy', 'targetBitrate', 0, 'Mb/s'], ['Bitrate wysyłany', 'bitrate', 0, 'Mb/s'],
    ['Net TX hosta', 'netTx', 0, 'Mb/s'], ['Enkoder GPU (n/d przy PyroWave)', 'gpuEnc', 0, '%'], ['CPU hosta', 'cpu', 0, '%']
  ];

  function renderSideBySide() {
    const box = $('#cmpView');
    const cw = state.compareWith;
    const A = cw && state.sessions.find(x => x.id === cw.a), B = cw && state.sessions.find(x => x.id === cw.b);
    if (!A || !B) { box.hidden = true; box.innerHTML = ''; return; }
    const va = sessionView(A), vb = sessionView(B);
    const head = v => `<div style="display:grid;gap:6px;min-width:0">
        <div class="eyebrow">${v === va ? 'Sesja A' : 'Sesja B'}</div>
        <h3>${esc(v.s.app)} <span class="muted" style="font-weight:400">· ${esc(sessLabel(v.s).split(' · ').slice(2).join(' · '))}</span></h3>
        <div class="chips"><span class="chip">${shortDate(v.s.t0)}</span><span class="chip">${esc(modeOf(v.s))}</span><span class="chip">zakres ${esc(v.range)} (${tfmt(v.dur)})</span></div>
        ${v.sc && v.sc.overall != null ? `<div style="display:flex;gap:12px;align-items:center"><span class="score-big" style="min-width:90px;padding:6px 12px"><span class="n s-${SS.Score.cls(v.sc.overall)}" style="font-size:34px">${num(v.sc.overall, 1)}</span><span class="d">${esc(v.sc.label)}</span></span><span class="small muted">${esc(v.sc.reason)}</span></div>` : '<span class="muted small">brak oceny</span>'}
      </div>`;
    const diff = (a, b, d) => a == null || b == null ? '' : `${b - a > 0 ? '+' : ''}${num(b - a, d)}`;
    const cell = (v, d) => v == null ? '—' : num(v, d);
    const rows = [
      `<tr><td colspan="4" class="eyebrow" style="padding-top:10px">Testy oceny (1–10)</td></tr>`,
      ...SS.Score.GRADED.map(k => {
        const pa = va.sc && va.sc.parts[k], pb = vb.sc && vb.sc.parts[k];
        const a = pa ? pa.score : null, b = pb ? pb.score : null;
        // The source sits in brackets in each reason text; different sources are not like-for-like.
        const src = p => p && (p.why.match(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/) || [])[1];
        // Compare only the data source: drop frame-rate details ("…; ") and the scope prefix.
        const norm = t => t.split('; ').pop().replace(/^(zakres|cały stream|cała sesja), /, '').replace(/[\d,]+/g, '#');
        const mixed = pa && pb && src(pa) && src(pb) && norm(src(pa)) !== norm(src(pb));
        return a == null && b == null ? '' : `<tr><td>${SS.Score.LABELS[k]}${mixed ? ` <span class="pill warn" title="A: ${esc(src(pa))} | B: ${esc(src(pb))}">różne źródła</span>` : ''}</td><td class="num s-${SS.Score.cls(a)}">${cell(a, 1)}</td><td class="num s-${SS.Score.cls(b)}">${cell(b, 1)}</td><td class="num">${diff(a, b, 1)}</td></tr>`;
      }),
      `<tr><td colspan="4" class="eyebrow" style="padding-top:10px">Pomiary w zakresie</td></tr>`,
      ...CMP_METRICS.map(([label, k, d, unit]) => {
        const a = va.m[k], b = vb.m[k];
        return a == null && b == null ? '' : `<tr><td>${label}${unit ? ` <span class="muted small">(${unit})</span>` : ''}</td><td class="num">${cell(a, d)}</td><td class="num">${cell(b, d)}</td><td class="num">${diff(a, b, d)}</td></tr>`;
      })
    ].join('');
    box.hidden = false;
    box.innerHTML = `<div class="panel-head"><h2>Porównanie sesji</h2><div class="actions"><button class="small" type="button" id="cmpSwap">Zamień A ↔ B</button><button class="small" type="button" id="cmpClose">Zamknij</button></div></div>
      <div class="two">${head(va)}${head(vb)}</div>
      <div class="tablewrap"><table><thead><tr><th>Metryka</th><th class="num">A</th><th class="num">B</th><th class="num">Różnica B − A</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="legend"><span><i style="background:var(--s-fps)"></i>A: ${esc(va.s.app)} ${shortDate(va.s.t0)}</span><span><i style="background:repeating-linear-gradient(90deg,var(--s-enc) 0 5px,transparent 5px 8px)"></i>B (przerywana): ${esc(vb.s.app)} ${shortDate(vb.s.t0)}</span><span class="muted">oś czasu: od początku zakresu każdej sesji</span></div>
      <div class="chart" id="cmpChart"></div>
      <p class="caveat">Obie sesje liczone w swoich aktualnych zakresach (domyślnie wykryta rozgrywka). Różnica to tylko liczby; StreamScope nie wskazuje zwycięzcy. Porównuj podobne fragmenty gry (ta sama mapa, podobna długość).</p>`;
    $('#cmpClose').onclick = () => { state.compareWith = null; renderSideBySide(); };
    $('#cmpSwap').onclick = () => { state.compareWith = { a: cw.b, b: cw.a }; renderSideBySide(); };
    const panel = (label, key, h, extra = {}) => {
      const sa = va.series[key], sb = vb.series[key];
      if (!(sa && sa.length) && !(sb && sb.length)) return null;
      return { label, h, series: [{ points: sa || [], c: 'var(--s-fps)', w: 1.4 }, { points: sb || [], c: 'var(--s-enc)', w: 1.4, dash: '6 4' }], ...extra };
    };
    const panels = [
      panel('FPS hosta', 'fps', 130, { minMax: 60 }), panel('Wyświetlane FPS u klienta', 'shown', 110, { minMax: 60 }),
      panel('ms odbiór → ekran u klienta (P50)', 'clientLat', 90, { minMax: 20 }), panel('ms opóźnienie hosta (StreamTweak)', 'hostLat', 80, { minMax: 10 }),
      panel('ms enkodowanie (Vibepollo)', 'encode', 80, { minMax: 10 }), panel('Mb/s', 'bitrate', 80)
    ].filter(Boolean);
    const T = Math.max(va.dur, vb.dur, 60);
    if (panels.length) SS.Chart.draw($('#cmpChart'), { host: null, t0: 0, t1: T, panels, markers: [], events: [], fmtAxis: u => tfmt(u), axisBase: 0, tipRows: () => '',
      tipExtra: u => {
        const at = (v, k) => { const a = v.series[k] || []; let best = null; for (const p of a) if (!best || Math.abs(p.u - u) < Math.abs(best.u - u)) best = p; return best && Math.abs(best.u - u) < 5 ? num(best.v, 1) : '—'; };
        return `<br>FPS A ${at(va, 'fps')} · B ${at(vb, 'fps')}` + (va.series.clientLat || vb.series.clientLat ? `<br>Klient ms A ${at(va, 'clientLat')} · B ${at(vb, 'clientLat')}` : '');
      } });
    else $('#cmpChart').innerHTML = '<p class="muted small">Brak przebiegów w czasie do nałożenia (np. Steam ma tylko średnie odcinków).</p>';
  }

  // ---------- detail ----------
  function renderDetail() {
    const el = $('#detail');
    const s = current();
    if (!s) { el.innerHTML = ''; return; }
    if (s.steam) { renderSteamDetail(el, s); return; }
    const h = s.host;
    const chips = [];
    chips.push(date(s.t0), tfmt(s.t1 - s.t0), modeOf(s));
    if (h && h.reqBitrate) chips.push(`${num(h.reqBitrate / 1000, 0)} Mb/s żądane`);
    if (h) chips.push(`Vibepollo ${h.server || '?'}`, `${h.segs.length} połącz.`);
    if (h && h.hostGpu) chips.push(h.hostGpu);
    const syncChip = s.host && s.log
      ? `<span class="chip good">synchronizacja: ${esc(s.log.name)} · przesunięcie ${s.offset >= 0 ? '+' : ''}${num(s.offset, 1)} s</span>`
      : s.host ? `<span class="chip bad">brak logu klienta z tej sesji</span>` : `<span class="chip bad">brak pliku hosta z tej sesji</span>`;

    el.innerHTML = `
      <section class="panel" aria-labelledby="dTitle">
        <div class="panel-head">
          <div style="display:grid;gap:6px;min-width:0">
            <div class="eyebrow">Sesja</div>
            <h2 id="dTitle">${esc(s.app)}${h ? ` <span class="muted" style="font-weight:500">· ${esc(h.client)}</span>` : ''}</h2>
            <div class="chips">${chips.map(c => `<span class="chip">${esc(c)}</span>`).join('')}${syncChip}</div>
          </div>
          <div class="actions"><button class="small" type="button" data-compare>Porównaj z…</button><button class="small" type="button" id="removeBtn">Usuń sesję z pamięci</button></div>
        </div>
        ${h && h.segs.length > 1 ? segTable(s) : ''}
      </section>
      <section class="panel" aria-labelledby="rTitle">
        <div class="panel-head"><h2 id="rTitle">Zakres rozgrywki</h2>
          <div class="seg" role="group" aria-label="Oś czasu">
            <button type="button" data-base="client" aria-pressed="${useClientBase(s)}" ${s.clientBase == null ? 'disabled' : ''}>Czas ${s.log ? esc(s.log.client) : 'klienta'}</button>
            <button type="button" data-base="host" aria-pressed="${!useClientBase(s)}">Od startu hosta</button>
          </div>
        </div>
        <div id="dRange"></div>
        ${gameplayList(s)}
        ${markerTable(s)}
      </section>
      <section class="panel" aria-labelledby="cTitle">
        <div class="panel-head"><h2 id="cTitle">Przebieg</h2><span class="muted small">Przeciągnij po wykresie, żeby wybrać zakres.</span></div>
        ${h || s.st ? `<div class="legend">
          <span><i style="background:var(--s-fps)"></i>FPS (actual_fps)</span><span><i style="background:var(--s-br)"></i>Bitrate</span><span><i style="background:var(--s-enc)"></i>Enkodowanie / enkoder GPU</span><span><i style="background:var(--s-cpu)"></i>CPU hosta</span><span><i style="background:var(--s-gpu)"></i>GPU hosta</span>
          <span><i style="background:var(--mk-off)"></i>pad OFF</span><span><i style="background:var(--mk-on)"></i>pad ON</span><span><i style="background:var(--warn)"></i>RFI (klient)</span><span><i style="background:var(--crit)"></i>IDR / przepełnienie</span>
          <span><i class="box" style="background:var(--shade-crit)"></i>brak klatek</span><span><i class="box" style="background:var(--shade-warn)"></i>przeciążenie GPU</span><span><i class="box" style="background:var(--dim)"></i>poza zakresem</span><span><i style="background:var(--ok);height:5px"></i>wykryta rozgrywka</span>
        </div><div class="chart" id="dChart"></div>` : `<p class="muted">Wykresy wymagają pliku sesji Vibepollo z tego samego czasu.</p>`}
      </section>
      <section class="panel" aria-labelledby="bTitle">
        <div class="panel-head"><h2 id="bTitle">Benchmark zakresu</h2><span class="muted small" id="bScope"></span></div>
        <div id="dBench"></div>
      </section>
      <section class="panel" aria-labelledby="klTitle"><h2 id="klTitle">Klient</h2><div id="dClient"></div></section>
      ${h ? `<section class="panel" aria-labelledby="dgTitle">${diagHtml(s)}</section>` : ''}
      <section class="panel">
        <div class="actions">
          <button class="primary" id="saveBtn" type="button">Zapisz do historii</button>
          <button id="copyBtn" type="button">Kopiuj raport dla AI</button>
          <button id="jsonBtn" type="button">Pobierz podsumowanie JSON</button>
          <span class="muted small" id="actMsg"></span>
        </div>
        <textarea class="fallback" id="copyFallback" readonly hidden></textarea>
      </section>`;

    el.querySelectorAll('[data-base]').forEach(b => b.addEventListener('click', () => { state.timeBase = b.dataset.base; renderDetail(); }));
    el.querySelectorAll('[data-seg]').forEach(b => b.addEventListener('click', () => {
      const g = h.segs[+b.dataset.seg]; setRange(s, { a: g.t0, b: g.t1 });
    }));
    el.querySelectorAll('[data-gp]').forEach(b => b.addEventListener('click', () => {
      const g = h.gameplay[+b.dataset.gp]; setRange(s, { a: g.a, b: g.b, trimMin: 0 });
    }));
    el.querySelectorAll('[data-mk]').forEach(b => b.addEventListener('click', () => {
      const m = s.markers[+b.dataset.mk];
      setRange(s, b.dataset.as === 'start' ? { a: m.u } : { b: m.u, trimMin: 0 });
    }));
    $('#removeBtn').addEventListener('click', () => removeSession(s));
    wireCompare(el, s);
    $('#saveBtn').addEventListener('click', () => {
      const ok = SS.History.add(buildSummary(s));
      actMsg(ok ? 'Zapisano w historii tej przeglądarki.' : 'Zapisano tylko do zamknięcia karty: przeglądarka blokuje pamięć lokalną.');
      renderHistory();
    });
    $('#copyBtn').addEventListener('click', () => copyText(SS.Report.text(buildSummary(s))));
    $('#jsonBtn').addEventListener('click', () => {
      const sum = buildSummary(s);
      download(`streamscope-${sum.app.replace(/\W+/g, '_')}-${new Date(sum.date * 1000).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`, JSON.stringify(sum, null, 2));
    });
    updateRangeViews();
  }

  function segTable(s) {
    const segs = s.host.segs;
    return `<details><summary>Połączenia w pliku hosta (${segs.length})</summary><div class="tablewrap"><table>
      <thead><tr><th>#</th><th class="num">Start</th><th class="num">Koniec</th><th class="num">Długość</th><th class="num">Przerwa przed</th><th></th></tr></thead>
      <tbody>${segs.map((g, i) => `<tr><td>${i + 1}</td><td class="num">${fmtU(s, g.t0)} <span class="muted small">${clock(g.t0)}</span></td><td class="num">${fmtU(s, g.t1)}</td>
        <td class="num">${tfmt(g.t1 - g.t0)}</td><td class="num">${i ? num(g.t0 - segs[i - 1].t1, 1) + ' s' : ''}</td>
        <td><button class="small" type="button" data-seg="${i}">Ustaw jako zakres</button></td></tr>`).join('')}</tbody></table></div></details>`;
  }

  function gameplayList(s) {
    const gp = (s.host && s.host.gameplay) || [];
    if (!s.host) return '';
    if (!gp.length) return `<p class="muted small">Nie wykryto fragmentów rozgrywki (wysokie obciążenie CPU, stabilny FPS i bitrate przez min. 3 minuty). Ustaw zakres ręcznie albo markerami.</p>`;
    return `<div style="display:grid;gap:6px">
      <h3>Wykryta rozgrywka <span class="muted small" style="font-weight:400">automatycznie, bez markerów</span></h3>
      <div class="tablewrap"><table>
        <thead><tr><th class="num">Od</th><th class="num">Do</th><th class="num">Długość</th><th class="num">Godziny</th><th></th></tr></thead>
        <tbody>${gp.map((g, i) => `<tr><td class="num">${fmtU(s, g.a)}</td><td class="num">${fmtU(s, g.b)}</td><td class="num">${tfmt(g.dur)}</td>
          <td class="num muted">${clock(g.a)}–${clock(g.b)}</td>
          <td><button class="small" type="button" data-gp="${i}">Ustaw jako zakres</button></td></tr>`).join('')}</tbody>
      </table></div>
      <p class="caveat">Rozpoznane po wysokim obciążeniu CPU, stabilnym FPS i stałym bitrate (progi liczone osobno dla każdego połączenia). Granice mają dokładność ok. ±1 min; markery pada i ręczny zakres dalej działają.</p>
    </div>`;
  }

  function markerTable(s) {
    if (!s.markers.length) {
      return `<p class="muted small">Brak markerów.${s.clients.length ? ' Wyłącz i włącz pad podłączony do klienta na początku i na końcu rozgrywki, a pojawią się tutaj.' : ' Dodaj log klienta z tej sesji, żeby zobaczyć markery pada.'}</p>`;
    }
    return `<div class="tablewrap"><table>
      <thead><tr><th class="num">Moment</th><th class="num">Godzina</th><th>Marker</th><th>Urządzenie</th><th></th></tr></thead>
      <tbody>${s.markers.map((m, i) => `<tr>
        <td class="num">${fmtU(s, m.u)}</td><td class="num muted">${clock(m.u)}</td>
        <td><span class="pill ${m.type === 'pad-off' ? 'crit' : m.type === 'pad-on' ? 'ok' : 'raw'}">${esc(m.label)}</span></td>
        <td class="small">${esc(m.device || '')}</td>
        <td><button class="small" type="button" data-mk="${i}" data-as="start">Ustaw jako start</button> <button class="small" type="button" data-mk="${i}" data-as="end">Ustaw jako koniec</button></td>
      </tr>`).join('')}</tbody></table></div>`;
  }

  function updateRangeViews() {
    const s = current(); if (!s) return;
    const r = rangeOf(s), e = effRange(s);
    const box = $('#dRange');
    box.innerHTML = `<div class="range">
        <label class="field">Start<input class="t" id="rStart" value="${fmtU(s, r.a)}" placeholder="np. 28:17" inputmode="numeric"></label>
        <label class="field">Koniec<input class="t" id="rEnd" value="${fmtU(s, r.b)}" placeholder="np. 1:00:04" inputmode="numeric"></label>
        <label class="field">Przytnij koniec o (min)<input class="t" id="rTrim" value="${r.trimMin || 0}" inputmode="decimal" style="width:70px"></label>
        <div class="readout">→ ${fmtU(s, e.a)} – ${fmtU(s, e.b)} <span class="muted">(${tfmt(e.b - e.a)})</span></div>
        <button type="button" id="rLongest">${s.host && s.host.gameplay && s.host.gameplay.length ? 'Najdłuższa rozgrywka' : 'Najdłuższe połączenie'}</button>
        <button type="button" id="rAll">Cała sesja</button>
      </div>
      <p class="caveat" style="margin-top:8px">Czas w polach: ${esc(baseName(s))} (godz.: ${clock(e.a)} – ${clock(e.b)}). Wpisz np. <span class="mono">28:17</span> albo <span class="mono">1:00:04</span>; sama liczba to minuty.</p>`;
    const onTime = (id, key) => $(id).addEventListener('change', ev => {
      const v = tparse(ev.target.value);
      if (v == null) { ev.target.value = fmtU(s, rangeOf(s)[key]); return; }
      setRange(s, { [key]: base0(s) + v });
    });
    onTime('#rStart', 'a'); onTime('#rEnd', 'b');
    $('#rTrim').addEventListener('change', ev => setRange(s, { trimMin: Math.max(0, parseFloat(String(ev.target.value).replace(',', '.')) || 0) }));
    $('#rLongest').addEventListener('click', () => setRange(s, { ...SS.Session.defaultRange(s), trimMin: 0 }));
    $('#rAll').addEventListener('click', () => setRange(s, { a: s.t0, b: s.t1, trimMin: 0 }));

    const bench = SS.Benchmark.compute(s, e.a, e.b);
    drawChart(s, e);
    $('#bScope').textContent = s.host ? `próbki hosta co ~2 s w zakresie ${fmtU(s, e.a)}–${fmtU(s, e.b)}` : '';
    $('#dBench').innerHTML = benchHtml(s, bench);
    $('#dClient').innerHTML = clientHtml(s, bench);
  }

  // StreamTweak series as chart panels (host clock, ~600 points per session).
  function stPanels(s, target) {
    if (!s.st) return [];
    const P = k => s.st.series[k] || [];
    const frame = 1000 / (target || 60);
    const panels = [
      { label: 'ms opóźnienie hosta (StreamTweak: przechwyt. + enk.)', h: 80, minMax: frame * 1.2, series: [{ points: P('hostLat'), c: 'var(--s-enc)', w: 1.3 }], refLines: [{ v: frame, c: 'var(--muted)' }] },
      { label: 'ms RTT (StreamTweak)', h: 70, minMax: 5, series: [{ points: P('rtt'), c: 'var(--s-gpu)', w: 1.2 }] },
      { label: 'dropy / s (StreamTweak)', h: 60, minMax: 2, series: [{ points: P('drops'), c: 'var(--crit)', w: 1.2 }] }
    ];
    if (!s.host) panels.push(
      { label: 'Mb/s (StreamTweak)', h: 80, series: [{ points: P('bitrate'), c: 'var(--s-br)' }] },
      { label: '% obciążenia hosta (StreamTweak)', h: 90, max: 100, series: [{ points: P('cpu'), c: 'var(--s-cpu)', w: 1.1 }, { points: P('gpu'), c: 'var(--s-gpu)', w: 1.1 }, { points: P('enc'), c: 'var(--s-enc)', w: 1.1 }] });
    return panels;
  }
  const stAt = (s, u) => {
    if (!s.st) return '';
    const near = k => { const a = s.st.series[k] || []; let best = null; for (const p of a) if (!best || Math.abs(p.u - u) < Math.abs(best.u - u)) best = p; return best && Math.abs(best.u - u) < 10 ? best.v : null; };
    const hl = near('hostLat'), rtt = near('rtt'), dr = near('drops');
    return hl == null && rtt == null ? '' : `<br>StreamTweak: host ${num(hl, 1)} ms · RTT ${num(rtt, 1)} ms${dr ? ` · dropy ${num(dr, 1)}/s` : ''}`;
  };

  // Reconnects labelled on the chart: "S2 · PyroWave 2560×1440@116", taken from the client stream that
  // started with that connection (settings changes create a new connection), else the host file.
  function segLabels(s) {
    const segs = s.host ? s.host.segs : [];
    if (segs.length < 2) return [];
    return segs.map((g, i) => {
      const c = s.clients.find(x => Math.abs(x.u0 - g.t0) <= 60);
      const st = c && c.stream;
      const codec = (st && st.codec) || s.host.codec || '';
      const mode = st && st.width ? `${st.width}×${st.height}@${st.fps}` : '';
      return { u: g.t0, label: `S${i + 1} · ${codec}${mode ? ' ' + mode : ''}` };
    });
  }

  function drawChart(s, e) {
    const el = $('#dChart'); if (!el) return;
    if (!s.host) {
      if (!s.st) return;
      SS.Chart.draw(el, {
        host: null, t0: s.t0, t1: s.t1, range: e, markers: [], events: [],
        bands: (s.st.games || []).map(g => ({ a: g.u0, b: g.u1, fill: 'var(--ok)' })),
        fmtAxis: u => fmtU(s, u), axisBase: base0(s), tipRows: () => '', tipExtra: u => stAt(s, u),
        panels: stPanels(s, s.st.stats.TargetFps), onRange: (a, b) => setRange(s, { a, b, trimMin: 0 })
      });
      return;
    }
    const h = s.host, d = diagOf(s);
    const epi = [];
    if (d) {
      const add = (eps, fill) => eps.forEach(x => { const a = h.t0 + x.t - d.dt / 2; epi.push({ a, b: a + x.dur, fill }); });
      add(d.epsStarve, 'var(--shade-crit)'); add(d.epsGpu, 'var(--shade-warn)'); add(d.epsBusy, 'var(--shade-info)');
    }
    // Client per-second timeline (Moonlight VRR capture), drawn on the host clock.
    const pts = (key, scale = 1) => s.clients.filter(c => c.trace).flatMap(c => c.trace.t.map((t, i) => ({ u: c.traceU0 + t, v: c.trace[key][i] == null ? null : c.trace[key][i] * scale })));
    const hasTrace = s.clients.some(c => c.trace);
    const clientPanels = hasTrace ? [
      { label: 'FPS klienta (wyświetlane)', h: 110, minMax: h.target || 60, series: [{ points: pts('pres'), c: 'var(--s-sent)', w: 1.4 }], refLines: [{ v: h.target, c: 'var(--muted)' }] },
      { label: 'ms klient: odbiór→ekran (P50 / P95)', h: 90, minMax: 20, series: [{ points: pts('lat95'), c: 'var(--warn)', w: 1, dash: '3 3' }, { points: pts('lat50'), c: 'var(--s-sent)', w: 1.3 }] }
    ] : [];
    const traceAt = u => {
      for (const c of s.clients) {
        if (!c.trace) continue;
        const i = Math.round(u - c.traceU0);
        const k = c.trace.t.indexOf(i);
        if (k >= 0) return `<br>Klient: ${c.trace.pres[k]} kl./s · ${num(c.trace.lat50[k], 1)} ms (P95 ${num(c.trace.lat95[k], 1)})${c.trace.drop[k] ? ` · odrzucone ${c.trace.drop[k]}` : ''}`;
      }
      return '';
    };
    SS.Chart.draw(el, {
      host: h, t0: s.t0, t1: s.t1, range: e, markers: s.markers, events: s.events, episodes: epi, segs: h.segs,
      bands: (h.gameplay || []).map(g => ({ a: g.a, b: g.b, fill: 'var(--ok)' })), segLabels: segLabels(s),
      fmtAxis: u => fmtU(s, u), axisBase: base0(s), tipExtra: u => traceAt(u) + stAt(s, u),
      panels: [
        { label: 'FPS', h: 150, minMax: h.target || 60, series: [{ get: x => x.actual_fps, c: 'var(--s-fps)', w: 1.6 }], refLines: [{ v: h.target, c: 'var(--muted)' }] },
        ...clientPanels,
        ...stPanels(s, h.target),
        { label: 'Mb/s', h: 90, series: [{ get: x => (x.actual_bitrate_kbps || 0) / 1000, c: 'var(--s-br)' }], refLines: [{ v: h.reqBitrate ? h.reqBitrate / 1000 : null, c: 'var(--muted)' }] },
        { label: 'ms enk.', h: 80, minMax: 12, series: [{ get: x => x.encode_latency_ms, c: 'var(--s-enc)', skipZero: true }] },
        { label: '% obciążenia', h: 100, max: 100, series: [{ get: x => x.host_cpu_percent, c: 'var(--s-cpu)', w: 1.1 }, { get: x => x.host_gpu_percent, c: 'var(--s-gpu)', w: 1.1 }, { get: x => x.host_gpu_encoder_percent, c: 'var(--s-enc)', w: 1.1 }] }
      ],
      tipRows: x => `<br>FPS ${num(x.actual_fps, 1)}<br>Bitrate ${num((x.actual_bitrate_kbps || 0) / 1000, 1)} Mb/s<br>Enk. ${x.encode_latency_ms ? num(x.encode_latency_ms, 1) + ' ms' : '—'} · ${num(x.host_gpu_encoder_percent, 0)}%<br>CPU ${num(x.host_cpu_percent, 0)}% · GPU ${num(x.host_gpu_percent, 0)}%`,
      onRange: (a, b) => setRange(s, { a, b, trimMin: 0 })
    });
  }

  // ---------- scores 1–10 ----------
  // Score of the session's current range (Vibepollo) or chosen segments (Steam), as shown in its detail.
  function sessionScore(s) {
    if (s.steam) { const segs = steamSegs(s); return SS.Score.steam(segs, SS.steamSummary(segs)); }
    if (!s.host && !s.st) return null;
    const e = effRange(s);
    return SS.Score.vibepollo(s, SS.Benchmark.compute(s, e.a, e.b));
  }
  const scoreChip = sc => sc && sc.overall != null ? `<span class="score-chip s-${SS.Score.cls(sc.overall)}">${num(sc.overall, 1)}</span>` : '<span class="muted">—</span>';
  const scoreTile = (k, p) => {
    const c = SS.Score.cls(p.score), w = p.score == null ? 0 : p.score * 10;
    return `<div class="score"><div class="top"><b>${SS.Score.LABELS[k]}</b><span class="val s-${c}">${p.score == null ? 'n/d' : num(p.score, 1)}</span></div>
      <div class="meter"><i class="m-${c}" style="width:${w}%"></i></div><p>${esc(p.why)}</p></div>`;
  };
  function scoreHtml(sc) {
    if (!sc || sc.overall == null) return '';
    const graded = SS.Score.GRADED.filter(k => sc.parts[k]), info = SS.Score.INFO.filter(k => sc.parts[k]);
    return `<div class="scorebox">
      <div class="score-big"><span class="n s-${SS.Score.cls(sc.overall)}">${num(sc.overall, 1)}</span><span class="d">${esc(sc.label)}</span></div>
      <div style="display:grid;gap:8px;min-width:0">
        <div><b>Werdykt: ${esc(sc.label)}</b> <span class="muted small">· ${esc(sc.reason)}</span></div>
        <div class="scores">${graded.map(k => scoreTile(k, sc.parts[k])).join('')}</div>
      </div>
    </div>
    ${info.length ? `<div style="display:grid;gap:6px"><div><b>Wydajność gry i hosta</b> <span class="muted small">· osobno, bez wpływu na werdykt (limit gry i ekrany ładowania to nie problem streamu)</span></div>
      <div class="scores">${info.map(k => scoreTile(k, sc.parts[k])).join('')}</div></div>` : ''}
    <p class="caveat">Werdykt ocenia zdrowie streamu. Ocena = średnia testów, ale najwyżej 1,5 pkt powyżej najsłabszego. Opóźnienia liczone w okresach klatki, FPS poza oceną (jak w StreamTweak); każdy test podaje źródło danych. Liczona dla wybranego zakresu.</p>`;
  }

  const stat = (k, v, unit, hl) => `<div class="stat${hl ? ' hl' : ''}"><span class="k">${k}</span><span class="v">${v}${unit ? ` <small>${unit}</small>` : ''}</span></div>`;

  // StreamTweak numbers in the range (StreamLight telemetry about once per second + host load).
  function stHtml(b) {
    const T = b.st;
    if (!T) return '';
    return `<div style="display:grid;gap:8px"><h3>StreamTweak w zakresie <span class="muted small" style="font-weight:400">telemetria StreamLight, ok. 1 próbka na sekundę</span></h3>
      <div class="stats">
        ${stat('RTT śr. / maks.', `${num(T.rttAvg, 1)} / ${num(T.rttMax, 0)}`, 'ms', true)}
        ${stat('Jitter śr.', num(T.jitterAvg, 1), 'ms (cała sesja)')}
        ${stat('Dropy', num(T.dropPct, 2), '% klatek')}
        ${stat('Opóźnienie hosta', num(T.hostLatAvg, 2), `ms, przechwytywanie + enkodowanie${T.hostLatMaxSession ? `; maks. ${num(T.hostLatMaxSession, 0)} ms (sesja)` : ''}`, true)}
        ${stat('Spóźnione klatki', num(T.latePct, 2), '% ponad 2 okresy (sesja)')}
        ${stat('Dekodowanie', num(T.decodeAvg, 2), 'ms')}
        ${stat('Bitrate dostarczony', num(T.bitrateAvg, 0), T.targetBitrate ? `Mb/s z ${num(T.targetBitrate, 0)} docelowych` : 'Mb/s')}
      </div></div>`;
  }

  function benchHtml(s, b) {
    const H = b.host;
    if (!s.host && s.st) return scoreHtml(SS.Score.vibepollo(s, b)) + stHtml(b) + `<p class="caveat">Brak pliku sesji Vibepollo z tego czasu (np. panel go nie oddał), więc ocena opiera się na danych StreamTweak.</p>`;
    if (!s.host) return `<p class="muted">Benchmark FPS, bitrate i enkodowania liczy się z próbek hosta. Dodaj plik <span class="mono">sunshine-session-*.json</span> z tej sesji.</p>`;
    if (!H) return `<p class="muted">W wybranym zakresie jest mniej niż 2 próbki hosta. Poszerz zakres.</p>`;
    const ev = b.clientEvents;
    const target = s.host.target;
    const pyro = isPyro(s);
    return scoreHtml(SS.Score.vibepollo(s, b)) + `<div class="stats">
      ${stat('Śr. FPS', num(H.fpsAvg, 2), target ? '/ ' + target : '', true)}
      ${stat('P50 (mediana)', num(H.fpsP50, 1), '', true)}
      ${stat('P5', num(H.fpsP5, 1), '', true)}
      ${stat('P1', num(H.fpsP1, 1), '', true)}
      ${stat('FPS z frames_sent', num(H.fpsSent, 2), H.fpsSent != null ? `Δ ${num(H.fpsSent - H.fpsAvg, 2)}` : '')}
      ${stat('FPS ≥ 90', num(H.pct90, 1), '% czasu')}
      ${stat('FPS ≥ 100', num(H.pct100, 1), '% czasu')}
      ${stat('Bitrate śr. / P95', `${num(H.bitrateAvg, 1)} / ${num(H.bitrateP95, 1)}`, 'Mb/s')}
      ${stat('Bitrate docelowy / wysyłany / Net TX', `${num(s.host.reqBitrate ? s.host.reqBitrate / 1000 : null, 0)} / ${num(H.bitrateAvg, 0)} / ${num(H.netTxAvg, 0)}`, 'Mb/s (Net TX: cały ruch karty sieciowej hosta)')}
      ${stat('Enkodowanie śr.', num(H.encAvg, 2), 'ms')}
      ${stat('Enkodowanie P50 / P95', `${num(H.encP50, 1)} / ${num(H.encP95, 1)}`, 'ms')}
      ${stat('Enkodowanie max', num(H.encMax, 1), 'ms')}
      ${stat('GPU / enkoder śr.', `${num(H.gpuAvg, 0)} / ${pyro ? 'n/d' : num(H.gpuEncAvg, 0)}`, pyro ? '% (PyroWave liczy na GPU, nie na enkoderze NVENC)' : '%')}
      ${stat('CPU hosta śr.', num(H.cpuAvg, 0), '%')}
      ${stat('Temp. GPU max', num(H.gpuTempMax, 0), '°C')}
      ${stat('Straty / dropy wideo', `${H.losses} / ${H.videoDropped}`)}
      ${stat('IDR / ref. invalid.', `${H.idr} / ${H.refInv}`)}
      ${stat('RFI / IDR u klienta', s.clients.length ? `${ev.rfi} / ${ev.idr}` : '—', ev.overflow ? `+${ev.overflow} przepełn.` : '')}
      ${stat('Próbki / połączenia', `${H.n} / ${H.segments}`)}
    </div>` + stHtml(b);
  }

  const yesNo = v => v == null ? '—' : v ? 'tak' : 'nie';
  function clientHtml(s, b) {
    if (!s.clients.length) return s.st ? `<p class="muted">Brak logu klienta; dane StreamLight z tej sesji pochodzą ze StreamTweak (powyżej, w benchmarku).</p>` : `<p class="muted">Brak logu klienta z tej sesji. Dodaj <span class="mono">StreamLight-*.log</span> z klienta.</p>`;
    const list = b.clients.length ? b.clients : s.clients;
    const note = b.clients.length ? '' : '<p class="caveat">Żaden stream klienta nie pokrywa się z wybranym zakresem. Poniżej wszystkie streamy z tej sesji.</p>';
    return note + traceRangeHtml(b) + `<div class="two">${list.map(c => streamCard(s, c)).join('')}</div>
      <p class="caveat">Statystyki w kartach poniżej pochodzą z bloku „Global video stats” i dotyczą całego streamu, nie wybranego zakresu.</p>`;
  }
  // Client numbers for the chosen range, from Moonlight's per-frame VRR capture (via the agent).
  function traceRangeHtml(b) {
    const T = b.clientTrace;
    if (!T) return '';
    return `<div style="display:grid;gap:8px"><h3>Klient w wybranym zakresie <span class="muted small" style="font-weight:400">z diagnostyki VRR Moonlight (klatka po klatce)</span></h3>
      <div class="stats">
        ${stat('Wyświetlane FPS', num(T.fpsShown, 2), '', true)}
        ${stat('Odbierane FPS', num(T.fpsRecv, 2))}
        ${stat('Wyświetlane P5 / P1', `${num(T.fpsShownP5, 0)} / ${num(T.fpsShownP1, 0)}`, 'kl./s')}
        ${stat('Odbiór → ekran (P50)', num(T.lat50, 1), 'ms', true)}
        ${stat('Odbiór → ekran (P95)', num(T.lat95, 1), `ms, najgorsze 5% sekund ${num(T.lat95Worst, 1)}`)}
        ${stat('Dekodowanie (P50)', num(T.dec50, 2), 'ms')}
        ${stat('Odrzucone klatki', num(T.dropped, 0), `${num(T.droppedPerMin, 1)}/min`)}
        ${T.lost != null ? stat('Zgubione w sieci', num(T.lost, 0), `klatek (${num(T.lostPct, 2)}%)`) : ''}
        ${stat('Pokrycie', tfmt(T.seconds), 'sekund z danymi')}
      </div></div>`;
  }
  function streamCard(s, c) {
    const st = c.stream, p = st.presentation || {}, x = st.stats || {}, hs = st.hostSnapshot;
    const vrr = SS.Report.vrrState(st);
    const rows = [
      ['Stream', st.width ? `${st.width}×${st.height} @ ${st.fps} FPS ${st.codec || ''}` : '—'],
      ['Bitrate ustawiony', st.bitrateKbps ? `${num(st.bitrateKbps / 1000, 1)} Mb/s` : '—'],
      ['Ekran', p.refresh ? `${p.refresh} Hz` : '—'],
      ['V-sync', yesNo(p.vsync)],
      ['VRR', `żądane ${yesNo(p.vrrRequested)} · włączone ${yesNo(p.vrrEnabled)} · backend D3D11 ${yesNo(st.vrrBackend)}${x.vrrPacing ? ` · pacing ${x.vrrPacing}` : ''}`],
      ['Renderer', st.renderer || '—'],
      ['GPU klienta', c.log.info.gpu || '—'],
      ['Łącze', c.log.info.link || '—']
    ];
    const hasStats = !!st.stats;
    return `<div style="display:grid;gap:10px;min-width:0">
      <div><h3>${esc(c.log.client)} · stream ${st.index + 1} <span class="pill ${vrr === 'active' ? 'ok' : 'raw'}">VRR ${esc(vrr || '?')}</span></h3>
      <div class="muted small">${esc(c.log.name)} · ${tfmt(st.tStart)}–${tfmt(st.tEnd)} w logu · ${clock(c.u0)}–${clock(c.u1)}</div></div>
      <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${hasStats ? `<div class="stats">
        ${stat('Odbierane FPS', num(x.incoming, 2), '', true)}
        ${stat('Dekodowane FPS', num(x.decoding, 2))}
        ${stat('Renderowane FPS', num(x.rendering, 2), '', true)}
        ${stat('Utrata sieć / jitter', `${num(x.netLossPct, 2)} / ${num(x.jitterLossPct, 2)}`, '%')}
        ${stat('Opóźnienie sieci', num(x.netLatency, 0), x.netVariance != null ? `ms (wariancja ${num(x.netVariance, 0)})` : 'ms')}
        ${stat('Dekodowanie', num(x.decodeMs, 2), 'ms')}
        ${stat('Kolejka klatek', num(x.queueMs, 2), 'ms')}
        ${stat('Renderowanie', num(x.renderMs, 2), 'ms')}
        ${stat('Opóźn. hosta min/śr./max', `${num(x.hostLatMin, 1)}/${num(x.hostLatAvg, 1)}/${num(x.hostLatMax, 1)}`, 'ms')}
        ${x.smoothness !== undefined ? stat('Smoothness (2m)', x.smoothness == null ? 'zbiera' : num(x.smoothness, 2), x.smoothness == null ? '' : `% / cel ${num(x.smoothnessTarget, 1)}%`) : ''}
        ${x.incomingSmoothness != null ? stat('Incoming smoothness', num(x.incomingSmoothness, 2), '%') : ''}
        ${x.dropped30s != null ? stat('Błąd interwału / drop 30 s', `${x.intervalErrorMs == null ? '—' : num(x.intervalErrorMs, 3)} / ${x.dropped30s}`, 'ms') : ''}
        ${x.vrrBufferMs != null ? stat('Bufor VRR', num(x.vrrBufferMs, 2), `ms dodane (limit ${num(x.vrrBufferLimitMs, 2)})`) : ''}
        ${x.gpuDecodeWaitMs != null ? stat('Czekanie na dekoder GPU', num(x.gpuDecodeWaitMs, 2), 'ms') : ''}
        ${x.skippedPct != null ? stat('Pominięte przed dekodowaniem', num(x.skippedPct, 2), '%') : ''}
        ${x.bitrateEnd != null ? stat('Bitrate z końcówki', `${num(x.bitrateEnd, 1)} / ${num(x.bitratePeak10, 1)}`, 'Mb/s teraz / szczyt 10 s') : ''}
      </div>` : '<p class="muted small">Brak bloku „Global video stats” (stream przerwany albo log ucięty).</p>'}
      ${x.smoothnessNote ? `<p class="caveat">Smoothness: ${esc(x.smoothnessNote)}.</p>` : ''}
      ${x.bitrateEnd != null ? '<p class="caveat">Bitrate z końcówki to stan z ostatnich sekund, nie średnia sesji. Średnią liczy benchmark z danych hosta.</p>' : ''}
      ${hs ? `<p class="caveat">Host na koniec streamu (StreamTweak): GPU ${hs.gpu ?? '—'}% · enkoder ${hs.enc ?? '—'}% · ${hs.temp ?? '—'}°C · VRAM ${hs.vramUsed ?? '—'}/${hs.vramTotal ?? '—'} MB · CPU ${hs.cpu ?? '—'}% · TX ${hs.netTx ?? '—'} Mb/s</p>` : ''}
    </div>`;
  }

  function diagHtml(s) {
    const d = diagOf(s);
    const findings = d.findings.length ? d.findings : [{ sev: 'ok', title: 'Nic nie wymaga uwagi', text: 'Brak utraty pakietów, epizodów spadku FPS i przerw w oknie analizy.' }];
    const eps = [
      ...d.epsStarve.map(e => ({ ...e, kind: 'Brak klatek', cls: e.early ? 'warn' : 'crit' })),
      ...d.epsGpu.map(e => ({ ...e, kind: 'Przeciążenie GPU/enk.', cls: 'warn' })),
      ...d.epsBusy.map(e => ({ ...e, kind: 'Spadek przy obciążonym GPU', cls: 'raw' }))
    ].sort((a, b) => a.t - b.t);
    return `<div class="panel-head"><h2 id="dgTitle">Diagnostyka całej sesji</h2>
        <div class="actions"><span class="muted small">Analiza:</span><span class="pill ${d.status}">${statusLabel[d.status]}</span><span class="muted small">Vibepollo:</span><span class="pill raw">${esc(d.verdict || '?')}</span></div></div>
      ${d.verdictNote ? `<p class="caveat">${esc(d.verdictNote)}</p>` : ''}
      <div class="findings">${findings.map(f => `<div class="finding ${f.sev}"><span class="bar"></span><div><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p></div></div>`).join('')}</div>
      ${eps.length ? `<details><summary>Epizody (${eps.length})</summary><div class="tablewrap"><table>
        <thead><tr><th class="num">Moment</th><th>Typ</th><th class="num">Długość</th><th class="num">FPS min</th><th class="num">CPU śr.</th><th class="num">GPU śr.</th><th class="num">IDR / ref.</th></tr></thead>
        <tbody>${eps.map(e => `<tr><td class="num">${fmtU(s, s.host.t0 + e.t)} <span class="muted small">${clock(s.host.t0 + e.t)}</span></td><td><span class="pill ${e.cls}">${e.kind}</span></td><td class="num">${num(e.dur, 0)} s</td><td class="num">${num(e.fpsMin, 0)}</td><td class="num">${num(e.cpu, 0)}%</td><td class="num">${num(e.gpu, 0)}%</td><td class="num">${e.idr} / ${e.ref}</td></tr>`).join('')}</tbody>
      </table></div></details>` : ''}
      <p class="caveat">Okno diagnostyki pomija pierwsze ${DIAG_OPTS.trimStart} s i ostatnie ${DIAG_OPTS.trimEnd} s pliku oraz 3 próbki po każdym połączeniu. Niezależnie od wybranego zakresu.</p>`;
  }

  function buildSummary(s) {
    const e = effRange(s);
    const bench = SS.Benchmark.compute(s, e.a, e.b);
    const label = `${fmtU(s, e.a)}–${fmtU(s, e.b)} (${baseName(s)})`;
    return { ...SS.Report.summary(s, bench, label, diagOf(s)), scores: SS.Score.compact(SS.Score.vibepollo(s, bench)) };
  }

  // ---------- actions ----------
  function actMsg(t) { const m = $('#actMsg'); if (m) m.textContent = t; }
  function copyText(txt) {
    const done = ok => {
      actMsg(ok ? 'Skopiowano raport. Wklej go do czatu z AI.' : 'Schowek niedostępny. Zaznacz tekst poniżej i skopiuj.');
      const ta = $('#copyFallback'); if (!ok && ta) { ta.hidden = false; ta.value = txt; ta.select(); }
    };
    try { navigator.clipboard.writeText(txt).then(() => done(true), () => done(false)); } catch (e) { done(false); }
  }
  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ---------- history & compare ----------
  function renderHistory() {
    const list = SS.History.load();
    $('#histCount').textContent = list.length ? `(${list.length})` : '';
    const body = $('#histBody');
    [...state.compare].forEach(id => { if (!list.find(x => x.id === id)) state.compare.delete(id); });
    if (!list.length) { body.innerHTML = `<tr><td colspan="12" class="empty">Brak zapisanych sesji. W widoku Analiza wybierz zakres i kliknij „Zapisz do historii”.</td></tr>`; }
    else body.innerHTML = list.map(x => `<tr>
        <td><input type="checkbox" data-cmp="${esc(x.id)}" ${state.compare.has(x.id) ? 'checked' : ''} aria-label="Zaznacz do porównania"></td>
        <td class="num">${date(x.date)}</td><td class="app">${esc(x.app)}</td><td>${esc(x.streamer || '—')}</td>
        <td class="mono small">${esc([x.codec, x.resolution && x.resolution.replace('x', '×') + (x.target_fps ? '@' + x.target_fps : ''), x.bitrate_setting_mbps ? x.bitrate_setting_mbps + ' Mb/s' : ''].filter(Boolean).join(' '))}</td>
        <td class="small">${esc(x.range || '')}</td>
        <td class="num">${x.scores && x.scores.overall != null ? `<span class="score-chip s-${SS.Score.cls(x.scores.overall)}">${num(x.scores.overall, 1)}</span>` : '—'}</td>
        <td class="num">${x.host ? num(x.host.avg_fps, 2) : '—'}</td><td class="num">${x.host ? num(x.host.p5_fps, 1) : '—'}</td>
        <td class="num">${x.host ? num(x.host.encode_p95_ms, 1) : '—'}</td><td class="num">${x.host ? num(x.host.bitrate_avg_mbps, 1) : '—'}</td>
        <td><button class="small" type="button" data-del="${esc(x.id)}">Usuń</button></td></tr>`).join('');
    body.querySelectorAll('[data-cmp]').forEach(cb => cb.addEventListener('change', () => {
      cb.checked ? state.compare.add(cb.dataset.cmp) : state.compare.delete(cb.dataset.cmp);
      $('#compareBtn').disabled = state.compare.size < 2;
    }));
    body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('Usunąć tę sesję z historii?')) return;
      SS.History.remove(b.dataset.del); state.compare.delete(b.dataset.del); renderHistory(); renderCompare();
    }));
    $('#compareBtn').disabled = state.compare.size < 2;
  }

  const CMP_ROWS = [
    ['Oceny (1–10)', null],
    ['Ocena ogólna', x => x.scores && x.scores.overall, 1],
    ...['drops', 'rtt', 'hostlat', 'late', 'pacing', 'e2e'].map(k => [SS.Score.LABELS[k], x => x.scores && x.scores[k], 1]),
    ...['fps', 'image', 'headroom'].map(k => [`${SS.Score.LABELS[k]} (info)`, x => x.scores && x.scores[k], 1]),
    ['Konfiguracja', null],
    ['Klient', x => x.streamer], ['Tryb', x => [x.codec, x.resolution, x.target_fps && '@' + x.target_fps].filter(Boolean).join(' ')],
    ['Bitrate ustawiony (Mb/s)', x => x.bitrate_setting_mbps, 0], ['Długość zakresu', x => x.duration_s, 't'],
    ['Host', null],
    ['Śr. FPS', x => x.host && x.host.avg_fps, 2], ['P50 FPS', x => x.host && x.host.p50_fps, 1], ['P5 FPS', x => x.host && x.host.p5_fps, 1], ['P1 FPS', x => x.host && x.host.p1_fps, 1],
    ['FPS z frames_sent', x => x.host && x.host.frames_sent_fps, 2], ['FPS ≥ 90 (%)', x => x.host && x.host.pct_ge_90, 1], ['FPS ≥ 100 (%)', x => x.host && x.host.pct_ge_100, 1],
    ['Bitrate śr. (Mb/s)', x => x.host && x.host.bitrate_avg_mbps, 1], ['Bitrate P95 (Mb/s)', x => x.host && x.host.bitrate_p95_mbps, 1],
    ['Enkodowanie śr. (ms)', x => x.host && x.host.encode_avg_ms, 2], ['Enkodowanie P95 (ms)', x => x.host && x.host.encode_p95_ms, 1],
    ['GPU śr. (%)', x => x.host && x.host.gpu_avg_pct, 0], ['Enkoder śr. (%)', x => x.host && x.host.encoder_avg_pct, 0],
    ['Straty / dropy', x => x.host && x.host.client_reported_losses != null ? `${x.host.client_reported_losses} / ${x.host.video_dropped}` : null],
    ['Klient (cały stream)', null],
    ['Odbierane FPS', x => x.client && x.client.incoming_fps, 2], ['Renderowane FPS', x => x.client && x.client.rendering_fps, 2],
    ['Utrata sieć (%)', x => x.client && x.client.network_loss_pct, 2], ['Utrata jitter (%)', x => x.client && x.client.jitter_loss_pct, 2],
    ['Opóźnienie sieci (ms)', x => x.client && x.client.network_latency_ms, 0], ['Dekodowanie (ms)', x => x.client && x.client.decode_ms, 2],
    ['Kolejka (ms)', x => x.client && x.client.queue_ms, 2], ['Renderowanie (ms)', x => x.client && x.client.render_ms, 2],
    ['VRR', x => x.client && x.client.vrr], ['Smoothness 2m (%)', x => x.client && x.client.smoothness_2m_pct, 2],
    ['RFI w zakresie', x => x.client_events && x.client_events.rfi, 0],
    ['Steam Remote Play', null],
    ['Ping (ms)', x => x.steam && x.steam.ping_ms, 2], ['Sieć – transfer klatki (ms)', x => x.steam && x.steam.network_ms, 2],
    ['Czas klatki (ms)', x => x.steam && x.steam.frame_ms, 2], ['Enkodowanie Steam (ms)', x => x.steam && x.steam.encode_ms, 2],
    ['Dekodowanie Steam (ms)', x => x.steam && x.steam.decode_ms, 2], ['Wyświetlanie (ms)', x => x.steam && x.steam.display_ms, 2],
    ['Przepustowość łącza (Mb/s)', x => x.steam && x.steam.link_mbps, 0],
    ['Wolne: sieć (% czasu)', x => x.steam && x.steam.slow_pct && x.steam.slow_pct.network, 2],
    ['Wolne: gra (% czasu)', x => x.steam && x.steam.slow_pct && x.steam.slow_pct.game, 2],
    ['Wolne: dekodowanie (% czasu)', x => x.steam && x.steam.slow_pct && x.steam.slow_pct.decode, 2]
  ];
  function renderCompare() {
    const panel = $('#comparePanel');
    const list = SS.History.load().filter(x => state.compare.has(x.id)).sort((a, b) => a.date - b.date);
    if (list.length < 2) { panel.hidden = true; return; }
    panel.hidden = false;
    const two = list.length === 2;
    const cell = (v, d) => v == null || v === '' ? '—' : d === 't' ? tfmt(v) : typeof d === 'number' && typeof v === 'number' ? num(v, d) : esc(v);
    panel.innerHTML = `<div class="panel-head"><h2>Porównanie</h2><span class="muted small">Różnica = kolumna 2 minus kolumna 1. Ocena należy do Ciebie.</span></div>
      <div class="tablewrap"><table>
        <thead><tr><th>Metryka</th>${list.map(x => `<th class="num">${esc(x.app)}<br><span class="muted" style="text-transform:none;letter-spacing:0">${date(x.date)}</span></th>`).join('')}${two ? '<th class="num">Różnica</th>' : ''}</tr></thead>
        <tbody>${CMP_ROWS.map(([k, f, d]) => {
          if (!f) return `<tr><td colspan="${list.length + (two ? 2 : 1)}" class="eyebrow" style="padding-top:14px">${k}</td></tr>`;
          const vals = list.map(f);
          let diff = '';
          if (two) {
            const [a, b] = vals;
            diff = typeof a === 'number' && typeof b === 'number' && typeof d === 'number' ? `${b - a > 0 ? '+' : ''}${num(b - a, d)}` : d === 't' && a != null && b != null ? `${b - a >= 0 ? '+' : '-'}${tfmt(Math.abs(b - a))}` : '';
          }
          return `<tr><td>${k}</td>${vals.map(v => `<td class="num">${cell(v, d)}</td>`).join('')}${two ? `<td class="num">${diff}</td>` : ''}</tr>`;
        }).join('')}</tbody></table></div>`;
  }

  // ---------- wiring ----------
  function showTab(which) {
    const tabs = { analyze: ['#tabAnalyze', '#viewAnalyze'], history: ['#tabHistory', '#viewHistory'], settings: ['#tabSettings', '#viewSettings'] };
    for (const [k, [t, v]] of Object.entries(tabs)) { $(t).setAttribute('aria-selected', k === which); $(v).hidden = k !== which; }
    if (which === 'history') renderHistory();
    else if (which === 'settings') SS.Settings.render($('#viewSettings'), { onSaved: () => {}, statusHtml: () => state.agent ? agentStatusHtml() : '' });
    else { const s = current(); if (s) updateRangeViews(); }
  }
  document.querySelectorAll('#sessFilter [data-f]').forEach(b => b.addEventListener('click', () => {
    state.filter = b.dataset.f;
    try { localStorage.setItem('streamscope.filter', state.filter); } catch (e) { /* per-viewer convenience only */ }
    const cur = current();
    if (state.filter !== 'all' && (!cur || kindOf(cur) !== state.filter)) {
      const first = state.sessions.find(s => kindOf(s) === state.filter);
      state.selected = first ? first.id : state.selected;
      renderDetail();
    }
    renderSessions();
  }));
  $('#tabAnalyze').addEventListener('click', () => showTab('analyze'));
  $('#tabHistory').addEventListener('click', () => showTab('history'));
  $('#tabSettings').addEventListener('click', () => showTab('settings'));

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', ev => { const fl = [...(ev.dataTransfer?.files || [])]; if (fl.length) addFiles(fl); });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => e.preventDefault());
  $('#files').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
  $('#pickBtn').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#files').click(); } });
  $('#clearBtn').addEventListener('click', async () => {
    if (!state.hosts.size && !state.logs.size && !state.steam.size) return;
    if (!confirm('Usunąć wszystkie wczytane pliki z pamięci tej przeglądarki? Zapisane podsumowania w Historii zostaną.')) return;
    await SS.Store.clearAll().catch(() => {});
    state.hosts.clear(); state.logs.clear(); state.diag.clear(); state.ranges.clear();
    state.steam.clear(); state.steamSel.clear(); state.hidden.clear();
    state.selected = null; notice(''); rebuild(); storageInfo();
  });

  $('#compareBtn').addEventListener('click', () => { renderCompare(); $('#comparePanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('#exportBtn').addEventListener('click', () => download(`streamscope-backup-${new Date().toISOString().slice(0, 10)}.json`, SS.History.exportJson()));
  $('#importBtn').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#importFile').click(); } });
  $('#importFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const n = $('#histNotice'); n.hidden = false;
    try { const k = SS.History.importJson(await f.text()); n.className = 'notice ok'; n.textContent = `Zaimportowano ${k} sesji.`; }
    catch (err) { n.className = 'notice err'; n.textContent = `Nie udało się zaimportować: ${err.message}`; }
    renderHistory();
  });

  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { const s = current(); if (s && !$('#viewAnalyze').hidden) drawChart(s, effRange(s)); }, 150); });

  // Test hook: lets tests.html drive the app with files fetched from disk.
  SS.app = { addFiles, state, effRange, setRange, current };
  rebuild();
  renderHistory();
  restore();
})();
