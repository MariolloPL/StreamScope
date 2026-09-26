// Session history: small summaries only (never raw logs), kept in this browser's localStorage.
// Export/import moves them between devices (e.g. PC ↔ iPhone via OneDrive/iCloud).
SS.History = (() => {
  const KEY = 'streamscope.history.v1';
  let memory = [];   // fallback when storage is blocked (private mode, disabled site data)

  let remote = false;   // true when StreamScope Agent keeps the history for all devices

  function load() {
    if (remote) return memory;
    try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); memory = Array.isArray(v) ? v : []; } catch (e) { /* keep memory */ }
    return memory;
  }
  function save(list) {
    memory = list;
    if (remote) { fetch('api/history', { method: 'PUT', body: JSON.stringify(list) }).catch(() => {}); return true; }
    try { localStorage.setItem(KEY, JSON.stringify(list)); return true; } catch (e) { return false; }
  }
  // Switch to the agent's shared history. Entries saved earlier in this browser are merged in once.
  async function useAgent() {
    const r = await fetch('api/history', { cache: 'no-store' });
    const shared = r.ok ? await r.json() : [];
    const local = load();
    remote = true;
    const byId = new Map((Array.isArray(shared) ? shared : []).map(x => [x.id, x]));
    let added = 0;
    local.forEach(x => { if (!byId.has(x.id)) { byId.set(x.id, x); added++; } });
    memory = [...byId.values()].sort((a, b) => b.date - a.date);
    if (added) save(memory);
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

  return { load, add, remove, exportJson, importJson, useAgent };
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

  // Steam Remote Play: shared fields mirror the Vibepollo/StreamLight summary so Compare can line them up.
  function steamSummary(session, segs, sum, diag) {
    const c = session.steam, last = segs[segs.length - 1] || c.segments[c.segments.length - 1], mc = c.maxCapture;
    const enc = (last.encoder || '').replace(/\s*\[.*\]$/, '');
    return {
      id: `${session.id}|${segs.map(g => Math.round(g.u1)).join(',')}`,
      date: segs.length ? segs[0].u0 : c.u0, savedAt: Date.now(),
      app: session.app,
      streamer: `Steam Remote Play${last.pyrowave ? ' (PyroWave)' : ''}`,
      host_server: null,
      resolution: mc ? `${mc.w}x${mc.h}` : last.width ? `${last.width}x${last.height}` : null,
      target_fps: last.fpsLimit || (mc && Math.round(mc.fps)) || null,
      codec: last.pyrowave ? 'PyroWave' : enc || null,
      bitrate_setting_mbps: last.bandwidthLimitKbps ? r2(last.bandwidthLimitKbps / 1000) : null,
      range: `${segs.length} z ${c.segments.length} odcinków Steama`, duration_s: Math.round(sum.dur),
      host: {
        avg_fps: r2(sum.fps), p50_fps: null, p5_fps: null, p1_fps: null, frames_sent_fps: null, pct_ge_90: null, pct_ge_100: null,
        bitrate_avg_mbps: r2(sum.serverMbps), bitrate_p95_mbps: null,
        encode_avg_ms: r2(sum.encodeMs), encode_p50_ms: null, encode_p95_ms: null,
        gpu_avg_pct: null, encoder_avg_pct: null, cpu_avg_pct: null, client_reported_losses: null, video_dropped: null
      },
      client: {
        scope: 'średnia ważona odcinków Steama',
        incoming_fps: null, decoding_fps: null, rendering_fps: null, network_loss_pct: null, jitter_loss_pct: null,
        network_latency_ms: r2(sum.pingMs), decode_ms: r2(sum.decodeMs), queue_ms: null, render_ms: null,
        host_latency_avg_ms: null, vrr: null, smoothness_2m_pct: null, display_refresh_hz: null
      },
      steam: {
        client: c.client, decoder: last.decoder, frame_ms: r2(sum.frameMs), ping_ms: r2(sum.pingMs), network_ms: r2(sum.networkMs),
        capture_ms: r2(sum.captureMs), convert_ms: r2(sum.convertMs), encode_ms: r2(sum.encodeMs), decode_ms: r2(sum.decodeMs),
        display_ms: r2(sum.displayMs), server_bitrate_mbps: r2(sum.serverMbps), link_mbps: r2(sum.linkMbps),
        slow_pct: Object.fromEntries(Object.entries(sum.slow).map(([k, v]) => [k, r2(v)]))
      },
      client_events: null,
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
    if (sum.steam) {
      const s = sum.steam, sl = s.slow_pct || {};
      L.push('', `Steam Remote Play → ${s.client} (duration-weighted segment averages; Steam AvgFPS is stream cadence, not game FPS):`);
      L.push(`${n(sum.host.avg_fps)} avg FPS · ${n(s.frame_ms, 2)} ms frame`);
      L.push(`${n(s.server_bitrate_mbps)} Mbps server bitrate · link ${n(s.link_mbps, 0)} Mbps`);
      L.push(`ping ${n(s.ping_ms, 2)} ms · network ${n(s.network_ms, 2)} ms · decode ${n(s.decode_ms, 2)} ms · display ${n(s.display_ms, 2)} ms`);
      L.push(`capture ${n(s.capture_ms, 2)} · convert ${n(s.convert_ms, 2)} · encode ${n(s.encode_ms, 2)} ms (— = not measured)`);
      L.push(`slow % of time: game ${n(sl.game, 2)} · capture ${n(sl.capture, 2)} · convert ${n(sl.convert, 2)} · encode ${n(sl.encode, 2)} · network ${n(sl.network, 2)} · decode ${n(sl.decode, 2)} · display ${n(sl.display, 2)}`);
      L.push(`decoder: ${s.decoder || '?'}`);
    }
    else if (sum.host) {
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
    if (sum.client && !sum.steam) {
      const c = sum.client;
      L.push('', `Client (${sum.streamer}, whole stream):`);
      L.push(`${n(c.incoming_fps, 2)} incoming · ${n(c.rendering_fps, 2)} render`);
      L.push(`${n(c.network_loss_pct, 2)}% network loss · ${n(c.jitter_loss_pct, 2)}% jitter loss`);
      L.push(`${n(c.network_latency_ms, 0)} ms network · ${n(c.decode_ms, 2)} ms decode · ${n(c.queue_ms, 2)} ms queue · ${n(c.render_ms, 2)} ms render`);
      L.push(`VRR ${c.vrr || '?'}${c.smoothness_2m_pct != null ? ` · smoothness (2m, pacing metric) ${n(c.smoothness_2m_pct, 2)}%` : ''}`);
    }
    const e = sum.client_events;
    if (e && (e.rfi || e.idr || e.overflow)) L.push(`Client events in range: RFI ${e.rfi}, IDR ${e.idr}, decode queue overflow ${e.overflow}`);
    if (sum.diagnostics) L.push('', `Diagnostics (${sum.steam ? 'whole Steam connection' : 'whole host file'}): ${sum.diagnostics.status}${sum.diagnostics.findings.length ? ' — ' + sum.diagnostics.findings.join('; ') : ''}`);
    L.push('', 'JSON:', JSON.stringify(sum));
    return L.join('\n');
  }

  return { summary, steamSummary, text, vrrState };
})();
