// Parser for Vibepollo/Sunshine session files (sunshine-session-<App>-<UTC time>.json).
// Structure notes (confirmed on real files): one file can hold several session_uuid segments (reconnects);
// counters are cumulative within a session_uuid; encode_latency_ms = 0 means "no frame encoded".
SS.parseVibepollo = function (name, text) {
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error('plik nie jest poprawnym JSON-em'); }
  if (!d || !Array.isArray(d.samples)) throw new Error('brak tablicy "samples" — to nie jest plik sesji Vibepollo');
  const S = d.samples.filter(s => s && isFinite(s.timestamp_unix)).sort((a, b) => a.timestamp_unix - b.timestamp_unix);
  d.samples = S;
  const t0 = d.start_time_unix ?? (S[0] && S[0].timestamp_unix);
  const tEnd = d.end_time_unix ?? (S.length ? S[S.length - 1].timestamp_unix : t0);

  // Segments per session_uuid, with precise boundaries from stream_started/stream_ended events when present.
  const segs = [];
  let cur = null;
  S.forEach((s, i) => {
    if (!cur || cur.uuid !== s.session_uuid) { cur = { uuid: s.session_uuid, t0: s.timestamp_unix, t1: s.timestamp_unix, i0: i, i1: i }; segs.push(cur); }
    cur.t1 = s.timestamp_unix; cur.i1 = i;
  });
  const ev = d.events || [];
  for (const g of segs) {
    const st = ev.find(e => e.session_uuid === g.uuid && e.event_type === 'stream_started');
    const en = ev.find(e => e.session_uuid === g.uuid && e.event_type === 'stream_ended');
    if (st) g.t0 = st.timestamp_unix;
    if (en) g.t1 = en.timestamp_unix;
  }

  return {
    kind: 'host', name, raw: d, t0, tEnd,
    // Same session exported twice (e.g. "file(1).json") must not be counted twice.
    key: `${d.app_name}|${Math.round(t0)}`,
    app: d.app_name || '?', client: d.client_name || d.device_name || '?',
    codec: d.codec, width: d.width, height: d.height, target: d.target_fps || null,
    reqBitrate: d.requested_bitrate_kbps, server: (d.server_version || '').split(' ')[0],
    hostGpu: d.host_gpu_model, hostCpu: d.host_cpu_model, verdict: d.verdict,
    truncated: !!(d.samples_truncated || d.events_truncated),
    samples: S, segs
  };
};
