// Parser for StreamTweak's session history (%LOCALAPPDATA%\StreamTweak\sessions.json).
// StreamTweak runs on the host and receives StreamLight's telemetry about once per second (RTT, drops,
// decode, delivered bitrate, client-measured host capture+encode latency) plus host GPU/encoder/CPU.
// Each series is downsampled to ≤600 points spread evenly over the session, and the times are the host's
// own clock, the same clock as Vibepollo, so no synchronisation is needed.
SS.parseStreamTweak = function (name, text) {
  let d;
  try { d = JSON.parse(text); } catch (e) { throw new Error('plik nie jest poprawnym JSON-em'); }
  if (!Array.isArray(d) || !d.some(s => s && s.StartTime && ('RttTimeSeries' in s || 'QualityStats' in s))) {
    throw new Error('to nie jest historia sesji StreamTweak');
  }
  const unix = iso => iso ? Date.parse(iso) / 1000 : null;
  const SERIES = { rtt: 'RttTimeSeries', drops: 'DropsTimeSeries', bitrate: 'BitrateTimeSeries', decode: 'DecodeTimeSeries',
    hostLat: 'HostLatencyTimeSeries', gpu: 'HostGpuTimeSeries', enc: 'HostEncTimeSeries', cpu: 'HostCpuTimeSeries' };
  const sessions = [];
  for (const s of d) {
    const u0 = unix(s.StartTime), u1 = unix(s.EndTime);
    if (!u0 || !u1 || u1 - u0 < 30 || s.IsDebugSession) continue;
    // Sessions from other clients (e.g. Moonlight) carry no StreamLight telemetry: nothing to add.
    const hasData = (s.QualityStats && s.QualityStats.SampleCount > 0) || Object.values(SERIES).some(k => Array.isArray(s[k]) && s[k].length);
    if (!hasData) continue;
    const series = {};
    for (const [k, field] of Object.entries(SERIES)) {
      const a = Array.isArray(s[field]) ? s[field] : [];
      // Point i covers the i-th slice of the session; place it in the middle of that slice.
      series[k] = a.map((v, i) => ({ u: u0 + (i + 0.5) / a.length * (u1 - u0), v }));
    }
    sessions.push({
      id: s.Id, u0, u1, stats: s.QualityStats || {}, grade: s.Grade, endReason: s.EndReason, series,
      streams: (s.StreamSpans || []).map(x => ({ u0: unix(x.Start), u1: unix(x.End), encoder: x.Encoder })),
      games: (s.GameSpans || []).map(x => ({ name: x.Name, u0: unix(x.Start), u1: unix(x.End) })),
      app: (s.GameSpans && s.GameSpans[0] && s.GameSpans[0].Name) || (s.GamesDetected && s.GamesDetected[0]) || 'StreamTweak'
    });
  }
  return { kind: 'streamtweak', name, key: 'streamtweak', sessions };
};
