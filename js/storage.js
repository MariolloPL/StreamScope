// Session history: small summaries only (never raw logs), kept in this browser's localStorage.
// Export/import moves them between devices (e.g. PC ↔ iPhone via OneDrive/iCloud).
SS.History = (() => {
  const KEY = 'streamscope.history.v1';
  let memory = [];   // fallback when storage is blocked (private mode, disabled site data)

  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); memory = Array.isArray(v) ? v : []; } catch (e) { /* keep memory */ }
    return memory;
  }
  function save(list) {
    memory = list;
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  function add(entry) { const list = load().filter(x => x.id !== entry.id); list.push(entry); list.sort((a, b) => b.date - a.date); return save(list); }
  function remove(id) { return save(load().filter(x => x.id !== id)); }

  function exportJson() {
    return JSON.stringify({ app: 'StreamScope', format: 1, exported: new Date().toISOString(), sessions: load() }, null, 2);
  }
  // Merges by id; returns the number of entries added or replaced.
  function importJson(text) {
    const d = JSON.parse(text);
    const incoming = Array.isArray(d) ? d : d && Array.isArray(d.sessions) ? d.sessions : null;
    if (!incoming) throw new Error('to nie jest kopia zapasowa StreamScope');
    const valid = incoming.filter(x => x && x.id && x.date);
    const byId = new Map(load().map(x => [x.id, x]));
    valid.forEach(x => byId.set(x.id, x));
    save([...byId.values()].sort((a, b) => b.date - a.date));
    return valid.length;
  }

  return { load, add, remove, exportJson, importJson };
})();

SS.Report = (() => {
  const r2 = v => (v == null || !isFinite(v)) ? null : Math.round(v * 100) / 100;

  // Compact, stable summary of one analysed range — this is what history, export and compare use.
  function summary(session, bench, rangeLabel, diag) {
    const h = session.host, H = bench.host;
    const c = bench.clients.length ? [...bench.clients].sort((x, y) => (y.u1 - y.u0) - (x.u1 - x.u0))[0] : null;
    const st = c && c.stream, cs = st && st.stats;
    return {
      id: `${session.id}|${Math.round(bench.a)}-${Math.round(bench.b)}`,
      date: bench.a, savedAt: Date.now(),
      app: session.app,
      streamer: c ? c.log.client : null,
      host_server: h ? h.server : null,
      resolution: h && h.width ? `${h.width}x${h.height}` : st && st.width ? `${st.width}x${st.height}` : null,
      target_fps: (h && h.target) || (st && st.fps) || null,
      codec: (h && h.codec) || (st && st.codec) || null,
      bitrate_setting_mbps: h && h.reqBitrate ? r2(h.reqBitrate / 1000) : st && st.bitrateKbps ? r2(st.bitrateKbps / 1000) : null,
      range: rangeLabel, duration_s: Math.round(bench.dur),
      host: H ? {
        avg_fps: r2(H.fpsAvg), p50_fps: r2(H.fpsP50), p5_fps: r2(H.fpsP5), p1_fps: r2(H.fpsP1), frames_sent_fps: r2(H.fpsSent),
        pct_ge_90: r2(H.pct90), pct_ge_100: r2(H.pct100),
        bitrate_avg_mbps: r2(H.bitrateAvg), bitrate_p95_mbps: r2(H.bitrateP95),
        encode_avg_ms: r2(H.encAvg), encode_p50_ms: r2(H.encP50), encode_p95_ms: r2(H.encP95),
        gpu_avg_pct: r2(H.gpuAvg), encoder_avg_pct: r2(H.gpuEncAvg), cpu_avg_pct: r2(H.cpuAvg),
        client_reported_losses: H.losses, video_dropped: H.videoDropped
      } : null,
      client: cs ? {
        scope: 'cały stream klienta',
        incoming_fps: cs.incoming ?? null, decoding_fps: cs.decoding ?? null, rendering_fps: cs.rendering ?? null,
        network_loss_pct: cs.netLossPct ?? null, jitter_loss_pct: cs.jitterLossPct ?? null,
        network_latency_ms: cs.netLatency ?? null, decode_ms: cs.decodeMs ?? null, queue_ms: cs.queueMs ?? null, render_ms: cs.renderMs ?? null,
        host_latency_avg_ms: cs.hostLatAvg ?? null,
        vrr: vrrState(st), smoothness_2m_pct: cs.smoothness ?? null,
        display_refresh_hz: st.presentation ? st.presentation.refresh : null
      } : null,
      client_events: bench.clientEvents,
      diagnostics: diag ? { status: diag.status, findings: diag.findings.filter(f => f.sev !== 'info').map(f => f.title) } : null
    };
  }

  // VRR as reported, without assumptions: requested → enabled → backend → pacing active.
  function vrrState(st) {
    if (!st) return null;
    const p = st.presentation || {};
    if (st.stats && st.stats.vrrPacing) return st.stats.vrrPacing === 'Active' ? 'active' : st.stats.vrrPacing.toLowerCase();
    if (st.vrrBackend) return 'backend enabled';
    if (p.vrrEnabled) return 'enabled';
    if (p.vrrRequested) return 'requested, not enabled';
    return p.vrrRequested === false ? 'off' : null;
  }

  function text(sum) {
    const L = [];
    const n = (v, d = 1, u = '') => v == null ? '—' : (+v).toFixed(d) + u;   // dot decimals: this text is for AI
    L.push('StreamScope session report', '');
    L.push(`App: ${sum.app}`);
    L.push(`Mode: ${sum.resolution || '?'} @${sum.target_fps || '?'} ${sum.codec || ''}${sum.bitrate_setting_mbps ? `, ${n(sum.bitrate_setting_mbps, 0)} Mbps` : ''}`);
    L.push(`Date: ${SS.time.date(sum.date)}`);
    L.push(`Range: ${sum.range} (${SS.time.fmt(sum.duration_s)})`);
    if (sum.host) {
      const h = sum.host;
      L.push('', `Host (${sum.host_server ? 'Vibepollo ' + sum.host_server : 'Vibepollo'}):`);
      L.push(`${n(h.avg_fps, 2)} avg FPS (frames_sent: ${n(h.frames_sent_fps, 2)})`);
      L.push(`${n(h.p50_fps)} P50 · ${n(h.p5_fps)} P5 · ${n(h.p1_fps)} P1`);
      L.push(`FPS ≥90: ${n(h.pct_ge_90)}% · ≥100: ${n(h.pct_ge_100)}%`);
      L.push(`${n(h.bitrate_avg_mbps)} Mbps avg · ${n(h.bitrate_p95_mbps)} P95`);
      L.push(`${n(h.encode_avg_ms, 2)} ms encode avg · ${n(h.encode_p95_ms)} P95`);
      L.push(`GPU ${n(h.gpu_avg_pct, 0)}% · encoder ${n(h.encoder_avg_pct, 0)}% · CPU ${n(h.cpu_avg_pct, 0)}%`);
      L.push(`losses ${h.client_reported_losses} · video dropped ${h.video_dropped}`);
    }
    if (sum.client) {
      const c = sum.client;
      L.push('', `Client (${sum.streamer}, whole stream):`);
      L.push(`${n(c.incoming_fps, 2)} incoming · ${n(c.rendering_fps, 2)} render`);
      L.push(`${n(c.network_loss_pct, 2)}% network loss · ${n(c.jitter_loss_pct, 2)}% jitter loss`);
      L.push(`${n(c.network_latency_ms, 0)} ms network · ${n(c.decode_ms, 2)} ms decode · ${n(c.queue_ms, 2)} ms queue · ${n(c.render_ms, 2)} ms render`);
      L.push(`VRR ${c.vrr || '?'}${c.smoothness_2m_pct != null ? ` · smoothness (2m, pacing metric) ${n(c.smoothness_2m_pct, 2)}%` : ''}`);
    }
    const e = sum.client_events;
    if (e && (e.rfi || e.idr || e.overflow)) L.push(`Client events in range: RFI ${e.rfi}, IDR ${e.idr}, decode queue overflow ${e.overflow}`);
    if (sum.diagnostics) L.push('', `Diagnostics (whole host file): ${sum.diagnostics.status}${sum.diagnostics.findings.length ? ' — ' + sum.diagnostics.findings.join('; ') : ''}`);
    L.push('', 'JSON:', JSON.stringify(sum));
    return L.join('\n');
  }

  return { summary, text, vrrState };
})();
