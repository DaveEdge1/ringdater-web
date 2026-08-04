'use strict';
// datedLinePlot — sample coverage plot (port of R/dated_line_plot_function.R).
// The R function is a DATA-PREP helper: it returns a long data.frame `res` with
// columns (name.val, samp.val, dates) — two rows per series giving the first and
// last year the series is present, with series ORDERED by their start year and
// assigned an ascending sample index (samp.val). We reproduce `res` exactly and
// additionally render it as one horizontal segment per series.

const C = require('../analysis/comb.js');
const { toSVG } = require('./render.js');

// min/max year where a series column is present (complete case with its year).
function spanOf(years, vals) {
  let lo = Infinity, hi = -Infinity, any = false;
  for (let i = 0; i < years.length; i++) {
    if (!C.isNA(years[i]) && !C.isNA(vals[i])) { any = true; const y = +years[i]; if (y < lo) lo = y; if (y > hi) hi = y; }
  }
  return any ? { start: lo, end: hi } : null;
}

// Build the R `res` frame: {name.val, samp.val, dates}, 2 rows per series.
function datedLinePlotData(theData) {
  const f = C.asFrame(theData);
  const years = C.col(f, 0);
  const names = C.names(f);
  // start year per series (col 1..)
  const starts = [];
  for (let a = 1; a < C.ncol(f); a++) {
    const sp = spanOf(years, C.col(f, a));
    starts.push({ name: names[a], start: sp ? sp.start : Infinity, col: a });
  }
  // order by start ascending (stable — R order() keeps input order on ties)
  const order = starts.map((s, i) => ({ ...s, i })).sort((p, q) => (p.start - q.start) || (p.i - q.i));

  const nameVal = [], sampVal = [], dates = [];
  const segX0 = [], segX1 = [], segY0 = [], segY1 = [], labels = [];
  order.forEach((s, k) => {
    const samp = k + 1;
    const sp = spanOf(years, C.col(f, s.col));
    nameVal.push(s.name, s.name);
    sampVal.push(samp, samp);
    dates.push(sp.start, sp.end);
    segX0.push(sp.start); segX1.push(sp.end); segY0.push(samp); segY1.push(samp); labels.push(s.name);
  });
  return { res: { names: ['name.val', 'samp.val', 'dates'], cols: [nameVal, sampVal, dates] },
    seg: { segX0, segX1, segY0, segY1, labels } };
}

function datedLinePlot(theData, opts = {}) {
  const { res, seg } = datedLinePlotData(theData);
  const nSer = res.cols[1].length ? Math.max(...res.cols[1]) : 0;
  const xs = res.cols[2];
  const spec = {
    type: 'datedLinePlot',
    width: opts.width || 760,
    height: opts.height || Math.max(200, 40 + nSer * 18),
    title: opts.title || 'Sample coverage',
    xLabel: 'Years',
    yLabel: 'Sample',
    scales: {
      x: { domain: [Math.min(...xs), Math.max(...xs)], breaks: null },
      y: { domain: [0, nSer + 1], breaks: Array.from({ length: nSer }, (_, i) => i + 1) },
    },
    marks: [{ type: 'segment', x0: seg.segX0, x1: seg.segX1, y0: seg.segY0, y1: seg.segY1, labels: seg.labels, color: 'black', width: 3 }],
    legend: null,
    colourbar: null,
    data: { res },
  };
  return spec;
}

module.exports = { datedLinePlot, datedLinePlotData, toSVG };
