'use strict';
// Port of ringdater::detcurves — returns the fitted detrending CURVES (not the
// detrended ratio) as a Frame parallel to the input. Column 0 is preserved as
// the years/increment column; each series column is replaced by its fitted
// curve, NA-padded back to the original (matching dplR::detrend.series, which
// strips NA, fits on the non-NA span, then re-inserts NA at the same rows).
//
//   detrending_select: 1,2,7 -> raw series column (identity curve)
//                      3      -> detrendSpline(y, splinewindow, 0.5).curve
//                      4      -> modNegExp(y).curve       (ModNegExp)
//                      5      -> friedman(y).curve        (Friedman/supsmu)
//                      6      -> modHugershoff(y, true).curve (ModHugershoff, pos.slope)

const C = require('../analysis/comb.js');
const { detrendSpline } = require('../spline.js');
const { modNegExp, modHugershoff } = require('../curvefit.js');
const { friedman } = require('../supsmu.js');

function fitCurve(vals, method, splinewindow) {
  switch (method) {
    case 1: case 2: case 7: return vals.slice();
    case 3: return detrendSpline(vals, splinewindow, 0.5).curve;
    case 4: return modNegExp(vals).curve;                 // pos.slope = FALSE
    case 5: return friedman(vals).curve;
    case 6: return modHugershoff(vals, true).curve;        // pos.slope = TRUE
    default: throw new Error('detcurves: detrending_select must be an integer 1..7');
  }
}

// Strip NA, fit on the non-NA values, re-pad the curve to the original rows.
function curveForSeries(s, method, splinewindow) {
  const n = s.length;
  const idx = [], vals = [];
  for (let i = 0; i < n; i++) if (!C.isNA(s[i])) { idx.push(i); vals.push(s[i]); }
  const curve = fitCurve(vals, method, splinewindow);
  const out = new Array(n).fill(C.NA);
  for (let j = 0; j < idx.length; j++) out[idx[j]] = curve[j];
  return out;
}

function detcurves(input, opts = {}) {
  const { detrending_select = 1, splinewindow = 21 } = opts;
  if (!(detrending_select >= 1 && detrending_select <= 7)) {
    throw new Error('detcurves: detrending_select must be a numeric integer from 1 to 7.');
  }
  if (splinewindow < 5 || splinewindow > 200) {
    throw new Error('detcurves: splinewindow must be a numeric integer from 5 to 200.');
  }
  const f = C.asFrame(input);
  if (C.ncol(f) < 2) throw new Error('detcurves: insufficient data to calculate curves');

  const inNames = C.names(f);
  const outNames = [inNames[0]];
  const outCols = [C.col(f, 0).slice()];
  for (let a = 1; a < C.ncol(f); a++) {
    outNames.push(inNames[a]);
    outCols.push(curveForSeries(C.col(f, a), detrending_select, splinewindow));
  }
  return { names: outNames, cols: outCols };
}

module.exports = { detcurves };
