'use strict';
// Port of ringdater::rollcor — running Pearson correlation over a sliding
// window of odd length `width`. Returns the vector of correlations, one per
// window position, of length len - (width - 1).
//
// R (rollcor_function.R):
//   halfWidth <- (width - 1) / 2; lenCC <- len - 2*halfWidth
//   for i in 1..lenCC: cc[i] <- cor(x[i:(i+width-1)], y[i:(i+width-1)])
// cor()'s default is Pearson; we reuse the validated pearsonCorTest for r.
// cor()'s default use="everything" yields NA for any window containing an NA,
// which running_lead_lag relies on (its shifted overlaps are NA-padded), so a
// window with any non-finite value returns NaN here rather than a spurious r.

const { pearsonCorTest } = require('../stats/cortest.js');

// null/NA -> NaN (so NA windows are detectable); numbers pass through.
const toNum = v => (v == null ? NaN : +v);

function rollcor(x, y, width) {
  const xv = Array.from(x, toNum);
  const yv = Array.from(y, toNum);
  if (xv.length !== yv.length) throw new Error('rollcor: length(x) must equal length(y)');
  if (width % 2 === 0) throw new Error('rollcor: width must be an odd number');

  const len = xv.length;
  const halfWidth = (width - 1) / 2;
  const lenCC = len - 2 * halfWidth;
  const cc = new Array(Math.max(lenCC, 0));
  for (let i = 0; i < lenCC; i++) {
    // R window x[start:end], start=i+1..end=i+width (1-based, inclusive)
    const xs = xv.slice(i, i + width);
    const ys = yv.slice(i, i + width);
    let hasNA = false;
    for (let j = 0; j < width; j++) if (Number.isNaN(xs[j]) || Number.isNaN(ys[j])) { hasNA = true; break; }
    cc[i] = hasNA ? NaN : pearsonCorTest(xs, ys).r;
  }
  return cc;
}

module.exports = { rollcor };
