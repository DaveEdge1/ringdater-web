'use strict';
// ============================================================================
// rollcorFast — the same running Pearson correlation as rollcor.js, computed by
// sliding running sums instead of re-reading the whole window each step.
//
// rollcor() is the faithful port of ringdater's R rollcor_function.R and stays
// the reference implementation: it is what the R ground-truth tests compare
// against, and it is what runningLeadLag uses by default. This module exists
// only because the crossdating verdict needs the same numbers a few thousand
// times over — one running correlation per lag per series — where rollcor's
// O(n * width) becomes the dominant cost of a run.
//
// CONTRACT (identical to rollcor, deliberately):
//   * `width` must be odd;
//   * output length is len - (width - 1), one value per window position;
//   * a window containing ANY missing value yields NaN, exactly as R's
//     cor(use = "everything") does — running_lead_lag depends on that, since
//     its shifted overlaps are NA-padded.
//
// NUMERICAL NOTE: adding and subtracting as the window slides accumulates
// rounding that re-summing does not. Over a series of a few thousand detrended
// indices the drift is ~1e-12 relative, far below anything that changes a
// reported correlation, and rollcor_fast_test.js pins the two implementations
// together at 1e-9. Where exactness against R matters, use rollcor.
// ============================================================================

const toNum = v => (v == null ? NaN : +v);

function rollcorFast(x, y, width) {
  const xv = Array.from(x, toNum);
  const yv = Array.from(y, toNum);
  if (xv.length !== yv.length) throw new Error('rollcorFast: length(x) must equal length(y)');
  if (width % 2 === 0) throw new Error('rollcorFast: width must be an odd number');

  const len = xv.length;
  const nOut = len - (width - 1);
  if (nOut <= 0) return [];
  const out = new Array(nOut);

  // Running window state. A missing value contributes nothing to the sums and
  // is counted instead, so `bad > 0` marks a window that must return NaN
  // without the sums ever having been polluted by it.
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, bad = 0;

  const add = i => {
    const a = xv[i], b = yv[i];
    if (Number.isNaN(a) || Number.isNaN(b)) { bad++; return; }
    sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
  };
  const drop = i => {
    const a = xv[i], b = yv[i];
    if (Number.isNaN(a) || Number.isNaN(b)) { bad--; return; }
    sx -= a; sy -= b; sxx -= a * a; syy -= b * b; sxy -= a * b;
  };

  for (let i = 0; i < width; i++) add(i);
  for (let w = 0; w < nOut; w++) {
    if (w > 0) { drop(w - 1); add(w + width - 1); }
    if (bad > 0) { out[w] = NaN; continue; }
    const n = width;
    const dxx = sxx - sx * sx / n;
    const dyy = syy - sy * sy / n;
    const den = Math.sqrt(dxx * dyy);
    out[w] = den > 0 ? (sxy - sx * sy / n) / den : NaN;
  }
  return out;
}

module.exports = { rollcorFast };
