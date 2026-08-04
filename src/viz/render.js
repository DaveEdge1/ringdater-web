'use strict';
// ============================================================================
// Shared, dependency-free SVG renderer for the six RingdateR plot builders.
//
// The builders (linePlot, datedLinePlot, allSeries, heatmapPlot, detrendPlot,
// leadLagBar) each return a framework-agnostic PLOT SPEC — a plain object:
//
//   { type, width, height, title, xLabel, yLabel,
//     scales: { x:{domain:[min,max], breaks:[...]}, y:{domain, breaks} },
//     marks:  [ line | segment | raster | bar ... ],
//     legend: null | { entries:[{label,color}] },
//     colourbar: null | { colors:[...], limits:[lo,hi], label },
//     panels: undefined | [ subSpec, subSpec, subSpec ] }   // stacked vertically
//
// Mark shapes (all data arrays are the REAL plotted numbers, NA === null):
//   line    { type:'line',    x:[], y:[], color, width, alpha }
//   segment { type:'segment', x0:[], x1:[], y0:[], y1:[], color, width, labels:[] }
//   raster  { type:'raster',  x:[], y:[], fill:[], colors:[] }     // colors: per-cell hex
//   bar     { type:'bar',     x:[], y:[], colors:[], baseline }    // colors: per-bar hex
//
// toSVG(spec) turns a spec into a well-formed, self-contained <svg> string.
// Layout fidelity is deliberately simple (fixed margins): the load-bearing part
// is the DATA carried in the marks, not the pixels.
//
// Colour: valueToColor() reproduces the STRUCTURE of ggplot's
// scale_fill_gradientn(colours = col_pal(...), limits = c(-1,1)) — clamp to the
// limits, then piecewise-linear interpolate across the (evenly spaced) colPal
// stops. ggplot interpolates in CIE-Lab; we interpolate in sRGB, so hex values
// are close but not identical (pixel fidelity is explicitly not required). The
// diverging structure, the clamp, and the stop colours are preserved exactly.
// ============================================================================

// ---- colour helpers ---------------------------------------------------------
function hexToRgb(h) {
  const s = h.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function rgbToHex(c) {
  return '#' + c.map(v => {
    const n = Math.max(0, Math.min(255, Math.round(v)));
    return n.toString(16).padStart(2, '0');
  }).join('');
}
// piecewise-linear ramp across evenly spaced stops; t in [0,1].
function rampColor(stops, t) {
  const tt = Math.max(0, Math.min(1, t));
  if (stops.length === 1) return stops[0];
  const pos = tt * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const frac = pos - i;
  const a = hexToRgb(stops[i]);
  const b = hexToRgb(stops[i + 1]);
  return rgbToHex([0, 1, 2].map(k => a[k] + (b[k] - a[k]) * frac));
}
// map a value to a hex colour across `colors`, clamped to `limits` = [lo,hi].
function valueToColor(v, colors, limits = [-1, 1]) {
  if (v == null || Number.isNaN(v)) return null;
  const [lo, hi] = limits;
  const t = hi === lo ? 0 : (v - lo) / (hi - lo);
  return rampColor(colors, t);
}

// ---- scale helper -----------------------------------------------------------
function linScale(domain, range) {
  const [d0, d1] = domain, [r0, r1] = range;
  const span = d1 - d0 || 1;
  return v => r0 + (v - d0) / span * (r1 - r0);
}

// ---- xml helpers ------------------------------------------------------------
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
const isNum = v => typeof v === 'number' && !Number.isNaN(v);

// build an SVG polyline path, breaking the path wherever x or y is NA.
function linePath(xs, ys, sx, sy) {
  let d = '', pen = false;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (!isNum(x) || !isNum(y)) { pen = false; continue; }
    d += (pen ? 'L' : 'M') + sx(x).toFixed(2) + ',' + sy(y).toFixed(2) + ' ';
    pen = true;
  }
  return d.trim();
}

// smallest positive gap between sorted unique finite values (fallback 1).
function minGap(vals) {
  const u = Array.from(new Set(vals.filter(isNum))).sort((a, b) => a - b);
  let g = Infinity;
  for (let i = 1; i < u.length; i++) { const d = u[i] - u[i - 1]; if (d > 0 && d < g) g = d; }
  return Number.isFinite(g) ? g : 1;
}

// ---- one panel --------------------------------------------------------------
// Renders a single spec's plotting area + axes into an SVG group at (0, offY).
const M = { top: 34, right: 20, bottom: 40, left: 64 };

function renderPanel(spec, offY, colourbarSpace) {
  const w = spec.width;
  const h = spec.height;
  const cbSpace = colourbarSpace ? 26 : 0;
  const left = M.left, right = w - M.right, top = offY + M.top, bottom = offY + h - M.bottom - cbSpace;
  const xd = spec.scales.x.domain, yd = spec.scales.y.domain;
  const sx = linScale(xd, [left, right]);
  const sy = linScale(yd, [bottom, top]);
  const out = [];

  // title
  if (spec.title) out.push(`<text x="${left}" y="${offY + 20}" font-family="sans-serif" font-size="13" font-weight="bold">${esc(spec.title)}</text>`);

  // axes frame
  out.push(`<line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="black" stroke-width="1"/>`);
  out.push(`<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="black" stroke-width="1"/>`);

  // x ticks
  for (const b of (spec.scales.x.breaks || [])) {
    if (!isNum(b) || b < xd[0] || b > xd[1]) continue;
    const X = sx(b);
    out.push(`<line x1="${X.toFixed(2)}" y1="${bottom}" x2="${X.toFixed(2)}" y2="${bottom + 5}" stroke="black" stroke-width="1"/>`);
    out.push(`<text x="${X.toFixed(2)}" y="${bottom + 17}" font-family="sans-serif" font-size="10" text-anchor="middle">${esc(b)}</text>`);
  }
  // y ticks
  for (const b of (spec.scales.y.breaks || [])) {
    if (!isNum(b) || b < yd[0] || b > yd[1]) continue;
    const Y = sy(b);
    out.push(`<line x1="${left - 5}" y1="${Y.toFixed(2)}" x2="${left}" y2="${Y.toFixed(2)}" stroke="black" stroke-width="1"/>`);
    out.push(`<text x="${left - 8}" y="${(Y + 3).toFixed(2)}" font-family="sans-serif" font-size="10" text-anchor="end">${esc(b)}</text>`);
  }
  // axis labels
  if (spec.xLabel) out.push(`<text x="${((left + right) / 2).toFixed(1)}" y="${bottom + 32}" font-family="sans-serif" font-size="11" text-anchor="middle">${esc(spec.xLabel)}</text>`);
  if (spec.yLabel) out.push(`<text x="${left - 46}" y="${((top + bottom) / 2).toFixed(1)}" font-family="sans-serif" font-size="11" text-anchor="middle" transform="rotate(-90 ${left - 46} ${((top + bottom) / 2).toFixed(1)})">${esc(spec.yLabel)}</text>`);

  // clip marks to the panel
  const clipId = 'clip' + Math.round(offY) + '_' + Math.round(w);
  out.push(`<clipPath id="${clipId}"><rect x="${left}" y="${top}" width="${(right - left).toFixed(2)}" height="${(bottom - top).toFixed(2)}"/></clipPath>`);
  out.push(`<g clip-path="url(#${clipId})">`);

  for (const mk of (spec.marks || [])) {
    if (mk.type === 'line') {
      const d = linePath(mk.x, mk.y, sx, sy);
      if (d) out.push(`<path d="${d}" fill="none" stroke="${mk.color || 'black'}" stroke-width="${mk.width || 1}" ${mk.alpha != null && mk.alpha < 1 ? `stroke-opacity="${mk.alpha}"` : ''}/>`);
    } else if (mk.type === 'segment') {
      for (let i = 0; i < mk.x0.length; i++) {
        if (![mk.x0[i], mk.x1[i], mk.y0[i], mk.y1[i]].every(isNum)) continue;
        out.push(`<line x1="${sx(mk.x0[i]).toFixed(2)}" y1="${sy(mk.y0[i]).toFixed(2)}" x2="${sx(mk.x1[i]).toFixed(2)}" y2="${sy(mk.y1[i]).toFixed(2)}" stroke="${mk.color || 'black'}" stroke-width="${mk.width || 2}"/>`);
      }
    } else if (mk.type === 'raster') {
      const cw = Math.abs(sx(xd[0] + minGap(mk.x)) - sx(xd[0]));
      const ch = Math.abs(sy(yd[0] + minGap(mk.y)) - sy(yd[0]));
      for (let i = 0; i < mk.x.length; i++) {
        const col = mk.colors[i];
        if (!isNum(mk.x[i]) || !isNum(mk.y[i]) || !col) continue;
        out.push(`<rect x="${(sx(mk.x[i]) - cw / 2).toFixed(2)}" y="${(sy(mk.y[i]) - ch / 2).toFixed(2)}" width="${cw.toFixed(2)}" height="${ch.toFixed(2)}" fill="${col}" shape-rendering="crispEdges"/>`);
      }
    } else if (mk.type === 'bar') {
      const bw = Math.abs(sx(xd[0] + minGap(mk.x)) - sx(xd[0])) * 0.85;
      const base = sy(mk.baseline != null ? mk.baseline : 0);
      for (let i = 0; i < mk.x.length; i++) {
        if (!isNum(mk.x[i]) || !isNum(mk.y[i])) continue;
        const Y = sy(mk.y[i]);
        const y0 = Math.min(Y, base), hgt = Math.abs(Y - base);
        out.push(`<rect x="${(sx(mk.x[i]) - bw / 2).toFixed(2)}" y="${y0.toFixed(2)}" width="${bw.toFixed(2)}" height="${hgt.toFixed(2)}" fill="${(mk.colors && mk.colors[i]) || mk.color || 'black'}"/>`);
      }
    }
  }
  out.push('</g>');

  // colour bar (below panel)
  if (spec.colourbar) {
    const cb = spec.colourbar;
    const bx = left, bw = Math.min(240, right - left), by = bottom + cbSpace + 8, bh = 8;
    const gid = 'grad' + Math.round(offY);
    const stops = cb.colors.map((c, i) => `<stop offset="${(i / (cb.colors.length - 1) * 100).toFixed(1)}%" stop-color="${c}"/>`).join('');
    out.push(`<defs><linearGradient id="${gid}">${stops}</linearGradient></defs>`);
    out.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="url(#${gid})" stroke="black" stroke-width="0.5"/>`);
    out.push(`<text x="${bx}" y="${by + bh + 12}" font-family="sans-serif" font-size="9">${esc(cb.limits[0])}</text>`);
    out.push(`<text x="${bx + bw}" y="${by + bh + 12}" font-family="sans-serif" font-size="9" text-anchor="end">${esc(cb.limits[1])}</text>`);
    if (cb.label) out.push(`<text x="${bx + bw + 8}" y="${by + bh}" font-family="sans-serif" font-size="10">${esc(cb.label)}</text>`);
  }
  // discrete legend (top-right)
  if (spec.legend && spec.legend.entries) {
    let ly = offY + 14;
    for (const e of spec.legend.entries) {
      out.push(`<rect x="${w - 150}" y="${ly - 8}" width="10" height="10" fill="${e.color}"/>`);
      out.push(`<text x="${w - 136}" y="${ly}" font-family="sans-serif" font-size="10">${esc(e.label)}</text>`);
      ly += 14;
    }
  }
  return out.join('\n');
}

// ---- public: toSVG ----------------------------------------------------------
function toSVG(spec) {
  const panels = spec.panels && spec.panels.length ? spec.panels : [spec];
  const width = spec.width || Math.max(...panels.map(p => p.width));
  let height = 0;
  const parts = [];
  for (const p of panels) {
    parts.push(renderPanel(p, height, !!p.colourbar));
    height += p.height;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif">\n` +
    `<rect width="${width}" height="${height}" fill="white"/>\n` +
    parts.join('\n') + '\n</svg>';
}

// ---- shared numeric helpers used by builders --------------------------------
// R round(x, -1): round to nearest 10 with round-half-to-even (IEC 60559).
function roundR(x, digits) {
  const f = Math.pow(10, -digits); // digits=-1 -> f=10
  const v = x / f;
  const fl = Math.floor(v), diff = v - fl;
  let r;
  if (diff < 0.5) r = fl;
  else if (diff > 0.5) r = fl + 1;
  else r = (fl % 2 === 0) ? fl : fl + 1;
  return r * f;
}

module.exports = {
  toSVG, valueToColor, rampColor, linScale, roundR,
  hexToRgb, rgbToHex, esc,
};
