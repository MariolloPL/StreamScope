// Builds sessions from parsed files: a Vibepollo file (host) plus the client streams that ran at the same time.
// Clock sync: client log time + epoch from the file name ≈ host unix time. The residual offset (usually a few
// seconds) is measured from the host's stream_started event nearest to the client's "Starting RTSP handshake".
SS.Session = (() => {
  const PAIR_WINDOW = 60;   // max |host stream_started − client stream start| (s) to treat them as the same stream

  function build(hostFiles, clientLogs) {
    const sessions = hostFiles.map(h => ({ id: 'h:' + h.key, host: h, clients: [], offset: 0, log: null }));
    const loose = [];

    for (const log of clientLogs) {
      for (const st of log.streams) {
        if (log.epoch == null) { loose.push({ log, stream: st, offset: 0 }); continue; }
        const su = log.epoch + st.tStart;
        let best = null;
        for (const s of sessions) {
          for (const g of s.host.segs) {
            const d = g.t0 - su;
            if (Math.abs(d) <= PAIR_WINDOW && (!best || Math.abs(d) < Math.abs(best.d))) best = { s, d, exact: true };
          }
        }
        if (!best) {
          const s = sessions.find(x => su >= x.host.t0 - 30 && su <= x.host.tEnd + 30);
          if (s) best = { s, d: 0, exact: false };
        }
        if (best) best.s.clients.push({ log, stream: st, offset: best.d, exact: best.exact });
        else loose.push({ log, stream: st, offset: 0 });
      }
    }

    for (const s of sessions) {
      if (!s.clients.length) continue;
      // One time base per session: the log with the longest paired stream, at the median offset of its streams.
      const main = [...s.clients].sort((a, b) => (b.stream.tEnd - b.stream.tStart) - (a.stream.tEnd - a.stream.tStart))[0].log;
      s.log = main;
      s.offset = SS.stats.median(s.clients.filter(c => c.log === main && c.exact).map(c => c.offset)) ?? 0;
    }

    // Client streams with no matching host file become client-only sessions.
    for (const c of loose) {
      sessions.push({ id: `c:${c.log.key}#${c.stream.index}`, host: null, clients: [c], offset: 0, log: c.log });
    }
    sessions.forEach(finish);
    return sessions.sort((a, b) => b.t0 - a.t0);
  }

  function finish(s) {
    // clientBase = host-clock unix time of "00:00:00" in the session's client log.
    s.clientBase = s.log && s.log.epoch != null ? s.log.epoch + s.offset : null;
    const cu = c => (c.log.epoch ?? 0) + (c.log === s.log ? s.offset : c.offset);
    if (s.host) { s.t0 = s.host.t0; s.t1 = s.host.tEnd; }
    else { const c = s.clients[0]; s.t0 = cu(c) + c.stream.tStart; s.t1 = cu(c) + c.stream.tEnd; }
    s.app = s.host ? s.host.app : c0Label(s);
    s.markers = []; s.events = [];
    for (const c of s.clients) {
      const base = cu(c);
      c.u0 = base + c.stream.tStart; c.u1 = base + c.stream.tEnd;
      c.stream.markers.forEach(m => s.markers.push({ ...m, u: base + m.t, logT: m.t, log: c.log }));
      c.stream.events.forEach(e => s.events.push({ ...e, u: base + e.t }));
    }
    s.markers.sort((a, b) => a.u - b.u);
    s.events.sort((a, b) => a.u - b.u);
  }
  const c0Label = s => `${s.clients[0].log.client} (bez pliku hosta)`;

  // Default range: the longest automatically detected gameplay stretch (menus and loading excluded);
  // without one, the longest uuid segment (the short one is usually a settings reconnect).
  function defaultRange(s) {
    const gp = s.host && s.host.gameplay;
    if (gp && gp.length) {
      const g = [...gp].sort((x, y) => y.dur - x.dur)[0];
      return { a: g.a, b: g.b };
    }
    if (s.host && s.host.segs.length) {
      const g = [...s.host.segs].sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0))[0];
      return { a: g.t0, b: g.t1 };
    }
    return { a: s.t0, b: s.t1 };
  }

  return { build, defaultRange };
})();

SS.Benchmark = (() => {
  const { mean, quantile, max } = SS.stats;

  // Sum of per-sample increases of a counter that is cumulative within session_uuid (resets on a new uuid).
  function counterSum(W, key) {
    let total = 0, prevU = null, prev = 0;
    for (const s of W) {
      const v = +s[key] || 0;
      if (s.session_uuid !== prevU) { prevU = s.session_uuid; prev = v; continue; }
      total += v >= prev ? v - prev : v; prev = v;
    }
    return total;
  }

  function host(h, a, b) {
    const W = h.samples.filter(s => s.timestamp_unix >= a && s.timestamp_unix <= b);
    if (W.length < 2) return null;
    const fps = W.map(s => +s.actual_fps || 0);
    const enc = W.map(s => +s.encode_latency_ms || 0).filter(v => v > 0);
    const br = W.map(s => (+s.actual_bitrate_kbps || 0) / 1000);
    // Control value: frames actually sent / time, per uuid segment so a reconnect doesn't break the delta.
    let frames = 0, secs = 0;
    const byU = new Map();
    W.forEach(s => { if (!byU.has(s.session_uuid)) byU.set(s.session_uuid, []); byU.get(s.session_uuid).push(s); });
    for (const g of byU.values()) {
      if (g.length < 2) continue;
      frames += (g[g.length - 1].frames_sent - g[0].frames_sent); secs += g[g.length - 1].timestamp_unix - g[0].timestamp_unix;
    }
    const share = th => fps.filter(v => v >= th).length / fps.length * 100;
    return {
      n: W.length, from: W[0].timestamp_unix, to: W[W.length - 1].timestamp_unix,
      fpsAvg: mean(fps), fpsP50: quantile(fps, 0.5), fpsP5: quantile(fps, 0.05), fpsP1: quantile(fps, 0.01),
      fpsSent: secs > 0 ? frames / secs : null,
      pct90: share(90), pct100: share(100),
      bitrateAvg: mean(br), bitrateP95: quantile(br, 0.95),
      encAvg: mean(enc), encP50: quantile(enc, 0.5), encP95: quantile(enc, 0.95), encMax: max(enc),
      cpuAvg: mean(W.map(s => +s.host_cpu_percent || 0)), gpuAvg: mean(W.map(s => +s.host_gpu_percent || 0)),
      gpuEncAvg: mean(W.map(s => +s.host_gpu_encoder_percent || 0)), gpuTempMax: max(W.map(s => +s.host_gpu_temp_c || 0)),
      losses: counterSum(W, 'client_reported_losses'), videoDropped: counterSum(W, 'video_dropped'),
      idr: counterSum(W, 'idr_requests'), refInv: counterSum(W, 'ref_invalidations'),
      segments: byU.size
    };
  }

  function compute(session, a, b) {
    const clients = session.clients.filter(c => c.u1 >= a && c.u0 <= b);
    const inRange = e => e.u >= a && e.u <= b;
    const ev = session.events.filter(inRange);
    const countOf = type => ev.filter(e => e.type === type).length;
    return {
      a, b, dur: b - a,
      host: session.host ? host(session.host, a, b) : null,
      clients,
      clientEvents: { rfi: countOf('rfi'), idr: countOf('idr'), overflow: countOf('overflow') }
    };
  }

  return { compute };
})();
