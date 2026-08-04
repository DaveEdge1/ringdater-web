'use strict';
// ============================================================================
// Port of ringdater::normalise() — the detrending dispatcher / central detrend
// entry point (R/normalise_function.R).
//
// normalise(frame, opts) -> Frame with the SAME column names as the input:
// column 0 is the years/increment column (carried through untouched); each
// remaining series column is detrended by the selected method, then optionally
// AR-prewhitened, optionally log-transformed, and (for methods > 1) re-scaled
// to z-scores + 1. Rows whose year column is NA are dropped at the end.
//
// detrending_select:
//   1 = raw (do nothing)          5 = Friedman (super-smoother)  ratio
//   2 = z-score (scale)           6 = ModHugershoff (nls)        ratio
//   3 = Spline                    7 = first difference A[j+1]-A[j]
//   4 = ModNegExp (nls)  ratio
//
// dplR's detrend.series replaces zeros with 0.001 before fitting the curve and
// returns (zero-replaced series)/curve for methods 3/4/5/6; we replicate that.
// Methods 4 & 6 use nls: our modNegExp/modHugershoff may converge where R's nls
// bailed to a linear/mean fallback (a documented PATH-DIFF).
// ============================================================================

const C = require('../analysis/comb.js');
const { detrendSpline } = require('../spline.js');
const { modNegExp, modHugershoff } = require('../curvefit.js');
const { friedman } = require('../supsmu.js');
const { whitenSeries } = require('../prewhiten.js');

const isNA = C.isNA;

// R scale() on a vector: z-score with na.rm behaviour (mean over non-NA, scale
// factor = sqrt(sum(centered^2)/max(1, nNonNA-1)) over non-NA). NA stays NA.
function scaleNA(x) {
  let s = 0, n = 0;
  for (const v of x) if (!isNA(v)) { s += v; n++; }
  const mean = n > 0 ? s / n : NaN;
  let ss = 0;
  for (const v of x) if (!isNA(v)) { const d = v - mean; ss += d * d; }
  const sd = Math.sqrt(ss / Math.max(1, n - 1));
  return x.map(v => (isNA(v) ? C.NA : (v - mean) / sd));
}

// Indices of the (contiguous) non-NA run; returns {lo, hi} inclusive or null.
function nonNArange(x) {
  let lo = -1, hi = -1;
  for (let i = 0; i < x.length; i++) if (!isNA(x[i])) { if (lo < 0) lo = i; hi = i; }
  return lo < 0 ? null : { lo, hi };
}

// Run f on the non-NA core of A (as a plain number[]), re-inserting NA padding
// at the original leading/trailing positions. f: number[] -> number[].
function onCore(A, f) {
  const r = nonNArange(A);
  if (!r) return A.map(() => C.NA);
  const core = [];
  for (let i = r.lo; i <= r.hi; i++) core.push(Number(A[i]));
  const res = f(core);
  const out = A.map(() => C.NA);
  for (let i = 0; i < res.length; i++) out[r.lo + i] = res[i];
  return out;
}

// dplR ratio detrend for the nls / super-smoother curve methods: zeros -> 0.001,
// then (zero-replaced series) / curve.
function ratioDetrend(core, curveOf) {
  const ymod = core.map(v => (v === 0 ? 0.001 : v));
  const curve = curveOf(ymod);
  return ymod.map((v, i) => v / curve[i]);
}

function detrendColumn(A, sel, splinewindow) {
  switch (sel) {
    case 1: return A.slice();
    case 2: return scaleNA(A);
    case 3: return onCore(A, core => detrendSpline(core, splinewindow, 0.5).detrended);
    case 4: return onCore(A, core => ratioDetrend(core, y => modNegExp(y, true).curve));
    case 5: return onCore(A, core => ratioDetrend(core, y => friedman(y).curve));
    case 6: return onCore(A, core => ratioDetrend(core, y => modHugershoff(y, true).curve));
    case 7: {
      // R: for j in 1:length(A) { tmp_diff <- c(tmp_diff, A[j+1]-A[j]) }
      // Length == length(A); last element uses A[n+1] == NA -> NA. NAs propagate.
      const n = A.length, out = new Array(n);
      for (let j = 0; j < n; j++) {
        const a = A[j], b = j + 1 < n ? A[j + 1] : C.NA;
        out[j] = (isNA(a) || isNA(b)) ? C.NA : b - a;
      }
      return out;
    }
    default: throw new Error('normalise: detrending_select must be 1..7');
  }
}

// AR prewhitening on the non-NA core, re-padding leading/trailing NAs (mirrors
// whitenSeries' NA bookkeeping).
function arWhiten(A) {
  return onCore(A, core => whitenSeries(core));
}

// R: A <- A + (abs(min(A, na.rm=T)) + 1) * 7/6 ; A <- log(A). NA stays NA.
function logTransform(A) {
  let mn = Infinity;
  for (const v of A) if (!isNA(v) && v < mn) mn = v;
  const c = (Math.abs(mn) + 1) * 7 / 6;
  return A.map(v => (isNA(v) ? C.NA : Math.log(v + c)));
}

function normalise(frameIn, opts = {}) {
  const {
    detrending_select = 1,
    splinewindow = 21,
    ARmod = false,
    logT = false,
  } = opts;

  if (![1, 2, 3, 4, 5, 6, 7].includes(detrending_select)) {
    throw new Error('normalise: detrending_select must be a numeric integer from 1 to 7.');
  }
  if (typeof splinewindow !== 'number') {
    throw new Error('normalise: splinewindow must be numeric');
  }
  if (splinewindow < 5 || splinewindow > 200) {
    throw new Error('normalise: splinewindow must be from 5 to 200.');
  }
  const frame = C.asFrame(frameIn);
  if (C.ncol(frame) < 2) throw new Error('normalise: Insufficient data.');

  const inputNames = C.names(frame);
  const yearCol = C.col(frame, 0);

  // det_tmp starts as the year column; each detrended series is column-bound.
  let detTmp = { names: [inputNames[0]], cols: [yearCol.slice()] };

  for (let s = 1; s < C.ncol(frame); s++) {
    let A = detrendColumn(C.col(frame, s), detrending_select, splinewindow);
    if (ARmod) A = arWhiten(A);
    if (logT) A = logTransform(A);
    if (detrending_select > 1) A = scaleNA(A).map(v => (isNA(v) ? C.NA : v + 1));
    detTmp = C.combNA(detTmp, A);
  }

  detTmp = C.setNames(detTmp, inputNames);
  // R: subset(det_tmp, !is.na(det_tmp[,1])) — drop rows where the year col is NA.
  return C.subsetRows(detTmp, row => !isNA(row[0]));
}

module.exports = { normalise, scaleNA };
