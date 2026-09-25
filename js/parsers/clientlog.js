// Parser for client logs: StreamLight-<unix>.log and Moonlight-<unix>.log (moonlight-qt forks share the format).
// Lines look like "00:28:14 - SDL Info (0): Gamepad 0 is gone"; the time is elapsed since the unix epoch in the
// file name. One log can hold several streams (launch → quit); each one ends with a "Global video stats" block.
SS.parseClientLog = function (name, text) {
  const epochM = name.match(/-(\d{9,11})(?:\s*\(\d+\))?\.(?:log|txt)$/i);
  const epoch = epochM ? +epochM[1] : null;
  const client = /^streamlight/i.test(name) ? 'StreamLight' : /^moonlight/i.test(name) ? 'Moonlight' : 'Klient';

  const lines = text.split(/\r?\n/);
  const LINE = /^(\d+):(\d\d):(\d\d) - (.*)$/;
  const streams = [];
  const info = { gpu: null, link: null };
  let pending = {};          // config logged just before a stream starts (presentation snapshot, bitrate)
  let cur = null;            // stream being parsed
  let lastT = 0, lastSeen = 0;
  const padNames = {};

  const num = s => (s == null ? null : parseFloat(s));
  const pushEvent = (type, t, extra) => {
    // Several lines per incident within a second (RFI request, invalidate, wait...) collapse into one event.
    const ev = cur.events;
    const prev = ev[ev.length - 1];
    if (prev && prev.type === type && t - prev.t <= 1) { prev.count++; return; }
    ev.push({ type, t, count: 1, ...extra });
  };

  function startStream(t) {
    if (cur && !cur.ended) endStream(cur.tEnd ?? lastSeen); // previous stream died without a stats block
    cur = {
      index: streams.length, tStart: t, tEnd: null, width: null, height: null, fps: null, codec: null,
      bitrateKbps: pending.bitrateKbps ?? null, presentation: pending.presentation ?? null,
      vrrBackend: false, vrrPacingTarget: null, pacingLine: null, renderer: null,
      markers: [], events: [], stats: null, hostSnapshot: null, ended: false
    };
    pending = {};
    streams.push(cur);
  }
  function endStream(t) { if (cur && !cur.ended) { cur.tEnd = t; cur.ended = true; } }

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE);
    if (!m) continue;
    const t = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
    lastSeen = lastT;
    lastT = t;
    const msg = m[4];
    let x;

    if ((x = msg.match(/Detected GPU \d+: (.+?) \(/))) info.gpu = x[1];
    else if ((x = msg.match(/Local link to .* → "([^"]+)" \[ "([^"]+)" \]/))) info.link = `${x[1]} (${x[2]})`;
    else if ((x = msg.match(/Presentation snapshot: (.*)$/))) {
      const p = x[1];
      const presentation = {
        vsync: /V-sync enabled/i.test(p),
        vrrRequested: /VRR requested yes/i.test(p),
        vrrEnabled: /VRR enabled yes/i.test(p),
        refresh: num((p.match(/refresh (\d+(?:\.\d+)?) Hz/) || [])[1]),
        windowMode: num((p.match(/window mode (\d+)/) || [])[1])
      };
      pending.presentation = presentation;
    }
    else if ((x = msg.match(/Video bitrate: (\d+) kbps/))) pending.bitrateKbps = +x[1];
    else if (/Starting RTSP handshake/.test(msg)) startStream(t);
    else if ((x = msg.match(/Video stream is (\d+)x(\d+)x(\d+)/))) {
      if (!cur || cur.ended) startStream(t);
      cur.width = +x[1]; cur.height = +x[2]; cur.fps = +x[3];
    }
    else if (cur && !cur.ended) {
      if ((x = msg.match(/D3D11 VRR backend enabled: refresh=(\d+)/))) cur.vrrBackend = true;
      else if ((x = msg.match(/VRR pacing: target (\d+) Hz/))) cur.vrrPacingTarget = +x[1];
      else if ((x = msg.match(/Fractional V-Sync: .*\((display .*)\)/))) cur.pacingLine = x[1];
      else if ((x = msg.match(/Renderer '([^']+)' chosen/)) || (x = msg.match(/Using (\S+) accelerated renderer/))) cur.renderer = x[1];
      else if (!cur.codec && (x = msg.match(/FFmpeg: \[(hevc|h264|av1)\b/i))) cur.codec = { hevc: 'HEVC', h264: 'H.264', av1: 'AV1' }[x[1].toLowerCase()];
      else if ((x = msg.match(/Gamepad (\d+) is gone/))) {
        cur.markers.push({ t, type: 'pad-off', pad: +x[1], label: `Pad ${x[1]} OFF`, device: padNames[x[1]] || null });
      }
      else if ((x = msg.match(/Gamepad (\d+) \(player \d+\) is: (.+?) \(VID\/PID/))) {
        padNames[x[1]] = x[2];
        const hadOff = cur.markers.some(k => k.type === 'pad-off' && k.pad === +x[1]);
        // The pad announced right after connecting is not a marker; a later (re)connect is.
        if (hadOff || t - cur.tStart > 3) cur.markers.push({ t, type: 'pad-on', pad: +x[1], label: `Pad ${x[1]} ON`, device: x[2] });
      }
      else if ((x = msg.match(/USER_MARKER:\s*(\S+)/))) cur.markers.push({ t, type: 'user', label: x[1] });
      else if (/Sending speculative RFI request|Invalidate reference frame request sent/.test(msg)) pushEvent('rfi', t);
      else if (/IDR frame request sent/.test(msg)) pushEvent('idr', t);
      else if (/Video decode unit queue overflow/.test(msg)) pushEvent('overflow', t);
      else if (/Quit event received|Connection terminated|Stopping video stream/.test(msg)) { if (cur.tEnd == null) cur.tEnd = t; }
    }

    // The stats block follows a bare "HH:MM:SS - SDL Info (0): " line and has no timestamps of its own.
    if (lines[i + 1] && /^Global video stats/.test(lines[i + 1]) && cur) {
      const block = [];
      let j = i + 1;
      while (j < lines.length && !LINE.test(lines[j])) block.push(lines[j++]);
      parseStats(cur, block);
      if (cur.tEnd == null) cur.tEnd = t;
      endStream(cur.tEnd);
      i = j - 1;
    }
  }
  streams.forEach(s => { if (s.tEnd == null) s.tEnd = lastT; });

  function parseStats(s, block) {
    const st = {}; const hs = {};
    for (const l of block) {
      let x;
      if ((x = l.match(/^Video stream: (\d+)x(\d+) ([\d.]+) FPS \(Codec: ([^)]+)\)/))) { st.streamFps = +x[3]; st.codec = x[4].trim(); }
      else if ((x = l.match(/^Bitrate: ([\d.]+) Mbps, Peak \(10s\): ([\d.]+)/))) { st.bitrateEnd = +x[1]; st.bitratePeak10 = +x[2]; }
      else if ((x = l.match(/^Incoming frame rate from network: ([\d.]+)/))) st.incoming = +x[1];
      else if ((x = l.match(/^Decoding frame rate: ([\d.]+)/))) st.decoding = +x[1];
      else if ((x = l.match(/^Rendering frame rate: ([\d.]+)/))) st.rendering = +x[1];
      else if ((x = l.match(/^Host processing latency min\/max\/average: ([\d.]+)\/([\d.]+)\/([\d.]+)/))) { st.hostLatMin = +x[1]; st.hostLatMax = +x[2]; st.hostLatAvg = +x[3]; }
      else if ((x = l.match(/^Frames dropped by your network connection: ([\d.]+)%/))) st.netLossPct = +x[1];
      else if ((x = l.match(/^Frames dropped due to network jitter: ([\d.]+)%/))) st.jitterLossPct = +x[1];
      else if ((x = l.match(/^Average network latency: ([\d.]+) ms \(variance: ([\d.]+) ms\)/))) { st.netLatency = +x[1]; st.netVariance = +x[2]; }
      else if ((x = l.match(/^Average decoding time: ([\d.]+)/))) st.decodeMs = +x[1];
      else if ((x = l.match(/^Average frame queue delay: ([\d.]+)/))) st.queueMs = +x[1];
      else if ((x = l.match(/^Average rendering time.*?: ([\d.]+)/))) st.renderMs = +x[1];
      else if ((x = l.match(/^Incoming smoothness \(host\): ([\d.]+)%/))) st.incomingSmoothness = +x[1];
      else if ((x = l.match(/^VRR pacing: (\w+) \| Smoothness \(2m\): (collecting|[\d.]+%) \/ ([\d.]+)% target(?: \((.+)\))?/))) {
        st.vrrPacing = x[1]; st.smoothness = x[2] === 'collecting' ? null : parseFloat(x[2]); st.smoothnessTarget = +x[3]; st.smoothnessNote = x[4] || null;
      }
      else if ((x = l.match(/^Client interval error \(1s\): (collecting|[\d.]+ ms) \| Tolerance: ([\d.]+) ms \| Dropped \(30s\): (\d+)/))) {
        st.intervalErrorMs = x[1] === 'collecting' ? null : parseFloat(x[1]); st.dropped30s = +x[3];
      }
      else if ((x = l.match(/^GPU: (\d+)% \| Enc: (\d+)% \| Temp: (\d+)C \| VRAM: (\d+) \/ (\d+) MB/))) { hs.gpu = +x[1]; hs.enc = +x[2]; hs.temp = +x[3]; hs.vramUsed = +x[4]; hs.vramTotal = +x[5]; }
      else if ((x = l.match(/^CPU: (\d+)% \| Net TX: ([\d.]+) Mbps/))) { hs.cpu = +x[1]; hs.netTx = +x[2]; }
    }
    s.stats = Object.keys(st).length ? st : null;
    s.hostSnapshot = Object.keys(hs).length ? hs : null;
    if (st.codec) s.codec = st.codec;
  }

  // Streams without video (launch aborted) are noise.
  const real = streams.filter(s => s.width || s.stats);
  real.forEach((s, i) => { s.index = i; });
  return { kind: 'client', name, client, epoch, info, streams: real, key: name.replace(/\s*\(\d+\)(?=\.\w+$)/, '') };
};
