'use strict';
// Port of ringdater::R_bar_EPS — a thin wrapper over dplR::rwi.stats.running
// (already ported as rBarEps/rwiStatsRunning) that returns a running Rbar / EPS
// table for an aligned chronology.
//
// Mirrors R/R_bar_EPS_function.R exactly:
//   rwi.stats.running(the.data[,-1], method="pearson", running.window=TRUE,
//                     window.length=window, window.overlap=floor(window/2),
//                     first.start=NULL, round.decimals=3, zero.is.missing=TRUE)
// and returns data.frame(mid.year, n.trees, n, rbar.tot, eps).
//
// The one thing the underlying port does NOT do is apply round.decimals=3, so
// this wrapper rounds rbar.tot and eps to 3 decimals with R-compatible
// (round-half-to-even) rounding. Counts / years are integers and pass through.
//
// Input is the shared Frame { names, cols } contract: cols[0] = years,
// cols[1..] = aligned series (missing = null). Output:
//   [ { midYear, nTrees, n, rbarTot, eps }, ... ]  // one row per running window

const { rBarEps: rBarEpsRunning } = require('../rwi_stats.js');

function isNA(v) { return v == null || (typeof v === 'number' && Number.isNaN(v)); }

// R's round(x, digits): round half to even, matching stats::round / IEC 60559.
function roundR(x, digits) {
  if (isNA(x)) return NaN;
  if (!isFinite(x)) return x;
  const p = Math.pow(10, digits);
  const scaled = x * p;
  let r = Math.round(scaled);
  // Math.round rounds .5 up; correct the half-to-even case.
  if (Math.abs(scaled - Math.trunc(scaled)) === 0.5) {
    const floor = Math.floor(scaled);
    r = (floor % 2 === 0) ? floor : floor + 1;
  }
  return r / p;
}

function frameToRwl(frame) {
  const years = frame.cols[0].map(Number);
  const series = {};
  for (let c = 1; c < frame.cols.length; c++) {
    series[frame.names[c]] = frame.cols[c].map(v => (isNA(v) ? null : +v));
  }
  return { years, series };
}

function rBarEps(frame, opts) {
  opts = opts || {};
  const window = opts.window != null ? opts.window : 25;

  const rwl = frameToRwl(frame);
  const segs = rBarEpsRunning(rwl, window);

  return segs.map(s => ({
    midYear: s.midYear,
    nTrees: s.nTrees,
    n: s.n,
    rbarTot: roundR(s.rbarTot, 3),
    eps: roundR(s.eps, 3),
  }));
}

module.exports = { rBarEps };
