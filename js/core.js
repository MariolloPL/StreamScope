// Shared helpers: statistics, time formatting and parsing. Everything hangs off the global SS namespace
// so the app runs from plain <script> tags (GitHub Pages and file:// alike, no build step).
window.SS = window.SS || {};

SS.stats = (() => {
  const sorted = a => [...a].sort((x, y) => x - y);
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  // Linear interpolation between closest ranks (same as numpy's default), used for benchmark percentiles.
  const quantile = (a, p) => {
    if (!a.length) return null;
    const s = sorted(a), i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  const max = a => a.length ? a.reduce((x, y) => (y > x ? y : x), -Infinity) : null;
  const min = a => a.length ? a.reduce((x, y) => (y < x ? y : x), Infinity) : null;
  return { sorted, mean, quantile, median: a => quantile(a, 0.5), max, min };
})();

SS.time = (() => {
  // Elapsed seconds → "28:17" or "1:00:04", matching the timestamps in StreamLight logs.
  function fmt(sec) {
    const neg = sec < 0; sec = Math.round(Math.abs(sec));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (neg ? '-' : '') + (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
  }
  // "1:00:04" → 3604, "28:17" → 1697, "28" → 1680 (bare number = minutes). Returns null when unparseable.
  function parse(str) {
    const t = String(str || '').trim().replace(',', '.');
    if (!t) return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return parseFloat(t) * 60;
    const m = t.match(/^(-)?(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
    if (!m) return null;
    const v = (+(m[2] || 0)) * 3600 + (+m[3]) * 60 + parseFloat(m[4]);
    return m[1] ? -v : v;
  }
  const clock = unix => new Date(unix * 1000).toLocaleTimeString('pl-PL');
  const date = unix => new Date(unix * 1000).toLocaleString('pl-PL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return { fmt, parse, clock, date };
})();

SS.fmt = (() => {
  const nf = d => new Intl.NumberFormat('pl-PL', { minimumFractionDigits: d, maximumFractionDigits: d });
  const cache = {};
  const num = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : (cache[d] || (cache[d] = nf(d))).format(v);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return { num, esc };
})();
