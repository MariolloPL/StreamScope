// Automatic gameplay detection from Vibepollo host samples (no controller markers needed).
// Observed on ARC Raiders sessions with known raid boundaries: during a match the host CPU sits near its
// session high, FPS is steady and bitrate is sustained; menus, lobbies and loading screens show lower CPU,
// jumpy FPS and dips in bitrate. GPU alone does not separate them. Thresholds are relative to each
// connection (session_uuid), because a settings change (resolution, FPS) shifts every level at once.
SS.Gameplay = (() => {
  const WIN = 31;          // samples (~60 s) in the rolling window
  const ACTIVE = 0.85;     // activity (0..~1.1) needed, relative to the connection's own 90th percentiles
  const GAP = 120;         // s: a short hitch (death, cutscene) inside a match does not split it
  const MIN_LEN = 180;     // s: shorter stretches are not reported

  const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : 0; };

  function detect(host) {
    const S = host.samples, n = S.length;
    if (n < WIN) return [];
    const cpu = S.map(s => +s.host_cpu_percent || 0), gpu = S.map(s => +s.host_gpu_percent || 0);
    const br = S.map(s => +s.actual_bitrate_kbps || 0), fps = S.map(s => +s.actual_fps || 0);

    // Rolling features; the window never crosses a reconnect.
    const feats = new Array(n);
    let segStart = 0;
    const bounds = [];
    for (let i = 1; i <= n; i++) if (i === n || S[i].session_uuid !== S[i - 1].session_uuid) { bounds.push([segStart, i]); segStart = i; }
    for (const [a0, b0] of bounds) {
      for (let i = a0; i < b0; i++) {
        const a = Math.max(a0, i - (WIN >> 1)), b = Math.min(b0, i + (WIN >> 1) + 1);
        const w = fps.slice(a, b), ws = [...w].sort((x, y) => x - y);
        const iqr = ws[Math.floor(0.75 * (ws.length - 1))] - ws[Math.floor(0.25 * (ws.length - 1))];
        feats[i] = { cpu: median(cpu.slice(a, b)), gpu: median(gpu.slice(a, b)), br: median(br.slice(a, b)), fps: median(w), iqr };
      }
    }

    // Per-connection calibration.
    const flags = new Array(n).fill(false);
    for (const [a0, b0] of bounds) {
      const F = feats.slice(a0, b0);
      const c90 = Math.max(1, q(F.map(f => f.cpu), 0.9)), g90 = Math.max(1, q(F.map(f => f.gpu), 0.9)), b90 = Math.max(1, q(F.map(f => f.br), 0.9));
      for (let i = a0; i < b0; i++) {
        const f = feats[i];
        const activity = 0.6 * f.cpu / c90 + 0.2 * f.gpu / g90 + 0.2 * Math.min(1, f.br / b90);
        const steady = f.iqr <= Math.max(10, 0.12 * f.fps);
        flags[i] = activity >= ACTIVE && steady && f.fps > 20;
      }
    }

    const segs = [];
    let cur = null;
    flags.forEach((on, i) => {
      if (!on) return;
      const t = S[i].timestamp_unix;
      if (cur && t - cur.b <= GAP) cur.b = t;
      else { cur = { a: t, b: t }; segs.push(cur); }
    });
    return segs.filter(s => s.b - s.a >= MIN_LEN).map(s => ({ ...s, dur: s.b - s.a }));
  }

  return { detect };
})();
