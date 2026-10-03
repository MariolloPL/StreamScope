// Diagnostic engine for Vibepollo/Sunshine session JSON, ported from the miniPC analyzer (analizator-sesji.html).
// Rules are documented in claude/streamscope-handoff.md; keep them in sync when changing thresholds.
const Engine = (() => {
  const SAMPLE_MIN_FPS = 5;          // below this a sample is treated as "stream not flowing yet"
  const SETTINGS_GAP_MAX = 3.5;      // reconnect gap (s) typical of a deliberate settings change
  const SEG_WARMUP_SAMPLES = 3;      // samples skipped after each (re)connect

  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const max = a => a.length ? Math.max(...a) : null;
  const eps = n => `${n} ${n === 1 ? 'epizod' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'epizody' : 'epizodów'}`;

  function parse(name, text) {
    const d = JSON.parse(text);
    if (!d || !Array.isArray(d.samples)) throw new Error('Brak tablicy "samples" — to nie wygląda na plik sesji Vibepollo.');
    const t0 = d.start_time_unix ?? (d.samples[0] && d.samples[0].timestamp_unix);
    const tEnd = d.end_time_unix ?? (d.samples.length ? d.samples[d.samples.length - 1].timestamp_unix : t0);
    return { name, raw: d, t0, tEnd };
  }

  // Per-sample deltas for counters that are cumulative within a session_uuid.
  function counterDeltas(samples, key) {
    const out = []; let prevU = null, prev = 0;
    for (const s of samples) {
      const v = +s[key] || 0;
      if (s.session_uuid !== prevU) { out.push(0); prevU = s.session_uuid; prev = v; continue; }
      out.push(v >= prev ? v - prev : v); prev = v;
    }
    return out;
  }
  function counterTotal(samples, key) {
    // Sum over segments of (last - first) plus resets; the first value of a segment is its baseline.
    let total = 0, prevU = null, prev = 0;
    for (const s of samples) {
      const v = +s[key] || 0;
      if (s.session_uuid !== prevU) { prevU = s.session_uuid; prev = v; total += (key === 'idr_requests' || key === 'ref_invalidations') ? 0 : v; continue; }
      total += v >= prev ? v - prev : v; prev = v;
    }
    return total;
  }

  function segments(f) {
    const segs = []; let cur = null;
    for (const s of f.raw.samples) {
      if (!cur || cur.uuid !== s.session_uuid) { cur = { uuid: s.session_uuid, t0: s.timestamp_unix, t1: s.timestamp_unix, n: 0 }; segs.push(cur); }
      cur.t1 = s.timestamp_unix; cur.n++;
    }
    // Prefer precise boundaries from events when present.
    const ev = f.raw.events || [];
    for (const g of segs) {
      const st = ev.find(e => e.session_uuid === g.uuid && e.event_type === 'stream_started');
      const en = ev.find(e => e.session_uuid === g.uuid && e.event_type === 'stream_ended');
      if (st) g.t0 = st.timestamp_unix; if (en) g.t1 = en.timestamp_unix;
    }
    const gaps = [];
    for (let i = 1; i < segs.length; i++) {
      const gap = segs[i].t0 - segs[i - 1].t1;
      gaps.push({ at: segs[i - 1].t1 - f.t0, gap, kind: gap <= SETTINGS_GAP_MAX ? 'settings' : 'irregular' });
    }
    return { segs, gaps };
  }

  function groupEpisodes(flags, samples, t0, dt) {
    const eps = []; let cur = null;
    flags.forEach((on, i) => {
      if (on) { if (cur && i - cur.end <= 2) cur.end = i; else { cur = { start: i, end: i }; eps.push(cur); } }
    });
    return eps.map(e => ({ ...e, t: samples[e.start].timestamp_unix - t0, dur: (e.end - e.start + 1) * dt }));
  }

  function analyze(f, opts) {
    const d = f.raw, S = d.samples, n = S.length;
    const dur = d.duration_seconds ?? (f.tEnd - f.t0);
    const ts = S.map(s => s.timestamp_unix);
    const dts = ts.slice(1).map((t, i) => t - ts[i]);
    const dt = Math.round((median(dts) || 2) * 100) / 100;
    const target = d.target_fps || 120;

    const trimStart = Math.min(opts.trimStart, dur * 0.2);
    const trimEnd = Math.min(opts.trimEnd, dur * 0.1);
    const { segs, gaps } = segments(f);

    // Analysis window: trim head/tail of the file, skip warm-up after each reconnect, drop non-flowing samples.
    const segStartIdx = new Set(); { let pu = null; S.forEach((s, i) => { if (s.session_uuid !== pu) { for (let k = 0; k < SEG_WARMUP_SAMPLES; k++) segStartIdx.add(i + k); pu = s.session_uuid; } }); }
    const inWin = S.map((s, i) => {
      const rel = s.timestamp_unix - f.t0;
      return rel >= trimStart && rel <= dur - trimEnd && !segStartIdx.has(i) && s.actual_fps > SAMPLE_MIN_FPS;
    });
    const W = S.filter((_, i) => inWin[i]);
    const col = k => W.map(s => +s[k] || 0);

    const fpsW = col('actual_fps');
    const baseline = median(fpsW) || target;
    const encMed = median(col('host_gpu_encoder_percent')) || 0;

    // Signatures (evaluated only inside the window).
    const lowFps = s => s.actual_fps < 0.5 * baseline;
    const sigGpuOverload = S.map((s, i) => inWin[i] && s.actual_fps < 0.6 * baseline && (s.host_gpu_percent >= 88 || s.encode_latency_ms >= 20));
    const sigStarve = S.map((s, i) => inWin[i] && !sigGpuOverload[i] && lowFps(s) && s.host_gpu_percent < 30 && s.host_cpu_percent < 60 && s.host_gpu_encoder_percent < Math.max(20, encMed * 0.6));
    const sigBusyStall = S.map((s, i) => inWin[i] && !sigGpuOverload[i] && !sigStarve[i] && lowFps(s) && s.host_gpu_percent >= 30);

    const idrD = counterDeltas(S, 'idr_requests');
    const refD = counterDeltas(S, 'ref_invalidations');
    const lossD = counterDeltas(S, 'client_reported_losses');
    const vdropD = counterDeltas(S, 'video_dropped');

    const annotate = eps => eps.map(e => {
      let idr = 0, ref = 0; for (let i = e.start; i <= Math.min(n - 1, e.end + 3); i++) { idr += idrD[i]; ref += refD[i]; }
      const sl = S.slice(e.start, e.end + 1);
      return { ...e, idr, ref, fpsMin: Math.min(...sl.map(s => s.actual_fps)), cpu: mean(sl.map(s => s.host_cpu_percent)), gpu: mean(sl.map(s => s.host_gpu_percent)), enc: mean(sl.map(s => s.encode_latency_ms)) };
    });
    const earlyLimit = Math.min(300, dur * 0.25);
    const epsStarve = annotate(groupEpisodes(sigStarve, S, f.t0, dt)).map(e => ({ ...e, early: e.t < earlyLimit }));
    const epsGpu = annotate(groupEpisodes(sigGpuOverload, S, f.t0, dt));
    const epsBusy = annotate(groupEpisodes(sigBusyStall, S, f.t0, dt));

    const losses = counterTotal(S, 'client_reported_losses');
    const vdrop = counterTotal(S, 'video_dropped');
    const adrop = counterTotal(S, 'audio_dropped');
    const idrTotal = counterTotal(S, 'idr_requests');
    const refTotal = counterTotal(S, 'ref_invalidations');
    const lossIdx = S.map((_, i) => lossD[i] + vdropD[i] > 0);

    const encLat = col('encode_latency_ms').filter(v => v > 0);
    const cpu = col('host_cpu_percent'), gpu = col('host_gpu_percent'), genc = col('host_gpu_encoder_percent');
    const cpuHot = cpu.length ? cpu.filter(v => v >= 95).length / cpu.length : 0;
    const winSec = W.length * dt;
    const jitterReliable = winSec >= 180;
    const bitrate = col('actual_bitrate_kbps').filter(v => v > 0);

    const sum = eps => eps.reduce((a, e) => a + e.dur, 0);
    const starveSec = sum(epsStarve), starveLateSec = sum(epsStarve.filter(e => !e.early)), gpuSec = sum(epsGpu), busySec = sum(epsBusy);
    const irregular = gaps.filter(g => g.kind === 'irregular');

    const findings = [];
    if (losses + vdrop > 0) findings.push({ sev: 'crit', title: 'Utrata danych w sieci', text: `client_reported_losses: ${losses}, video_dropped: ${vdrop}. To jedyny twardy dowód problemu z łączem; sprawdź kabel, Wi-Fi i obciążenie sieci w tym czasie.` });
    if (epsStarve.length) {
      const long = epsStarve.filter(e => e.dur >= 6);
      const desync = epsStarve.some(e => e.idr > 0 || e.ref > 20);
      const earlyN = epsStarve.filter(e => e.early).length;
      findings.push({ sev: starveLateSec >= 6 ? 'crit' : 'warn', title: 'Brak klatek do wysłania', text: `${eps(epsStarve.length)}, łącznie ~${Math.round(starveSec)} s${long.length ? `, najdłuższy ${Math.round(Math.max(...long.map(e => e.dur)))} s` : ''}.${earlyN ? ` ${earlyN === epsStarve.length ? 'Wszystkie' : earlyN} na początku sesji, gdy zwykle trwa jeszcze nawigacja po menu — te traktuj ostrożnie.` : ''} FPS spada przy niskim CPU/GPU hosta i niskim obciążeniu enkodera — coś przed enkoderem przestaje dostarczać klatki (przechwytywanie obrazu, proces w tle).${desync ? ' W trakcie rosną idr_requests/ref_invalidations, czyli strumień faktycznie się rozsynchronizował.' : ''} Uwaga: w menu i na statycznym pulpicie ta sama sygnatura bywa normalna, bo host nie ma czego wysyłać.` });
    }
    if (epsGpu.length) findings.push({ sev: gpuSec >= 6 ? 'crit' : 'warn', title: 'Przeciążenie GPU / enkodera', text: `${eps(epsGpu.length)}, łącznie ~${Math.round(gpuSec)} s. FPS spada o ponad 40% przy GPU ≥88% albo opóźnieniu enkodowania ≥20 ms. Pomaga niższa rozdzielczość lub bitrate.` });
    if (epsBusy.length) findings.push({ sev: 'info', title: 'Spadki FPS przy obciążonym GPU', text: `${eps(epsBusy.length)}, łącznie ~${Math.round(busySec)} s. Najczęściej ekran ładowania albo przycięcie samej gry, nie streamu. Sprawdź, co działo się wtedy w grze.` });
    if (irregular.length) findings.push({ sev: 'warn', title: 'Nieregularne przerwy w połączeniu', text: `${irregular.map(g => `${fmtT(g.at)} (${g.gap.toFixed(1).replace('.', ',')} s)`).join(', ')}. Zmiana ustawień daje równe przerwy ok. 2–2,5 s; dłuższe lub nierówne sugerują zerwanie albo zawieszenie.` });
    const settingsGaps = gaps.filter(g => g.kind === 'settings');
    if (settingsGaps.length) findings.push({ sev: 'info', title: 'Zmiany ustawień w trakcie', text: `${settingsGaps.length} krótki(ch) reconnect(ów) ~2 s — typowy ślad zmiany ustawień w kliencie, nie awarii.` });
    if (cpuHot > 0.05) findings.push({ sev: 'warn', title: 'CPU hosta na granicy', text: `CPU ≥95% w ${(cpuHot * 100).toFixed(1).replace('.', ',')}% próbek okna analizy.` });
    const encP99 = pct(encLat, 0.99);
    if (encP99 != null && encP99 > 20) findings.push({ sev: 'warn', title: 'Skoki opóźnienia enkodowania', text: `p99 = ${encP99.toFixed(1).replace('.', ',')} ms (zdrowe sesje: kilka ms, max ok. 10–15 ms).` });

    let status = 'ok';
    if (findings.some(x => x.sev === 'crit')) status = 'crit'; else if (findings.some(x => x.sev === 'warn')) status = 'warn';
    const verdictNote = (d.verdict === 'degraded' && status === 'ok') ? 'Vibepollo oznaczył sesję jako degraded, ale próbki tego nie potwierdzają.' :
      (d.verdict === 'healthy' && status !== 'ok') ? 'Vibepollo oznaczył sesję jako zdrową („healthy”), mimo to próbki pokazują problemy.' : null;

    return {
      file: f, name: f.name, app: d.app_name || '?', client: d.client_name || d.device_name || '?', server: (d.server_version || '').split(' ')[0],
      codec: d.codec, res: d.width && d.height ? `${d.width}×${d.height}` : '?', target, reqBitrate: d.requested_bitrate_kbps,
      start: f.t0, end: f.tEnd, dur, dt, n, trimStart, trimEnd, winSec, inWin, verdict: d.verdict, verdictNote, status, findings,
      segs, gaps, epsStarve, epsGpu, epsBusy, lossIdx,
      stats: {
        baseline, fpsP10: pct(fpsW, 0.1), fpsLow: fpsW.length ? fpsW.filter(v => v < 0.5 * baseline).length / fpsW.length : 0,
        encMed: median(encLat), encP99, encMax: max(encLat), cpuMean: mean(cpu), cpuHot, gpuMean: mean(gpu), gpuMax: max(gpu), gencMean: mean(genc),
        bitrateMed: median(bitrate), jitterMed: median(col('frame_interval_jitter_ms')), jitterReliable,
        gpuTempMax: max(col('host_gpu_temp_c')), losses, vdrop, adrop, idrTotal, refTotal
      }
    };
  }

  function fmtT(sec) { sec = Math.max(0, Math.round(sec)); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); }

  function crossGaps(results) {
    const r = [...results].sort((a, b) => a.start - b.start); const out = [];
    for (let i = 1; i < r.length; i++) {
      const gap = r[i].start - r[i - 1].end;
      if (gap >= 0 && gap < 1800) out.push({ from: r[i - 1], to: r[i], gap });
    }
    return out;
  }

  return { parse, analyze, crossGaps, fmtT, median };
})();
if (typeof module !== 'undefined') module.exports = Engine;

window.SS = window.SS || {};
SS.Diag = Engine;
