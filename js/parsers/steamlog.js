// Parser for Steam Remote Play host logs: Steam\logs\streaming_log.txt (and streaming_log.previous.txt).
// A connection starts at "Streaming started to <client> at <ip>". Steam writes a "SessionStats" block (VDF)
// whenever the video stream changes (desktop ↔ game capture, overlay), so one connection = several segments,
// each summarising the time since the previous block. There are no periodic samples, only these summaries
// plus "Slow framerate" events that name the bottleneck.
SS.parseSteamLog = function (name, text) {
  const LINE = /^\[(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d)\]\[[\d.]+\] (.*)$/;
  const lines = text.split(/\r?\n/);
  // Line timestamps are the host's local time without a zone. SessionStats carries a real unix time
  // (TimeSubmitted), which gives the exact shift; the browser's zone is only a fallback.
  const naive = m => Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  let shift = null;
  for (let i = 0; i < lines.length && shift == null; i++) {
    if (!/"SessionStats"$/.test(lines[i])) continue;
    const m = lines[i].match(LINE);
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const t = lines[j].match(/"TimeSubmitted"\s+"(\d+)"/);
      if (t && m) { shift = +t[1] - naive(m); break; }
    }
  }
  const toUnix = m => shift != null ? naive(m) + shift : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() / 1000;

  const conns = [];
  let cur = null, lastU = null;
  const num = v => (v == null || v === '' ? null : parseFloat(v));

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE);
    if (!m) continue;
    const u = toUnix(m), msg = m[7];
    let x;
    if ((x = msg.match(/^Streaming started to (.+?) at ([\d.:a-f[\]]+)/i))) {
      cur = { u0: u, u1: u, client: x[1], addr: x[2].replace(/:\d+$/, ''), game: null, appid: null, maxCapture: null,
        bitrates: [], segments: [], slow: [], targets: [] };
      conns.push(cur); lastU = u;
      continue;
    }
    if (!cur) continue;
    if ((x = msg.match(/^Game: (.+) \((\d+)\)$/))) { if (x[1] !== 'UNKNOWN') { cur.game = x[1]; cur.appid = +x[2]; } }
    else if ((x = msg.match(/^Maximum capture: (\d+)x(\d+) ([\d.]+) FPS/))) cur.maxCapture = { w: +x[1], h: +x[2], fps: +x[3] };
    else if ((x = msg.match(/^Setting target bitrate to (\d+) Kbit\/s, burst bitrate is (\d+)/))) cur.bitrates.push({ u, kbps: +x[1], burst: +x[2] });
    else if ((x = msg.match(/^Slow framerate: (.*)$/))) {
      const ev = { u, causes: [...x[1].matchAll(/\((\w+)\)/g)].map(c => c[1]) };
      for (const k of ['game', 'capture', 'convert', 'encode', 'network', 'decode', 'display']) ev[k] = num((x[1].match(new RegExp(k + ' (-?[\\d.]+)')) || [])[1]);
      cur.slow.push(ev);
    }
    else if ((x = msg.match(/^CLIENT: Targeting ([\d.]+) FPS/))) cur.targets.push({ u, fps: +x[1] });
    else if (msg === '"SessionStats"') {
      const kv = {};
      let j = i + 1;
      for (; j < lines.length && !/^\}/.test(lines[j]); j++) {
        const p = lines[j].match(/^\s*"([^"]+)"\s+"([^"]*)"/);
        if (p) kv[p[1]] = p[2];
      }
      i = j;
      const end = kv.TimeSubmitted ? +kv.TimeSubmitted : u;
      cur.segments.push(segment(kv, lastU, end));
      lastU = end; cur.u1 = Math.max(cur.u1, end);
      if (!cur.game && kv.GameNameID) cur.game = kv.GameNameID;
      continue;
    }
    if (/^CLIENT: /.test(msg)) cur.u1 = Math.max(cur.u1, u);
  }

  function segment(kv, u0, u1) {
    const g = k => num(kv[k]);
    const cap = kv.CaptureDescriptionID || '';
    const encoder = (cap.split('+')[1] || cap).trim();
    // Steam reports garbage display times (negative, or tens of seconds) on some segments; keep them out.
    const disp = g('AvgDisplayMS');
    return {
      u0, u1, dur: Math.max(0, u1 - u0),
      capture: cap, source: /^Game /.test(cap) ? 'gra' : /^Desktop/.test(cap) ? 'pulpit' : '?',
      encoder, pyrowave: /pyrowave/i.test(cap), decoder: kv.DecoderDescriptionID || null,
      width: g('ResolutionX'), height: g('ResolutionY'),
      bandwidthLimitKbps: g('BandwidthLimit'), fpsLimit: g('FramerateLimit'),
      fps: g('AvgFPS'), fpsSd: g('StdDevFPS'), frameMs: g('AvgFrameMS'),
      serverMbps: g('AvgServerBitrate') != null ? g('AvgServerBitrate') / 1000 : null,
      serverSdMbps: g('StdDevServerBitrate') != null ? g('StdDevServerBitrate') / 1000 : null,
      linkMbps: g('AvgLinkBandwidth') != null ? g('AvgLinkBandwidth') / 1000 : null,
      pingMs: g('AvgPingMS'), captureMs: g('AvgCaptureMS'), convertMs: g('AvgConvertMS'), encodeMs: g('AvgEncodeMS'),
      networkMs: g('AvgNetworkMS'), decodeMs: g('AvgDecodeMS'),
      displayMs: disp != null && disp >= 0 && disp < 1000 ? disp : null, displayBogus: disp != null && !(disp >= 0 && disp < 1000),
      slow: { game: g('SlowGamePercent'), capture: g('SlowCapturePercent'), convert: g('SlowConvertPercent'), encode: g('SlowEncodePercent'),
        network: g('SlowNetworkPercent'), decode: g('SlowDecodePercent'), display: g('SlowDisplayPercent') }
    };
  }

  const real = conns.filter(c => c.segments.length);
  real.forEach(c => { if (!c.game) c.game = 'Pulpit / Steam'; c.key = `${Math.round(c.u0)}|${c.client}`; });
  return { kind: 'steam', name, key: name, conns: real, zoneFromLog: shift != null };
};

// Duration-weighted summary of chosen Steam segments (Steam gives per-segment averages, not samples).
SS.steamSummary = function (segs) {
  const use = segs.filter(s => s.dur > 0);
  const total = use.reduce((a, s) => a + s.dur, 0);
  const wavg = (k, pred) => {
    let w = 0, v = 0;
    for (const s of use) { const x = s[k]; if (x == null || (pred && !pred(s, x))) continue; w += s.dur; v += x * s.dur; }
    return w ? v / w : null;
  };
  // Pyrowave reports 0 for capture/convert/encode in game capture: treat zeros there as "not measured".
  const measured = (s, x) => x > 0;
  const slow = {};
  for (const k of ['game', 'capture', 'convert', 'encode', 'network', 'decode', 'display']) {
    let w = 0, v = 0; for (const s of use) { const x = s.slow[k]; if (x != null) { w += s.dur; v += x * s.dur; } } slow[k] = w ? v / w : null;
  }
  return {
    dur: total, n: use.length,
    fps: wavg('fps'), frameMs: wavg('frameMs'), serverMbps: wavg('serverMbps'), linkMbps: wavg('linkMbps'),
    pingMs: wavg('pingMs'), captureMs: wavg('captureMs', measured), convertMs: wavg('convertMs', measured), encodeMs: wavg('encodeMs', measured),
    networkMs: wavg('networkMs'), decodeMs: wavg('decodeMs'), displayMs: wavg('displayMs'), slow
  };
};
