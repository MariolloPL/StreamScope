// Stacked time-series panels on one shared time axis (SVG). Shows the selected range, pad/user markers,
// client RFI/IDR events and diagnostic episodes; drag across the chart to pick a range.
SS.Chart = (() => {
  const MONO = 'IBM Plex Mono, ui-monospace, monospace';

  function niceStep(T, W) {
    const target = T / Math.max(3, Math.floor(W / 90));
    return [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].find(v => v >= target) || 7200;
  }
  const niceMax = v => { const c = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400, 500]; return c.find(x => x >= v) || Math.ceil(v / 100) * 100; };

  // opts: { host, panels, t0, t1, range:{a,b}, markers, events, episodes, segs, fmtAxis(u), tipRows(sample), onRange(a,b) }
  function draw(el, opts) {
    const S = opts.host ? opts.host.samples : [];
    const W = Math.max(300, el.clientWidth || 800);
    const padL = 42, padR = 10, padT = 8, gap = 18, axisH = 22;
    const panels = opts.panels;
    const H = padT + panels.reduce((a, p) => a + p.h, 0) + gap * (panels.length - 1) + axisH;
    const T0 = opts.t0, T = Math.max(1, opts.t1 - opts.t0);
    const x = u => padL + ((u - T0) / T) * (W - padL - padR);
    const inv = px => T0 + ((px - padL) / (W - padL - padR)) * T;
    const rect = (a, b, top, h, fill, extra = '') => `<rect x="${x(a).toFixed(1)}" y="${top}" width="${Math.max(1.5, x(b) - x(a)).toFixed(1)}" height="${h}" fill="${fill}"${extra}/>`;

    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Wykresy sesji w czasie">`;
    let top = padT;
    panels.forEach((p, pi) => {
      const vals = [];
      p.series.forEach(se => {
        if (se.points) se.points.forEach(pt => { if (pt.v != null && isFinite(pt.v)) vals.push(pt.v); });
        else S.forEach(s => { const v = se.get(s); if (v != null && isFinite(v)) vals.push(v); });
      });
      const pmax = p.max || niceMax(Math.max(p.minMax || 1, SS.stats.max(vals) || 0) * 1.05);
      const y = v => top + p.h - (Math.min(Math.max(v, 0), pmax) / pmax) * p.h;

      // Background layers: out-of-range dim, diagnostic episodes.
      if (opts.range) {
        svg += rect(T0, opts.range.a, top, p.h, 'var(--dim)') + rect(opts.range.b, opts.t1, top, p.h, 'var(--dim)');
      }
      (opts.episodes || []).forEach(e => { svg += rect(e.a, e.b, top, p.h, e.fill); });

      [0, pmax / 2, pmax].forEach(v => {
        svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"${v ? ' stroke-dasharray="3 4"' : ''}/>`;
        svg += `<text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" font-family="${MONO}" fill="var(--muted)">${Math.round(v)}</text>`;
      });
      svg += `<text x="${padL + 5}" y="${top + 12}" font-size="12" fill="var(--muted)">${p.label}</text>`;
      (p.refLines || []).forEach(r => {
        if (r.v == null || r.v > pmax) return;
        svg += `<line x1="${padL}" x2="${W - padR}" y1="${y(r.v)}" y2="${y(r.v)}" stroke="${r.c}" stroke-opacity=".55" stroke-dasharray="6 4"/>`;
      });

      // Reconnects between uuid segments.
      (opts.segs || []).slice(1).forEach(g => { svg += `<line x1="${x(g.t0)}" x2="${x(g.t0)}" y1="${top}" y2="${top + p.h}" stroke="var(--muted)" stroke-dasharray="2 3"/>`; });

      p.series.forEach(se => {
        let d = '', pen = false, prevU;
        if (se.points) {
          // Series from another source (e.g. client per-second timeline): {u, v}, broken on gaps > 3 s.
          let lastU = null;
          for (const pt of se.points) {
            if (pt.v == null || !isFinite(pt.v) || pt.u < T0 || pt.u > opts.t1) { pen = false; continue; }
            if (lastU != null && pt.u - lastU > 3) pen = false;
            d += `${pen ? 'L' : 'M'}${x(pt.u).toFixed(1)},${y(pt.v).toFixed(1)}`; pen = true; lastU = pt.u;
          }
          svg += `<path d="${d}" fill="none" stroke="${se.c}" stroke-width="${se.w || 1.3}" stroke-linejoin="round" stroke-linecap="round"${se.dash ? ` stroke-dasharray="${se.dash}"` : ''}/>`;
          return;
        }
        for (const s of S) {
          const v = se.get(s);
          if (s.session_uuid !== prevU) { pen = false; prevU = s.session_uuid; }
          if (v == null || !isFinite(v) || (se.skipZero && v <= 0)) { pen = false; continue; }
          d += `${pen ? 'L' : 'M'}${x(s.timestamp_unix).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
        }
        svg += `<path d="${d}" fill="none" stroke="${se.c}" stroke-width="${se.w || 1.3}" stroke-linejoin="round" stroke-linecap="round"/>`;
      });

      // Connection labels (S1 · codec mode) next to each reconnect line, top of the first panel.
      // Labels that would collide drop to a second line; a third collision is skipped (the tooltip still has it).
      if (pi === 0) {
        const ends = [-Infinity, -Infinity];
        (opts.segLabels || []).forEach(sl => {
          const lx = x(sl.u) + 4, row = ends.findIndex(e => lx > e + 8);
          if (row < 0) return;
          ends[row] = lx + sl.label.length * 6.4;
          svg += `<text x="${lx.toFixed(1)}" y="${top + 24 + row * 13}" font-size="11.5" font-family="${MONO}" fill="var(--muted)" stroke="var(--surface)" stroke-width="3" paint-order="stroke">${sl.label.replace(/[<&]/g, '')}</text>`;
        });
      }
      // Detected gameplay as a strip along the bottom of the first panel.
      if (pi === 0) (opts.bands || []).forEach(bd => { svg += rect(bd.a, bd.b, top + p.h - 5, 5, bd.fill, ' opacity=".8"'); });
      // Client events as ticks along the top of the first panel.
      if (pi === 0) {
        (opts.events || []).forEach(e => {
          const c = e.type === 'rfi' ? 'var(--warn)' : 'var(--crit)';
          svg += `<line x1="${x(e.u)}" x2="${x(e.u)}" y1="${top}" y2="${top + 9}" stroke="${c}" stroke-width="2"/>`;
        });
      }
      // Markers span every panel.
      (opts.markers || []).forEach(m => {
        svg += `<line x1="${x(m.u)}" x2="${x(m.u)}" y1="${top}" y2="${top + p.h}" stroke="${m.type === 'pad-off' ? 'var(--mk-off)' : m.type === 'pad-on' ? 'var(--mk-on)' : 'var(--accent)'}" stroke-width="1.5"/>`;
      });
      if (opts.range) {
        [opts.range.a, opts.range.b].forEach(u => { svg += `<line x1="${x(u)}" x2="${x(u)}" y1="${top}" y2="${top + p.h}" stroke="var(--ink)" stroke-width="1.5"/>`; });
      }
      top += p.h + gap;
    });

    // Ticks land on round values of the displayed clock (axisBase = its zero), not of the file start.
    const axY = H - 6, step = niceStep(T, W), zero = opts.axisBase ?? T0;
    for (let u = zero + Math.ceil((T0 - zero) / step) * step; u <= opts.t1 + 0.001; u += step) {
      const lx = x(u);
      if (lx < padL + 12 || lx > W - padR - 12) continue;
      svg += `<text x="${lx}" y="${axY}" text-anchor="middle" font-size="11" font-family="${MONO}" fill="var(--muted)">${opts.fmtAxis(u)}</text>`;
    }
    svg += `<rect class="sel" x="0" y="0" width="0" height="${H - axisH}" fill="var(--accent)" fill-opacity=".15" visibility="hidden"/>`;
    svg += `<line class="cross" x1="0" x2="0" y1="0" y2="${H - axisH}" stroke="var(--ink)" stroke-opacity=".4" visibility="hidden"/>`;
    svg += `<rect class="hit" x="${padL}" y="0" width="${W - padL - padR}" height="${H - axisH}" fill="transparent" style="touch-action:pan-y"/></svg>`;
    el.innerHTML = svg + `<div class="tip" hidden></div>`;

    const svgEl = el.querySelector('svg'), tip = el.querySelector('.tip'), cross = el.querySelector('.cross'), hit = el.querySelector('.hit'), sel = el.querySelector('.sel');
    const toPx = ev => { const r = svgEl.getBoundingClientRect(); return (ev.clientX - r.left) * (W / r.width); };
    let drag = null;

    function nearest(u) {
      let lo = 0, hi = S.length - 1;
      if (hi < 0) return null;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid].timestamp_unix < u) lo = mid; else hi = mid; }
      return Math.abs(S[lo].timestamp_unix - u) <= Math.abs(S[hi].timestamp_unix - u) ? S[lo] : S[hi];
    }
    function showTip(ev, px) {
      const u = inv(px);
      const s = nearest(u);
      const cu = s ? s.timestamp_unix : u;
      cross.setAttribute('x1', x(cu)); cross.setAttribute('x2', x(cu)); cross.setAttribute('visibility', 'visible');
      const near = (opts.markers || []).filter(m => Math.abs(m.u - u) <= T / 150).map(m => m.label);
      tip.innerHTML = `<b>${opts.fmtAxis(cu)} · ${SS.time.clock(cu)}</b>` + (s ? opts.tipRows(s) : '') + (opts.tipExtra ? opts.tipExtra(cu) : '') + (near.length ? `<br><b>${near.join(', ')}</b>` : '');
      tip.hidden = false;
      const r = el.getBoundingClientRect();
      const left = ev.clientX - r.left + 14;
      tip.style.left = Math.max(0, Math.min(left, r.width - tip.offsetWidth - 4)) + 'px';
      tip.style.top = Math.max(0, ev.clientY - r.top - tip.offsetHeight - 12) + 'px';
    }
    hit.addEventListener('pointerdown', ev => { drag = { px: toPx(ev), id: ev.pointerId, moved: false }; hit.setPointerCapture(ev.pointerId); showTip(ev, toPx(ev)); });
    hit.addEventListener('pointermove', ev => {
      const px = toPx(ev);
      if (drag && Math.abs(px - drag.px) > 6) {
        drag.moved = true;
        const a = Math.min(px, drag.px), b = Math.max(px, drag.px);
        sel.setAttribute('x', a); sel.setAttribute('width', b - a); sel.setAttribute('visibility', 'visible');
      }
      showTip(ev, px);
    });
    const end = ev => {
      if (drag && drag.moved && opts.onRange) {
        const px = toPx(ev);
        const a = inv(Math.max(padL, Math.min(px, drag.px))), b = inv(Math.min(W - padR, Math.max(px, drag.px)));
        drag = null; sel.setAttribute('visibility', 'hidden');
        opts.onRange(a, b);
        return;
      }
      drag = null;
    };
    hit.addEventListener('pointerup', end);
    hit.addEventListener('pointercancel', () => { drag = null; sel.setAttribute('visibility', 'hidden'); });
    hit.addEventListener('pointerleave', () => { if (!drag) { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); } });
  }

  return { draw };
})();
