'use strict';
// Faithful JS port of dplR's caps_f (src/capsf.f95): Cook/Holmes cubic
// smoothing spline. Returns the fitted spline CURVE (same as dplR::caps).
// Translated 1-based to keep index parity with the Fortran; a[] has a dummy
// row 0 and columns 0..4 (1..4 used). Literal constants copied verbatim from
// the Fortran to preserve rounding.

function caps(yIn, nyrs, pct) {
  if (pct === undefined) pct = 0.5;
  const y0 = Float64Array.from(yIn, Number);
  const n = y0.length;
  if (!(nyrs > 0)) throw new Error("nyrs must be > 0");
  // dplR::caps wrapper behaviour
  if (nyrs <= 1 && nyrs > 0) nyrs = nyrs * n;
  let stiffness = Math.trunc(nyrs);           // R does as.integer(nyrs)
  if (pct === 1) return Array.from(y0);       // f==1 -> ySpl <- y

  // --- caps_f begins ---
  // exact Fortran literals
  const c1 = [0, 1.0, -4.0, 6.0, -2.0];                 // c1(1..4)
  const c2 = [0, 0.0, 0.33333333333333, 1.33333333333333]; // c2(1..3)
  const pi = 3.1415926535897935;

  const res = new Float64Array(n + 1);        // res(1..n)
  const y = new Float64Array(n + 1);          // y(1..n)
  for (let i = 1; i <= n; i++) y[i] = y0[i - 1];

  if (n < 4) { res[1] = -9998; return sliceRes(res, n); }

  const nm2 = n - 2;
  const v = stiffness;
  // p=((1/(1-pct)-1)*6*(cos(pi*2/v)-1)^2)/(cos(pi*2/v)+2)
  const cw = Math.cos(pi * 2.0 / v);
  const p = ((1.0 / (1.0 - pct) - 1.0) * 6.0 * Math.pow(cw - 1.0, 2)) / (cw + 2.0);

  // a(9001,4) banded storage -> a[i][j], i in 1..nm2, j in 1..4
  const a = new Array(nm2 + 1);
  for (let i = 0; i <= nm2; i++) a[i] = new Float64Array(5);

  for (let i = 1; i <= nm2; i++) {
    for (let j = 1; j <= 3; j++) a[i][j] = c1[j] + p * c2[j];
    a[i][4] = y[i] + c1[4] * y[i + 1] + y[i + 2];
  }
  a[1][1] = c2[1]; a[1][2] = c2[1]; a[2][1] = c2[1];  // c2(1)=0
  const nc = 2;

  // begin ludapb
  const rn = 1.0 / (nm2 * 16.0);
  let d1 = 1.0, d2 = 0.0;
  const ncp1 = nc + 1;                        // 3
  // zero elements
  for (let i = 1; i <= nc; i++) {
    for (let j = i; j <= nc; j++) { const k = ncp1 - j; a[i][k] = 0.0; }
  }
  for (let i = 1; i <= nm2; i++) {
    const imncp1 = i - ncp1;
    const i1 = Math.max(1, 1 - imncp1);
    for (let j = i1; j <= ncp1; j++) {
      const l = imncp1 + j;
      const i2 = ncp1 - j;
      let sum = a[i][j];
      const jm1 = j - 1;
      if (jm1 > 0) {
        for (let k = 1; k <= jm1; k++) { const m = i2 + k; sum -= a[i][k] * a[l][m]; }
      }
      if (j === ncp1) {
        if (a[i][j] + sum * rn <= a[i][j]) { res[1] = -9999; return sliceRes(res, n); }
        a[i][j] = 1.0 / Math.sqrt(sum);
        d1 = d1 * sum;
        while (Math.abs(d1) > 1.0) { d1 = d1 * 0.0625; d2 = d2 + 4.0; }   // label 35
        while (Math.abs(d1) <= 0.0625) { d1 = d1 * 16.0; d2 = d2 - 4.0; } // label 47
        continue;                              // goto 60 (skip line below)
      }
      a[i][j] = sum * a[l][ncp1];
    }
  }
  // begin luelpb : solve Ly = b
  const nc1 = nc + 1;                          // 3
  let iw = 0, l = 0;
  for (let i = 1; i <= nm2; i++) {
    let sum = a[i][4];
    if (nc > 0) {
      if (iw !== 0) {
        l = l + 1; if (l > nc) l = nc;
        const k = nc1 - l; let kl = i - l;
        for (let j = k; j <= nc; j++) { sum -= a[kl][4] * a[i][j]; kl = kl + 1; }
      } else {
        if (sum !== 0.0) iw = 1;
      }
    }
    a[i][4] = sum * a[i][nc1];
  }
  // solve Ux = y
  a[nm2][4] = a[nm2][4] * a[nm2][nc1];
  const n1 = nm2 + 1;
  for (let i = 2; i <= nm2; i++) {
    const k = n1 - i;
    let sum = a[k][4];
    if (nc > 0) {
      const kl = k + 1;
      const k1 = Math.min(nm2, k + nc);
      let ll = 1;
      for (let j = kl; j <= k1; j++) { sum -= a[j][4] * a[j][nc1 - ll]; ll = ll + 1; }
    }
    a[k][4] = sum * a[k][nc1];
  }
  // end luelpb : reconstruct
  for (let i = 3; i <= nm2; i++) res[i] = a[i - 2][4] + c1[4] * a[i - 1][4] + a[i][4];
  res[1] = a[1][4];
  res[2] = c1[4] * a[1][4] + a[2][4];
  res[n - 1] = a[nm2 - 1][4] + c1[4] * a[nm2][4];
  res[n] = a[nm2][4];
  for (let i = 1; i <= n; i++) res[i] = y[i] - res[i];

  return sliceRes(res, n);
}

function sliceRes(res, n) {
  const out = new Array(n);
  for (let i = 1; i <= n; i++) out[i - 1] = res[i];
  return out;
}

// Wrapper replicating dplR::detrend.series(method="Spline") ratio pipeline:
// zeros in the series are replaced by 0.001 before splining, the curve is
// caps() of that series, and the detrended output is the ratio series/curve.
// (Assumes NAs already stripped, as in ringdater's normalise().)
function detrendSpline(yIn, nyrs, f) {
  const y = Float64Array.from(yIn, Number);
  const ymod = Float64Array.from(y, v => (v === 0 ? 0.001 : v));
  const curve = caps(ymod, nyrs, f === undefined ? 0.5 : f);
  const detrended = new Array(y.length);
  for (let i = 0; i < y.length; i++) detrended[i] = ymod[i] / curve[i];
  return { curve, detrended };
}

module.exports = { caps, detrendSpline };
