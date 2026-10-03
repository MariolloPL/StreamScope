// Stream verdict and scores 1–10 for an analysed range, merging StreamScope's and StreamTweak's logic:
// - like StreamTweak: latency judged in frame periods (so 60/120 FPS are treated alike), FPS left out of the
//   grade (loading screens and game limits distort it), late-frame frequency as the stutter signal, and a
//   verdict that names the checks holding it back;
// - from StreamScope: client-side pacing and end-to-end latency from Moonlight's per-frame VRR capture,
//   range-accurate inputs, and Steam Remote Play support.
// Each check uses the best source available and says which one it used.
SS.Score = (() => {
  // Piecewise-linear map through [value, score] breakpoints (values ascending or descending).
  function curve(v, pts) {
    if (v == null || !isFinite(v)) return null;
    const asc = pts[0][0] < pts[pts.length - 1][0];
    const P = asc ? pts : [...pts].reverse();
    if (v <= P[0][0]) return P[0][1];
    if (v >= P[P.length - 1][0]) return P[P.length - 1][1];
    for (let i = 1; i < P.length; i++) {
      if (v <= P[i][0]) { const [x0, y0] = P[i - 1], [x1, y1] = P[i]; return y0 + (y1 - y0) * (v - x0) / (x1 - x0); }
    }
    return null;
  }
  const clamp = v => Math.max(1, Math.min(10, v));
  const f = (v, d = 1) => v == null || !isFinite(v) ? '—' : v.toFixed(d).replace('.', ',');

  // Breakpoints chosen so 8 and 5 match StreamTweak's Excellent/Good/Poor boundaries.
  const DROPS = [[0, 10], [1, 8], [2, 5], [5, 1]];              // % of frames lost or dropped
  const RTT = [[5, 10], [25, 8], [60, 5], [150, 1]];            // ms
  const HOSTLAT = [[0.3, 10], [0.6, 8], [1, 5], [2, 1]];        // host capture+encode in frame periods
  const LATE = [[0, 10], [1, 8], [5, 5], [15, 1]];              // % of frames later than 2 frame periods
  const PACING = [[70, 1], [90, 5], [97, 8], [99.5, 10]];       // % client timing / smoothness (target 99.5)
  const E2E = [[10, 10], [20, 8], [35, 5], [60, 1]];            // ms host + network one-way + client

  const LABELS = {
    drops: 'Straty klatek', rtt: 'Sieć (RTT)', hostlat: 'Opóźnienie hosta', late: 'Spóźnione klatki',
    pacing: 'Płynność u klienta', e2e: 'Opóźnienie całkowite',
    fps: 'FPS', image: 'Obraz', headroom: 'Zapas hosta'
  };
  const GRADED = ['drops', 'rtt', 'hostlat', 'late', 'pacing', 'e2e'];
  const INFO = ['fps', 'image', 'headroom'];

  const grade = s => s == null ? null : s >= 8 ? 'Bardzo dobrze' : s >= 5 ? 'Dobrze' : 'Słabo';
  const cls = s => s == null ? 'raw' : s >= 8 ? 'ok' : s >= 5 ? 'warn' : 'crit';

  function verdict(parts) {
    const g = GRADED.filter(k => parts[k] && parts[k].score != null).map(k => [k, parts[k].score]);
    if (!g.length) return { overall: null, label: 'Brak danych', reason: 'Za mało danych do oceny.' };
    const mean = g.reduce((a, [, s]) => a + s, 0) / g.length;
    const worst = Math.min(...g.map(([, s]) => s));
    const overall = Math.min(mean, worst + 1.5);   // one weak check pulls the whole verdict down
    const holding = g.filter(([, s]) => s < 8 && s <= worst + 1).sort((a, b) => a[1] - b[1]).map(([k]) => LABELS[k].toLowerCase());
    const label = overall >= 8 ? 'Bardzo dobrze' : overall >= 6 ? 'Dobrze' : overall >= 4 ? 'Przeciętnie' : 'Słabo';
    const reason = holding.length ? `Ogranicza: ${holding.join(' i ')}` : 'Wszystkie testy na zielono';
    return { overall, label, reason };
  }
  const pack = parts => ({ ...verdict(parts), parts, LABELS });

  const CODEC_FACTOR = { HEVC: 1, AV1: 0.8, 'H.264': 1.4, H264: 1.4 };
  function imageInfo(mbps, w, h, fps, codec) {
    if (!mbps || !w || !h || !fps) return null;
    const c = String(codec || '').toUpperCase().replace('H.265', 'HEVC');
    if (/PYROWAVE/.test(c)) return { score: null, why: 'n/d: PyroWave to kodek wewnątrzklatkowy z inną skalą bitrate niż HEVC/H.264.' };
    const factor = CODEC_FACTOR[c] ?? CODEC_FACTOR[c.replace(/[^A-Z0-9.]/g, '')] ?? 1;
    const bpp = mbps * 1e6 / (w * h * fps);
    return { score: curve(bpp / factor, [[0.03, 1], [0.15, 10]]), why: `${f(mbps)} Mb/s przy ${w}×${h} i ${f(fps, 0)} FPS = ${f(bpp, 3)} bita na piksel na klatkę (${c || '?'}).` };
  }

  // Builds every check from a normalized set of signals; each signal carries the name of its source.
  function build(sig) {
    const parts = {};
    const frame = 1000 / (sig.targetFps || 60);

    if (sig.dropPct != null) {
      parts.drops = { score: curve(sig.dropPct, DROPS), why: `${f(sig.dropPct, 2)}% klatek zgubionych lub odrzuconych (${sig.dropSrc}); <1% bardzo dobrze, ≤2% dobrze.` };
    }
    if (sig.rttMs != null) {
      let s = curve(sig.rttMs, RTT);
      const spike = sig.rttMax != null && sig.rttMax > 200;
      if (spike) s = clamp(s - 2);
      parts.rtt = { score: s, why: `Średnio ${f(sig.rttMs, 1)} ms${sig.rttMax != null ? `, maks. ${f(sig.rttMax, 0)} ms` : ''} (${sig.rttSrc}); <25 ms bardzo dobrze${spike ? '; skok >200 ms obniża ocenę' : ''}.` };
    }
    if (sig.hostLatMs != null) {
      const ratio = sig.hostLatMs / frame;
      let s = curve(ratio, HOSTLAT);
      const spike = sig.hostLatMax != null && sig.hostLatMax > 2.5 * frame && (sig.latePct ?? 0) >= 1;
      if (spike) s = clamp(s - 2);
      parts.hostlat = { score: s, why: `${f(sig.hostLatMs, 1)} ms = ${f(ratio, 2)} okresu klatki (${f(frame, 1)} ms przy ${sig.targetFps} FPS; ${sig.hostLatSrc}); <0,6 okresu bardzo dobrze, ≤1 dobrze${spike ? `; skok ${f(sig.hostLatMax, 0)} ms przy częstym spóźnianiu obniża ocenę` : ''}.` };
    }
    if (sig.latePct != null) {
      parts.late = { score: curve(sig.latePct, LATE), why: `${f(sig.latePct, 2)}% klatek później niż 2 okresy klatki (${sig.lateSrc}); <1% bardzo dobrze, ≤5% dobrze.` };
    }
    if (sig.pacingPct != null) {
      parts.pacing = { score: curve(sig.pacingPct, PACING), why: `${f(sig.pacingPct, 2)}% klatek w czasie przy celu 99,5% (${sig.pacingSrc}).` };
    }
    if (sig.e2eMs != null) {
      let s = curve(sig.e2eMs, E2E);
      if (sig.e2eCap != null && s > sig.e2eCap) s = sig.e2eCap;
      parts.e2e = { score: s, why: `${sig.e2eParts} = ${f(sig.e2eMs, 1)} ms; ≤20 ms bardzo dobrze, ≤35 ms dobrze.${sig.e2eNote ? ' ' + sig.e2eNote : ''}` };
    }
    if (sig.fpsAvg != null) {
      parts.fps = { score: curve(sig.fpsAvg / (sig.targetFps || 60), [[0.5, 1], [0.95, 10]]), why: `Średnio ${f(sig.fpsAvg)} z ${sig.targetFps} FPS${sig.fpsP1 != null ? `, P1 ${f(sig.fpsP1)} (bez ekranów ładowania)` : ''}. Nie wpływa na ocenę: limit gry i ekrany ładowania fałszują FPS.` };
    }
    if (sig.image) parts.image = sig.image;
    if (sig.headroom) parts.headroom = sig.headroom;
    return pack(parts);
  }

  // Vibepollo host samples in range + paired client (StreamLight/Moonlight stats, VRR capture) + StreamTweak.
  function vibepollo(session, bench) {
    const H = bench.host, ST = bench.st, T = bench.clientTrace;
    if (!H && !ST) return null;
    const c = bench.clients.length ? [...bench.clients].sort((a, b) => (b.u1 - b.u0) - (a.u1 - a.u0))[0].stream.stats : null;
    const h = session.host;
    const targetFps = (h && h.target) || (ST && ST.targetFps) || 60;
    const frame = 1000 / targetFps;
    const sig = { targetFps };

    // Losses: per-frame capture > StreamTweak > client end-of-stream > Vibepollo counters.
    if (T && T.lostPct != null) { sig.dropPct = T.lostPct + (T.dropped / Math.max(1, T.fpsRecv * T.seconds)) * 100; sig.dropSrc = `zakres, dane klatka po klatce: ${T.lost} zgubionych w sieci + ${T.dropped} odrzuconych`; }
    else if (ST && ST.dropPct != null) { sig.dropPct = ST.dropPct; sig.dropSrc = 'zakres, StreamTweak'; }
    else if (c && (c.netLossPct != null || c.jitterLossPct != null)) { sig.dropPct = (c.netLossPct || 0) + (c.jitterLossPct || 0); sig.dropSrc = 'cały stream, statystyki klienta'; }
    else if (H) { sig.dropPct = H.losses || H.videoDropped ? (H.losses + H.videoDropped) / Math.max(1, H.fpsAvg * bench.dur) * 100 : 0; sig.dropSrc = 'zakres, liczniki Vibepollo (bez logu klienta)'; }

    if (ST && ST.rttAvg != null) { sig.rttMs = ST.rttAvg; sig.rttMax = ST.rttMax; sig.rttSrc = 'zakres, StreamTweak'; }
    else if (c && c.netLatency != null) { sig.rttMs = c.netLatency; sig.rttSrc = 'cały stream, statystyki klienta'; }

    // Host latency: StreamTweak's client-measured capture+encode beats Vibepollo's encode-only figure.
    if (ST && ST.hostLatAvg != null) { sig.hostLatMs = ST.hostLatAvg; sig.hostLatMax = ST.hostLatMaxSession; sig.hostLatSrc = 'zakres, przechwytywanie + enkodowanie mierzone przez klienta (StreamTweak)'; }
    else if (H && H.encAvg != null) { sig.hostLatMs = H.encAvg; sig.hostLatMax = H.encMax; sig.hostLatSrc = 'zakres, samo enkodowanie z Vibepollo'; }

    if (ST && ST.latePct != null) { sig.latePct = ST.latePct; sig.lateSrc = 'cała sesja, StreamTweak'; }
    else if (H && H.encOver2Pct != null) { sig.latePct = H.encOver2Pct; sig.lateSrc = 'zakres, próbki enkodowania Vibepollo co 2 s'; }

    if (c && c.smoothness != null) { sig.pacingPct = c.smoothness; sig.pacingSrc = c.vrrBufferMs != null ? 'cały stream, „Client timing” Moonlight' : 'cały stream, „Smoothness (2m)” klienta'; }

    // End to end: host + half the round trip + client receive→screen.
    const net1 = sig.rttMs != null ? sig.rttMs / 2 : 0.5;
    const clientMs = T && T.lat50 != null ? T.lat50 : c && c.decodeMs != null ? (c.decodeMs || 0) + (c.queueMs || 0) + (c.renderMs || 0) : null;
    if (sig.hostLatMs != null && clientMs != null) {
      sig.e2eMs = sig.hostLatMs + net1 + clientMs;
      sig.e2eParts = `host ${f(sig.hostLatMs, 1)} + sieć w jedną stronę ${f(net1, 1)} + klient ${f(clientMs, 1)}`;
      if (!(T && T.lat50 != null)) { sig.e2eCap = 8.5; sig.e2eNote = 'Klient bez danych klatka po klatce: suma dekodowania, kolejki i renderowania pomija bufor VRR, więc ocena maks. 8,5.'; }
      else sig.e2eNote = 'Klient: zmierzony czas od odebrania klatki do ekranu (zakres), z buforem VRR.';
    }

    if (H) { sig.fpsAvg = H.fpsAvgActive ?? H.fpsAvg; sig.fpsP1 = H.fpsP1Active ?? H.fpsP1; }
    else if (ST && ST.fpsAvg) sig.fpsAvg = ST.fpsAvg;
    if (H && h) sig.image = imageInfo(H.bitrateAvg, h.width, h.height, H.fpsAvg, h.codec);
    if (H) {
      const peak = Math.max(H.gpuAvg || 0, H.gpuEncAvg || 0, H.cpuAvg || 0);
      sig.headroom = { score: curve(peak, [[60, 10], [98, 1]]), why: `Najbardziej obciążony: ${peak === H.cpuAvg ? 'CPU' : peak === H.gpuEncAvg ? 'enkoder GPU' : 'GPU'} średnio ${f(peak, 0)}% (GPU ${f(H.gpuAvg, 0)}%, enkoder ${f(H.gpuEncAvg, 0)}%, CPU ${f(H.cpuAvg, 0)}%).` };
    }
    return build(sig);
  }

  // Steam Remote Play: duration-weighted averages of the chosen segments.
  function steam(segs, sum) {
    if (!sum || !sum.n) return null;
    const last = segs[segs.length - 1];
    const targetFps = last.fpsLimit || 60;
    const sig = { targetFps, fpsAvg: sum.fps };
    if (sum.pingMs != null) { sig.rttMs = sum.pingMs; sig.rttSrc = 'ping Steama'; }
    const host = [sum.captureMs, sum.convertMs, sum.encodeMs];
    if (host.every(v => v != null)) { sig.hostLatMs = host.reduce((a, v) => a + v, 0); sig.hostLatSrc = 'przechwytywanie + konwersja + enkodowanie Steama'; }
    const slowHost = ['capture', 'convert', 'encode'].reduce((a, k) => a + (sum.slow[k] || 0), 0);
    sig.latePct = slowHost; sig.lateSrc = 'czas, w którym host spowalniał stream (Steam)';
    const client = (sum.networkMs || 0) + (sum.decodeMs || 0) + (sum.displayMs || 0);
    sig.e2eMs = (sig.hostLatMs || 0) + client;
    sig.e2eParts = `${sig.hostLatMs != null ? `host ${f(sig.hostLatMs, 1)} + ` : ''}sieć ${f(sum.networkMs, 1)} + dekodowanie ${f(sum.decodeMs, 2)} + wyświetlanie ${f(sum.displayMs, 2)}`;
    if (sig.hostLatMs == null) { sig.e2eCap = 8.5; sig.e2eNote = 'Steam nie zmierzył przechwytywania i enkodowania (PyroWave), więc ocena maks. 8,5.'; }
    if (last.width) sig.image = imageInfo(sum.serverMbps, last.width, last.height, sum.fps, last.pyrowave ? 'PyroWave' : (last.encoder || '').replace(/^.*?(H\.?26[45]|HEVC|AV1).*$/i, '$1'));
    sig.headroom = { score: curve(sum.slow.game || 0, [[0, 10], [20, 1]]), why: `Gra spowalniała stream ${f(sum.slow.game || 0, 1)}% czasu.` };
    return build(sig);
  }

  // StreamTweak-only session (no Vibepollo file): its own range numbers.
  function streamtweak(ST) {
    if (!ST) return null;
    return vibepollo({ host: null }, { host: null, st: ST, clients: [], clientTrace: null, dur: ST.seconds });
  }

  const compact = sc => sc ? Object.fromEntries([['overall', sc.overall], ...Object.entries(sc.parts).map(([k, v]) => [k, v.score])].map(([k, v]) => [k, v == null ? null : Math.round(v * 10) / 10])) : null;

  return { vibepollo, steam, streamtweak, cls, grade, compact, LABELS, GRADED, INFO };
})();
