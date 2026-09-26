// StreamScope UI: file intake → sessions table → session detail (range, markers, charts, benchmark,
// client stats, diagnostics) → history & compare.
(() => {
  const $ = s => document.querySelector(s);
  const { fmt: tfmt, parse: tparse, clock, date } = SS.time;
  const { num, esc } = SS.fmt;
  const DIAG_OPTS = { trimStart: 60, trimEnd: 20 };
  const statusLabel = { ok: 'Czysta', warn: 'Uwagi', crit: 'Problem' };

  const state = {
    hosts: new Map(), logs: new Map(), diag: new Map(),
    sessions: [], selected: null, ranges: new Map(), timeBase: 'client', compare: new Set()
  };

  // ---------- file intake ----------
  // Parses one file into state. Returns { key, kind } when added, throws with a user-facing reason otherwise.
  function ingest(n, text, msgs) {
    if (/\.json$/i.test(n) || /^\s*[{[]/.test(text.slice(0, 50))) {
      if (/^CapFrameX/i.test(n) || /"Runs"\s*:/.test(text.slice(0, 4000))) throw new Error('CapFrameX jeszcze nieobsługiwany');
      const h = SS.parseVibepollo(n, text);
      if (state.hosts.has(h.key)) throw new Error(`duplikat ${state.hosts.get(h.key).name}`);
      state.hosts.set(h.key, h);
      state.diag.set(h.key, SS.Diag.analyze(h, DIAG_OPTS));
      if (h.truncated) msgs.push(`${n}: Vibepollo obciął próbki lub zdarzenia (samples_truncated).`);
      return { key: 'h:' + h.key, kind: 'host' };
    }
    if (/(StreamLight|Moonlight)-\d+/i.test(n) || /SDL Info \(\d+\)|Global video stats/.test(text.slice(0, 200000))) {
      const c = SS.parseClientLog(n, text);
      if (state.logs.has(c.key)) throw new Error('duplikat');
      if (!c.streams.length) throw new Error('brak streamu w logu');
      if (c.epoch == null) msgs.push(`${n}: brak czasu uniksowego w nazwie pliku, nie da się go zsynchronizować z hostem.`);
      state.logs.set(c.key, c);
      return { key: 'c:' + c.key, kind: 'client' };
    }
    throw new Error('nieznany format');
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
    if (skipped.length) msgs.push('Pominięto: ' + skipped.join('; '));
    notice(msgs.join(' '), skipped.length && !added ? 'err' : '');
    if (added) { state.selected = null; SS.Store.persist(); }
    rebuild();
    storageInfo();
  }

  // Startup: bring back every file and range saved in earlier visits.
  async function restore() {
    let files = [], ranges = [];
    try { [files, ranges] = await Promise.all([SS.Store.allFiles(), SS.Store.allRanges()]); }
    catch (e) { notice('Pamięć przeglądarki jest niedostępna (np. tryb prywatny). Wczytane pliki nie zostaną zapamiętane.', 'err'); return; }
    ranges.forEach(r => state.ranges.set(r.id, { a: r.a, b: r.b, trimMin: r.trimMin || 0 }));
    const msgs = [];
    files.sort((a, b) => a.savedAt - b.savedAt).forEach(f => { try { ingest(f.name, f.text, msgs); } catch (e) { /* stale duplicate etc. */ } });
    if (files.length) rebuild();
    storageInfo();
  }

  async function storageInfo() {
    const el = $('#storeInfo'); if (!el) return;
    const n = state.hosts.size + state.logs.size;
    const u = await SS.Store.usage();
    const word = n === 1 ? 'plik' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'pliki' : 'plików';
    el.textContent = n ? `Zapamiętane w tej przeglądarce: ${n} ${word}${u && u.usage ? ` (${num(u.usage / 1048576, 1)} MB)` : ''}. Wczytają się same przy następnym otwarciu.` : '';
  }

  function notice(msg, kind) {
    const n = $('#notice');
    n.hidden = !msg; n.className = 'notice' + (kind ? ' ' + kind : ''); n.textContent = msg || '';
  }

  function rebuild() {
    state.sessions = SS.Session.build([...state.hosts.values()], [...state.logs.values()]);
    if (!state.sessions.find(s => s.id === state.selected)) {
      const paired = state.sessions.find(s => s.host && s.clients.length);
      state.selected = (paired || state.sessions[0] || {}).id || null;
    }
    renderSessions();
    renderDetail();
  }

  const current = () => state.sessions.find(s => s.id === state.selected);
  const diagOf = s => s && s.host ? state.diag.get(s.host.key) : null;

  // ---------- sessions table ----------
  function modeOf(s) {
    const h = s.host, st = s.clients[0] && s.clients[0].stream;
    const w = h ? h.width : st && st.width, hh = h ? h.height : st && st.height;
    const fps = h ? h.target : st && st.fps, codec = (h && h.codec) || (st && st.codec) || '';
    return w ? `${codec} ${w}×${hh}@${fps}` : '—';
  }
  function clientCell(s) {
    if (!s.clients.length) return '<span class="muted">—</span>';
    const names = [...new Set(s.clients.map(c => c.log.client))].join(', ');
    const n = s.clients.length > 1 ? ` ×${s.clients.length}` : '';
    const off = s.host && s.log ? ` <span class="muted small">(${s.offset >= 0 ? '+' : ''}${num(s.offset, 1)} s)</span>` : '';
    return `${esc(names)}${n}${off}`;
  }
  function renderSessions() {
    const body = $('#sessBody');
    const S = state.sessions;
    $('#sessCount').textContent = S.length ? `${S.length} ${S.length === 1 ? 'sesja' : S.length % 10 >= 2 && S.length % 10 <= 4 && (S.length % 100 < 10 || S.length % 100 >= 20) ? 'sesje' : 'sesji'} · ${state.hosts.size} plików hosta · ${state.logs.size} logów klienta` : '';
    if (!S.length) { body.innerHTML = `<tr><td colspan="8" class="empty">Brak plików. Przeciągnij pliki powyżej.</td></tr>`; return; }
    body.innerHTML = S.map(s => {
      const d = diagOf(s);
      const tags = d ? d.findings.filter(f => f.sev !== 'info').map(f => f.title).join(' · ') || 'brak' : '';
      const fps = d ? `${num(d.stats.baseline, 0)} / ${s.host.target}` : (s.clients[0].stream.stats ? `${num(s.clients[0].stream.stats.incoming, 0)} (klient)` : '—');
      return `<tr class="pick${s.id === state.selected ? ' sel' : ''}" data-id="${esc(s.id)}" tabindex="0">
        <td>${d ? `<span class="pill ${d.status}">${statusLabel[d.status]}</span>` : '<span class="pill raw">bez hosta</span>'}</td>
        <td class="app">${esc(s.app)}</td><td class="num">${date(s.t0)}</td><td class="num">${tfmt(s.t1 - s.t0)}</td>
        <td class="mono small">${esc(modeOf(s))}</td><td>${clientCell(s)}</td><td class="num">${fps}</td>
        <td class="wrap small">${esc(tags)}</td></tr>`;
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
  }

  // Forget one session: its host file plus client logs that pair with nothing else.
  async function removeSession(s) {
    if (!confirm(`Usunąć sesję „${s.app}” z ${date(s.t0)} z pamięci przeglądarki? Zapisane podsumowania w Historii zostaną.`)) return;
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

  // ---------- detail ----------
  function renderDetail() {
    const el = $('#detail');
    const s = current();
    if (!s) { el.innerHTML = ''; return; }
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
          <button class="small" type="button" id="removeBtn">Usuń sesję z pamięci</button>
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
        ${markerTable(s)}
      </section>
      <section class="panel" aria-labelledby="cTitle">
        <div class="panel-head"><h2 id="cTitle">Przebieg</h2><span class="muted small">Przeciągnij po wykresie, żeby wybrać zakres.</span></div>
        ${h ? `<div class="legend">
          <span><i style="background:var(--s-fps)"></i>FPS (actual_fps)</span><span><i style="background:var(--s-br)"></i>Bitrate</span><span><i style="background:var(--s-enc)"></i>Enkodowanie / enkoder GPU</span><span><i style="background:var(--s-cpu)"></i>CPU hosta</span><span><i style="background:var(--s-gpu)"></i>GPU hosta</span>
          <span><i style="background:var(--mk-off)"></i>pad OFF</span><span><i style="background:var(--mk-on)"></i>pad ON</span><span><i style="background:var(--warn)"></i>RFI (klient)</span><span><i style="background:var(--crit)"></i>IDR / przepełnienie</span>
          <span><i class="box" style="background:var(--shade-crit)"></i>brak klatek</span><span><i class="box" style="background:var(--shade-warn)"></i>przeciążenie GPU</span><span><i class="box" style="background:var(--dim)"></i>poza zakresem</span>
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
    el.querySelectorAll('[data-mk]').forEach(b => b.addEventListener('click', () => {
      const m = s.markers[+b.dataset.mk];
      setRange(s, b.dataset.as === 'start' ? { a: m.u } : { b: m.u, trimMin: 0 });
    }));
    $('#removeBtn').addEventListener('click', () => removeSession(s));
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
        <button type="button" id="rLongest">Najdłuższe połączenie</button>
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

  function drawChart(s, e) {
    const el = $('#dChart'); if (!el || !s.host) return;
    const h = s.host, d = diagOf(s);
    const epi = [];
    if (d) {
      const add = (eps, fill) => eps.forEach(x => { const a = h.t0 + x.t - d.dt / 2; epi.push({ a, b: a + x.dur, fill }); });
      add(d.epsStarve, 'var(--shade-crit)'); add(d.epsGpu, 'var(--shade-warn)'); add(d.epsBusy, 'var(--shade-info)');
    }
    SS.Chart.draw(el, {
      host: h, t0: s.t0, t1: s.t1, range: e, markers: s.markers, events: s.events, episodes: epi, segs: h.segs,
      fmtAxis: u => fmtU(s, u), axisBase: base0(s),
      panels: [
        { label: 'FPS', h: 150, minMax: h.target || 60, series: [{ get: x => x.actual_fps, c: 'var(--s-fps)', w: 1.6 }], refLines: [{ v: h.target, c: 'var(--muted)' }] },
        { label: 'Mb/s', h: 90, series: [{ get: x => (x.actual_bitrate_kbps || 0) / 1000, c: 'var(--s-br)' }], refLines: [{ v: h.reqBitrate ? h.reqBitrate / 1000 : null, c: 'var(--muted)' }] },
        { label: 'ms enk.', h: 80, minMax: 12, series: [{ get: x => x.encode_latency_ms, c: 'var(--s-enc)', skipZero: true }] },
        { label: '% obciążenia', h: 100, max: 100, series: [{ get: x => x.host_cpu_percent, c: 'var(--s-cpu)', w: 1.1 }, { get: x => x.host_gpu_percent, c: 'var(--s-gpu)', w: 1.1 }, { get: x => x.host_gpu_encoder_percent, c: 'var(--s-enc)', w: 1.1 }] }
      ],
      tipRows: x => `<br>FPS ${num(x.actual_fps, 1)}<br>Bitrate ${num((x.actual_bitrate_kbps || 0) / 1000, 1)} Mb/s<br>Enk. ${x.encode_latency_ms ? num(x.encode_latency_ms, 1) + ' ms' : '—'} · ${num(x.host_gpu_encoder_percent, 0)}%<br>CPU ${num(x.host_cpu_percent, 0)}% · GPU ${num(x.host_gpu_percent, 0)}%`,
      onRange: (a, b) => setRange(s, { a, b, trimMin: 0 })
    });
  }

  const stat = (k, v, unit, hl) => `<div class="stat${hl ? ' hl' : ''}"><span class="k">${k}</span><span class="v">${v}${unit ? ` <small>${unit}</small>` : ''}</span></div>`;

  function benchHtml(s, b) {
    const H = b.host;
    if (!s.host) return `<p class="muted">Benchmark FPS, bitrate i enkodowania liczy się z próbek hosta. Dodaj plik <span class="mono">sunshine-session-*.json</span> z tej sesji.</p>`;
    if (!H) return `<p class="muted">W wybranym zakresie jest mniej niż 2 próbki hosta. Poszerz zakres.</p>`;
    const ev = b.clientEvents;
    const target = s.host.target;
    return `<div class="stats">
      ${stat('Śr. FPS', num(H.fpsAvg, 2), target ? '/ ' + target : '', true)}
      ${stat('P50 (mediana)', num(H.fpsP50, 1), '', true)}
      ${stat('P5', num(H.fpsP5, 1), '', true)}
      ${stat('P1', num(H.fpsP1, 1), '', true)}
      ${stat('FPS z frames_sent', num(H.fpsSent, 2), H.fpsSent != null ? `Δ ${num(H.fpsSent - H.fpsAvg, 2)}` : '')}
      ${stat('FPS ≥ 90', num(H.pct90, 1), '% czasu')}
      ${stat('FPS ≥ 100', num(H.pct100, 1), '% czasu')}
      ${stat('Bitrate śr. / P95', `${num(H.bitrateAvg, 1)} / ${num(H.bitrateP95, 1)}`, 'Mb/s')}
      ${stat('Enkodowanie śr.', num(H.encAvg, 2), 'ms')}
      ${stat('Enkodowanie P50 / P95', `${num(H.encP50, 1)} / ${num(H.encP95, 1)}`, 'ms')}
      ${stat('Enkodowanie max', num(H.encMax, 1), 'ms')}
      ${stat('GPU / enkoder śr.', `${num(H.gpuAvg, 0)} / ${num(H.gpuEncAvg, 0)}`, '%')}
      ${stat('CPU hosta śr.', num(H.cpuAvg, 0), '%')}
      ${stat('Temp. GPU max', num(H.gpuTempMax, 0), '°C')}
      ${stat('Straty / dropy wideo', `${H.losses} / ${H.videoDropped}`)}
      ${stat('IDR / ref. invalid.', `${H.idr} / ${H.refInv}`)}
      ${stat('RFI / IDR u klienta', s.clients.length ? `${ev.rfi} / ${ev.idr}` : '—', ev.overflow ? `+${ev.overflow} przepełn.` : '')}
      ${stat('Próbki / połączenia', `${H.n} / ${H.segments}`)}
    </div>`;
  }

  const yesNo = v => v == null ? '—' : v ? 'tak' : 'nie';
  function clientHtml(s, b) {
    if (!s.clients.length) return `<p class="muted">Brak logu klienta z tej sesji. Dodaj <span class="mono">StreamLight-*.log</span> z klienta.</p>`;
    const list = b.clients.length ? b.clients : s.clients;
    const note = b.clients.length ? '' : '<p class="caveat">Żaden stream klienta nie pokrywa się z wybranym zakresem. Poniżej wszystkie streamy z tej sesji.</p>';
    return note + `<div class="two">${list.map(c => streamCard(s, c)).join('')}</div>
      <p class="caveat">Statystyki klienta pochodzą z bloku „Global video stats” i dotyczą całego streamu, nie wybranego zakresu.</p>`;
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
    return SS.Report.summary(s, bench, label, diagOf(s));
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
    if (!list.length) { body.innerHTML = `<tr><td colspan="11" class="empty">Brak zapisanych sesji. W widoku Analiza wybierz zakres i kliknij „Zapisz do historii”.</td></tr>`; }
    else body.innerHTML = list.map(x => `<tr>
        <td><input type="checkbox" data-cmp="${esc(x.id)}" ${state.compare.has(x.id) ? 'checked' : ''} aria-label="Zaznacz do porównania"></td>
        <td class="num">${date(x.date)}</td><td class="app">${esc(x.app)}</td><td>${esc(x.streamer || '—')}</td>
        <td class="mono small">${esc([x.codec, x.resolution && x.resolution.replace('x', '×') + (x.target_fps ? '@' + x.target_fps : ''), x.bitrate_setting_mbps ? x.bitrate_setting_mbps + ' Mb/s' : ''].filter(Boolean).join(' '))}</td>
        <td class="small">${esc(x.range || '')}</td>
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
    ['Konfiguracja', null],
    ['Klient', x => x.streamer], ['Tryb', x => [x.codec, x.resolution, x.target_fps && '@' + x.target_fps].filter(Boolean).join(' ')],
    ['Bitrate ustawiony (Mb/s)', x => x.bitrate_setting_mbps, 0], ['Długość zakresu', x => x.duration_s, 't'],
    ['Host', null],
    ['Śr. FPS', x => x.host && x.host.avg_fps, 2], ['P50 FPS', x => x.host && x.host.p50_fps, 1], ['P5 FPS', x => x.host && x.host.p5_fps, 1], ['P1 FPS', x => x.host && x.host.p1_fps, 1],
    ['FPS z frames_sent', x => x.host && x.host.frames_sent_fps, 2], ['FPS ≥ 90 (%)', x => x.host && x.host.pct_ge_90, 1], ['FPS ≥ 100 (%)', x => x.host && x.host.pct_ge_100, 1],
    ['Bitrate śr. (Mb/s)', x => x.host && x.host.bitrate_avg_mbps, 1], ['Bitrate P95 (Mb/s)', x => x.host && x.host.bitrate_p95_mbps, 1],
    ['Enkodowanie śr. (ms)', x => x.host && x.host.encode_avg_ms, 2], ['Enkodowanie P95 (ms)', x => x.host && x.host.encode_p95_ms, 1],
    ['GPU śr. (%)', x => x.host && x.host.gpu_avg_pct, 0], ['Enkoder śr. (%)', x => x.host && x.host.encoder_avg_pct, 0],
    ['Straty / dropy', x => x.host && `${x.host.client_reported_losses} / ${x.host.video_dropped}`],
    ['Klient (cały stream)', null],
    ['Odbierane FPS', x => x.client && x.client.incoming_fps, 2], ['Renderowane FPS', x => x.client && x.client.rendering_fps, 2],
    ['Utrata sieć (%)', x => x.client && x.client.network_loss_pct, 2], ['Utrata jitter (%)', x => x.client && x.client.jitter_loss_pct, 2],
    ['Opóźnienie sieci (ms)', x => x.client && x.client.network_latency_ms, 0], ['Dekodowanie (ms)', x => x.client && x.client.decode_ms, 2],
    ['Kolejka (ms)', x => x.client && x.client.queue_ms, 2], ['Renderowanie (ms)', x => x.client && x.client.render_ms, 2],
    ['VRR', x => x.client && x.client.vrr], ['Smoothness 2m (%)', x => x.client && x.client.smoothness_2m_pct, 2],
    ['RFI w zakresie', x => x.client_events && x.client_events.rfi, 0]
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
    const hist = which === 'history';
    $('#tabAnalyze').setAttribute('aria-selected', !hist); $('#tabHistory').setAttribute('aria-selected', hist);
    $('#viewAnalyze').hidden = hist; $('#viewHistory').hidden = !hist;
    if (hist) renderHistory();
    else { const s = current(); if (s) updateRangeViews(); }
  }
  $('#tabAnalyze').addEventListener('click', () => showTab('analyze'));
  $('#tabHistory').addEventListener('click', () => showTab('history'));

  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(e => drop.addEventListener(e, ev => { ev.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', ev => { const fl = [...(ev.dataTransfer?.files || [])]; if (fl.length) addFiles(fl); });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => e.preventDefault());
  $('#files').addEventListener('change', e => { addFiles([...e.target.files]); e.target.value = ''; });
  $('#pickBtn').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#files').click(); } });
  $('#clearBtn').addEventListener('click', async () => {
    if (!state.hosts.size && !state.logs.size) return;
    if (!confirm('Usunąć wszystkie wczytane pliki z pamięci tej przeglądarki? Zapisane podsumowania w Historii zostaną.')) return;
    await SS.Store.clearAll().catch(() => {});
    state.hosts.clear(); state.logs.clear(); state.diag.clear(); state.ranges.clear(); state.selected = null; notice(''); rebuild(); storageInfo();
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
