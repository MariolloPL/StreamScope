// Stream scores 1–10 for an analysed range. Deterministic and explainable: every score comes with the
// numbers it was built from. Thresholds are tuned for a wired-LAN home setup (Vibepollo/StreamLight at
// 1440p–4K, 60–120 FPS); they describe the stream experience, so a game-limited FPS lowers "FPS" too.
SS.Score = (() => {
  // Linear map to 1..10 between a "bad" and a "good" value (works for both directions).
  const lin = (v, bad, good) => (v == null || !isFinite(v)) ? null : Math.max(1, Math.min(10, 1 + 9 * (v - bad) / (good - bad)));
  const clamp = v => Math.max(1, Math.min(10, v));
  const f = (v, d = 1) => v == null || !isFinite(v) ? '—' : v.toFixed(d).replace('.', ',');

  const WEIGHTS = { fps: 0.25, stability: 0.2, latency: 0.25, network: 0.2, image: 0.1 };
  const LABELS = { fps: 'FPS', stability: 'Stabilność', latency: 'Opóźnienie', network: 'Sieć', image: 'Obraz', headroom: 'Zapas hosta' };

  // Bits per pixel per frame needed for a comparable picture, relative to HEVC.
  const CODEC_FACTOR = { HEVC: 1, H265: 1, AV1: 0.8, 'H.264': 1.4, H264: 1.4 };
  function imageScore(mbps, w, h, fps, codec) {
    if (!mbps || !w || !h || !fps) return null;
    const c = String(codec || '').toUpperCase().replace('H.265', 'HEVC');
    if (/PYROWAVE/.test(c)) return { score: null, why: 'n/d: PyroWave to kodek wewnątrzklatkowy z zupełnie inną skalą bitrate, nie da się go uczciwie porównać z HEVC/H.264.' };
    const factor = CODEC_FACTOR[c] ?? CODEC_FACTOR[c.replace(/[^A-Z0-9.]/g, '')] ?? 1;
    const bpp = mbps * 1e6 / (w * h * fps);
    return { score: lin(bpp / factor, 0.03, 0.15), why: `${f(mbps)} Mb/s przy ${w}×${h} i ${f(fps, 0)} FPS = ${f(bpp, 3)} bita na piksel na klatkę (${c || 'kodek ?'}${factor !== 1 ? `, przelicznik ${f(factor, 1)}` : ''}); ≥0,15 = 10, ≤0,03 = 1.` };
  }

  function overall(parts) {
    let w = 0, s = 0;
    for (const [k, wt] of Object.entries(WEIGHTS)) if (parts[k] && parts[k].score != null) { w += wt; s += wt * parts[k].score; }
    return w ? s / w : null;
  }
  const pack = parts => {
    const o = overall(parts);
    return { overall: o, parts, LABELS };
  };

  // Vibepollo host samples in range (+ StreamLight/Moonlight end-of-stream stats when paired).
  function vibepollo(session, bench) {
    const H = bench.host;
    if (!H) return null;
    const target = session.host.target || 120;
    const c = bench.clients.length ? [...bench.clients].sort((a, b) => (b.u1 - b.u0) - (a.u1 - a.u0))[0].stream.stats : null;
    const parts = {};

    const ratio = H.fpsAvg / target;
    parts.fps = { score: lin(ratio, 0.5, 0.95), why: `Średnio ${f(H.fpsAvg)} z ${target} FPS (${f(ratio * 100, 0)}%); ≥95% = 10, ≤50% = 1. Jeśli limitem jest sama gra, ta ocena też spada.` };

    const lowRatio = H.fpsAvg ? H.fpsP1 / H.fpsAvg : null;
    parts.stability = { score: lin(lowRatio, 0.5, 0.9), why: `P1 = ${f(H.fpsP1)} FPS, czyli ${f(lowRatio * 100, 0)}% średniej (P5 ${f(H.fpsP5)}); ≥90% = 10, ≤50% = 1.` };

    const T = bench.clientTrace;
    if (T && T.lat50 != null) {
      // Range-accurate client side: receive→present (covers decode, queue and render) from the VRR capture.
      const net = c && c.netLatency != null ? c.netLatency : 1;
      const total = (H.encAvg || 0) + net + T.lat50;
      let s = lin(total, 40, 8);
      const spikes = H.encP95 != null && H.encP95 > 20;
      if (spikes) s = clamp(s - 1);
      parts.latency = { score: s, why: `Enkodowanie ${f(H.encAvg, 1)} + sieć ${f(net, 0)} + odbiór→ekran u klienta ${f(T.lat50, 1)} (P50 w zakresie) = ${f(total, 1)} ms; ≤8 ms = 10, ≥40 ms = 1${spikes ? `; −1 za skoki enkodowania (P95 ${f(H.encP95)} ms)` : ''}.` };
    } else if (c && c.netLatency != null) {
      const total = (H.encAvg || 0) + (c.netLatency || 0) + (c.decodeMs || 0) + (c.queueMs || 0) + (c.renderMs || 0);
      let s = lin(total, 40, 8);
      const spikes = H.encP95 != null && H.encP95 > 20;
      if (spikes) s = clamp(s - 1);
      parts.latency = { score: s, why: `Enkodowanie ${f(H.encAvg, 1)} + sieć ${f(c.netLatency, 0)} + dekodowanie ${f(c.decodeMs, 2)} + kolejka ${f(c.queueMs, 2)} + renderowanie ${f(c.renderMs, 2)} = ${f(total, 1)} ms; ≤8 ms = 10, ≥40 ms = 1${spikes ? `; −1 za skoki enkodowania (P95 ${f(H.encP95)} ms)` : ''}.` };
    } else {
      parts.latency = { score: lin(H.encAvg, 25, 4), why: `Tylko enkodowanie na hoście: średnio ${f(H.encAvg, 1)} ms (≤4 = 10, ≥25 = 1). Dodaj log klienta, żeby ocena objęła sieć, dekodowanie i wyświetlanie.` };
    }

    const hours = Math.max(bench.dur / 3600, 1 / 60);
    const ev = bench.clientEvents || {};
    const pen = [];
    let s = 10;
    if (H.losses > 0) { s -= 3; pen.push(`${H.losses} strat pakietów −3`); }
    if (H.videoDropped > 0) { s -= 2; pen.push(`${H.videoDropped} dropów wideo −2`); }
    if (c && c.netLossPct) { const p = Math.min(3, c.netLossPct * 20); s -= p; pen.push(`utrata w sieci ${f(c.netLossPct, 2)}% −${f(p, 1)}`); }
    // With a per-frame capture, client-side drops are counted for the range below (not the whole stream).
    if (c && c.jitterLossPct && !(T && T.dropped != null)) { const p = Math.min(3, c.jitterLossPct * 10); s -= p; pen.push(`utrata przez jitter ${f(c.jitterLossPct, 2)}% −${f(p, 1)}`); }
    if (ev.rfi) { const p = Math.min(2, ev.rfi / hours * 0.1); s -= p; pen.push(`${ev.rfi} RFI (${f(ev.rfi / hours, 1)}/h) −${f(p, 1)}`); }
    if (ev.idr) { const p = Math.min(3, ev.idr / hours * 0.3); s -= p; pen.push(`${ev.idr} IDR u klienta −${f(p, 1)}`); }
    if (T && T.dropped) { const p = Math.min(2, T.droppedPerMin * 0.2); s -= p; pen.push(`${T.dropped} klatek odrzuconych przez klienta (${f(T.droppedPerMin, 1)}/min) −${f(p, 1)}`); }
    parts.network = { score: clamp(s), why: pen.length ? `10 punktów minus: ${pen.join(', ')}.` : `Brak strat, dropów i zdarzeń odzyskiwania obrazu w zakresie.${c ? '' : ' (Bez logu klienta widać tylko straty zgłoszone hostowi.)'}` };

    const h = session.host;
    const img = imageScore(H.bitrateAvg, h.width, h.height, H.fpsAvg, h.codec);
    if (img) parts.image = img;

    const peak = Math.max(H.gpuAvg || 0, H.gpuEncAvg || 0, H.cpuAvg || 0);
    parts.headroom = { score: lin(peak, 98, 60), why: `Najbardziej obciążony: ${peak === H.cpuAvg ? 'CPU' : peak === H.gpuEncAvg ? 'enkoder GPU' : 'GPU'} średnio ${f(peak, 0)}% (GPU ${f(H.gpuAvg, 0)}%, enkoder ${f(H.gpuEncAvg, 0)}%, CPU ${f(H.cpuAvg, 0)}%); ≤60% = 10, ≥98% = 1. Tylko informacyjnie.` };
    return pack(parts);
  }

  // Steam Remote Play: duration-weighted averages of the chosen segments.
  function steam(segs, sum) {
    if (!sum || !sum.n) return null;
    const last = segs[segs.length - 1];
    const limit = last.fpsLimit || 120;
    const parts = {};
    const ratio = sum.fps / limit;
    parts.fps = { score: lin(ratio, 0.5, 0.95), why: `Średnio ${f(sum.fps)} z ${limit} FPS (${f(ratio * 100, 0)}%); ≥95% = 10, ≤50% = 1. AvgFPS Steama to kadencja streamu.` };

    let w = 0, sd = 0;
    segs.forEach(g => { if (g.fpsSd != null && g.dur > 0) { w += g.dur; sd += g.fpsSd * g.dur; } });
    const cv = w && sum.fps ? (sd / w) / sum.fps : null;
    parts.stability = { score: lin(cv, 0.35, 0.05), why: `Odchylenie FPS średnio ${f(w ? sd / w : null)} przy ${f(sum.fps)} FPS (${f(cv * 100, 0)}% średniej); ≤5% = 10, ≥35% = 1. Steam nie podaje percentyli.` };

    const stages = [['przechwytywanie', sum.captureMs], ['konwersja', sum.convertMs], ['enkodowanie', sum.encodeMs], ['sieć', sum.networkMs], ['dekodowanie', sum.decodeMs], ['wyświetlanie', sum.displayMs]];
    const known = stages.filter(([, v]) => v != null);
    const total = known.reduce((a, [, v]) => a + v, 0);
    const missing = stages.filter(([, v]) => v == null).map(([k]) => k);
    // Unmeasured stages (PyroWave reports 0 for capture/convert/encode) would make latency look perfect;
    // cap the score so Steam doesn't beat a fully measured StreamLight pipeline on missing data.
    const LAT_CAP = 8.5;
    let lat = lin(total, 40, 8);
    const capped = missing.length && lat > LAT_CAP;
    if (capped) lat = LAT_CAP;
    parts.latency = { score: lat, why: `${known.map(([k, v]) => `${k} ${f(v, 2)}`).join(' + ')} = ${f(total, 1)} ms; ≤8 ms = 10, ≥40 ms = 1.${missing.length ? ` Steam nie zmierzył: ${missing.join(', ')}${capped ? `, więc ocena ograniczona do ${f(LAT_CAP, 1)}` : ''}.` : ''}` };

    const pen = [];
    let s = 10;
    const sn = sum.slow.network || 0;
    if (sn) { const p = Math.min(4, sn * 0.5); s -= p; pen.push(`sieć spowalniała ${f(sn, 1)}% czasu −${f(p, 1)}`); }
    if (sum.pingMs > 3) { const p = Math.min(3, (sum.pingMs - 3) * 0.5); s -= p; pen.push(`ping ${f(sum.pingMs, 1)} ms −${f(p, 1)}`); }
    const util = sum.linkMbps ? sum.serverMbps / sum.linkMbps : null;
    if (util > 0.6) { const p = Math.min(3, (util - 0.6) * 10); s -= p; pen.push(`bitrate ${f(util * 100, 0)}% łącza −${f(p, 1)}`); }
    parts.network = { score: clamp(s), why: pen.length ? `10 punktów minus: ${pen.join(', ')}. Steam nie raportuje strat pakietów.` : `Sieć nie spowalniała streamu, ping ${f(sum.pingMs, 1)} ms, bitrate ${f((util || 0) * 100, 0)}% łącza.` };

    const mc = last.width ? { w: last.width, h: last.height } : null;
    const img = mc ? imageScore(sum.serverMbps, mc.w, mc.h, sum.fps, last.pyrowave ? 'PyroWave' : (last.encoder || '').replace(/^.*?(H\.?26[45]|HEVC|AV1).*$/i, '$1')) : null;
    if (img) parts.image = img;

    const hostSlow = ['game', 'capture', 'convert', 'encode'].reduce((a, k) => a + (sum.slow[k] || 0), 0);
    parts.headroom = { score: lin(hostSlow, 20, 0), why: `Host (gra, przechwytywanie, konwersja, enkodowanie) spowalniał stream ${f(hostSlow, 1)}% czasu; 0% = 10, ≥20% = 1. Tylko informacyjnie.` };
    return pack(parts);
  }

  const cls = s => s == null ? 'raw' : s >= 8 ? 'ok' : s >= 5 ? 'warn' : 'crit';
  // Compact form for history/reports.
  const compact = sc => sc ? Object.fromEntries([['overall', sc.overall], ...Object.entries(sc.parts).map(([k, v]) => [k, v.score])].map(([k, v]) => [k, v == null ? null : Math.round(v * 10) / 10])) : null;

  return { vibepollo, steam, cls, compact, LABELS, WEIGHTS };
})();
