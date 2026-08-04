'use strict';
// Full autoregressive prewhitening with AIC order selection.
// Port of stats::ar (univariate Yule-Walker path) as invoked by
// dplR:::ar.func inside dplR:::normalize1:
//   ar1 <- ar(y[!is.na(y)]); y[!is.na(y)] <- ar1$resid + ar1$x.mean
// i.e. fit AR(p) with p chosen by AIC (order.max = min(n-1, floor(10*log10(n)))),
// return residuals (leading `order` residuals are NA) with the series mean added
// back. The AR(1) prewhiten.js is the fixed-order COFECHA variant; this is the
// dplR crossdating variant and must reproduce ar()'s order selection exactly.

function mean(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s / x.length; }

// acf(x, type="covariance", demean=TRUE): autocovariance of demeaned x, divisor n.
function acov(xc, maxlag) {
  const n = xc.length;
  const r = new Float64Array(maxlag + 1);
  for (let k = 0; k <= maxlag; k++) {
    let s = 0;
    for (let t = 0; t + k < n; t++) s += xc[t] * xc[t + k];
    r[k] = s / n;
  }
  return r;
}

// Levinson-Durbin recursion (== stats' C_eureka): from autocov r[0..p] produce,
// for every model order m=1..p, the AR coefficients coefs[m-1][0..m-1] and the
// prediction variance vars[m-1].
function levinson(r, orderMax) {
  const coefs = [];
  const vars = new Float64Array(orderMax);
  const a = new Float64Array(orderMax + 1);
  let v = r[0];
  for (let m = 1; m <= orderMax; m++) {
    let acc = r[m];
    for (let j = 1; j < m; j++) acc -= a[j] * r[m - j];
    const k = acc / v;
    const aold = a.slice();
    a[m] = k;
    for (let j = 1; j < m; j++) a[j] = aold[j] - k * aold[m - j];
    v = v * (1 - k * k);
    vars[m - 1] = v;
    const row = new Array(m);
    for (let j = 1; j <= m; j++) row[j - 1] = a[j];
    coefs.push(row);
  }
  return { coefs, vars };
}

// Fit AR by Yule-Walker with AIC order selection on a gap-free numeric array.
// Returns { order, ar:number[], mean, resid:number[] } where resid[t] is the
// (demeaned) prediction residual with the mean added back; resid[t]=NaN for
// t < order (matches R's leading NAs, and NA + mean == NA).
function arAIC(x) {
  const n = x.length;
  const xm = mean(x);
  const xc = new Float64Array(n);
  for (let i = 0; i < n; i++) xc[i] = x[i] - xm;
  const orderMax = Math.min(n - 1, Math.floor(10 * Math.log10(n)));
  if (orderMax < 1) {
    // degenerate: no fit, residual == series
    const resid = new Array(n);
    for (let i = 0; i < n; i++) resid[i] = xc[i] + xm;
    return { order: 0, ar: [], mean: xm, resid };
  }
  const r = acov(xc, orderMax);
  const varpred = new Float64Array(orderMax + 1);
  varpred[0] = r[0];
  const { coefs, vars } = levinson(r, orderMax);
  for (let m = 1; m <= orderMax; m++) varpred[m] = vars[m - 1];
  // AIC: n*log(var.pred[k]) + 2*k + 2*demean (demean=1). Pick argmin (first).
  let order = 0, best = Infinity;
  for (let k = 0; k <= orderMax; k++) {
    const aic = n * Math.log(varpred[k]) + 2 * k + 2;
    if (aic < best) { best = aic; order = k; }
  }
  const ar = order > 0 ? coefs[order - 1] : [];
  const resid = new Array(n);
  for (let t = 0; t < n; t++) {
    if (t < order) { resid[t] = NaN; continue; }
    let e = xc[t];
    for (let j = 1; j <= order; j++) e -= ar[j - 1] * xc[t - j];
    resid[t] = e + xm;
  }
  return { order, ar, mean: xm, resid };
}

// dplR:::ar.func over a column that may contain NaN/null (missing years):
// operate on the contiguous vector of present values, place residuals back at
// their original positions, leaving all missing / leading-order slots NaN.
function whitenColumnAR(col) {
  const idx = [];
  for (let i = 0; i < col.length; i++) {
    const v = col[i];
    if (v != null && !Number.isNaN(v)) idx.push(i);
  }
  const out = new Array(col.length).fill(NaN);
  if (idx.length < 1) return out;
  const x = idx.map(i => Number(col[i]));
  const { resid } = arAIC(x);
  for (let t = 0; t < idx.length; t++) out[idx[t]] = resid[t];
  return out;
}

module.exports = { arAIC, whitenColumnAR, levinson, acov };
