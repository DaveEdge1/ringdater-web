'use strict';
// allSeries — all aligned series (semi-transparent black) plus the arithmetic
// mean chronology (red). Port of R/plot_all_series_function.R.
//   new_chron_mean <- rowMeans(aligned_data[,-1], na.rm = TRUE)
//   per series b:  complete cases of (aligned_data[,1], aligned_data[,b])
// x breaks: x.scale.bar over the rounded (nearest 10) year range of the plotted
// points (`new[,1]`).

const C = require('../analysis/comb.js');
const { xScaleBar } = require('./chartUtils.js');
const { toSVG, roundR } = require('./render.js');

function allSeries(alignedData, opts = {}) {
  const f = C.asFrame(alignedData);
  if (C.ncol(f) <= 2) throw new Error('Error in plot_all_series(). Insufficient data.');
  const years = C.col(f, 0);
  const names = C.names(f);

  // arithmetic mean chronology over series columns (na.rm = TRUE)
  const meanChron = C.rowMeans(f, { cols: f.cols.map((_, i) => i).slice(1), naRm: true });
  const chronX = [], chronY = [];
  for (let r = 0; r < years.length; r++) {
    if (!C.isNA(years[r]) && !C.isNA(meanChron[r])) { chronX.push(+years[r]); chronY.push(meanChron[r]); }
  }

  // per-series complete-case lines + collect the overall x range of `new[,1]`
  const groups = [];
  let xLo = Infinity, xHi = -Infinity, yLo = Infinity, yHi = -Infinity;
  for (let b = 1; b < C.ncol(f); b++) {
    const vals = C.col(f, b);
    const gx = [], gy = [];
    for (let r = 0; r < years.length; r++) {
      if (!C.isNA(years[r]) && !C.isNA(vals[r])) {
        const x = +years[r], y = +vals[r];
        gx.push(x); gy.push(y);
        if (x < xLo) xLo = x; if (x > xHi) xHi = x;
        if (y < yLo) yLo = y; if (y > yHi) yHi = y;
      }
    }
    groups.push({ name: names[b], x: gx, y: gy, group: b });
  }
  for (const y of chronY) { if (y < yLo) yLo = y; if (y > yHi) yHi = y; }

  const marks = groups.map(g => ({ type: 'line', x: g.x, y: g.y, color: 'black', width: opts.plot_line || 0.5, alpha: 0.5 }));
  marks.push({ type: 'line', x: chronX, y: chronY, color: 'red', width: opts.plot_line || 0.5 });

  const spec = {
    type: 'allSeries',
    width: opts.width || 760,
    height: opts.height || 320,
    title: opts.title || 'All series (black) and mean chronology (red)',
    xLabel: 'Years',
    yLabel: 'Standardised increment width',
    scales: {
      x: { domain: [xLo, xHi], breaks: xScaleBar(roundR(xLo, -1), roundR(xHi, -1)) },
      y: { domain: [yLo, yHi], breaks: null },
    },
    marks,
    legend: { entries: [{ label: 'series', color: 'black' }, { label: 'mean chronology', color: 'red' }] },
    colourbar: null,
    data: { meanChronology: { x: chronX, y: chronY }, series: groups },
  };
  return spec;
}

module.exports = { allSeries, toSVG };
