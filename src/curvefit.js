'use strict';
// Modified Negative Exponential and Hugershoff detrending curves — ports of the
// nls fits inside dplR::detrend.series, with the same start values and the same
// linear -> mean fallback chain (constrain.nls = "never", pos.slope = FALSE).
const { gaussNewton } = require('./nls.js');

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;

// Ordinary least squares line y = intercept + slope*x  (x = 1..n)
function linearFit(y) {
  const n = y.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const x = i + 1; sx += x; sy += y[i]; sxx += x * x; sxy += x * y[i]; }
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  return { intercept, slope };
}

// dplR fallback: try line (if slope<=0 or pos.slope and all-positive), else mean.
function fallbackCurve(y, posSlope = false) {
  const n = y.length;
  const { intercept, slope } = linearFit(y);
  if (isFinite(intercept) && isFinite(slope) && (slope <= 0 || posSlope)) {
    const line = new Array(n);
    for (let i = 0; i < n; i++) line[i] = intercept + slope * (i + 1);
    if (line[0] > 0 && line[n - 1] > 0) return line;
  }
  const m = mean(y);
  return new Array(n).fill(m);
}

// ---- Modified Negative Exponential: y = a*exp(b*t) + k ----
function modNegExp(y, posSlope = false) {
  const nY = y.length;
  const a0 = mean(y.slice(0, Math.max(1, Math.floor(nY * 0.1))));
  const k0 = mean(y.slice(Math.floor(nY * 0.9) - 1));   // R: floor(0.9n):nY (1-based)
  const start = [a0, -0.01, k0];
  const model = (p, i) => p[0] * Math.exp(p[1] * (i + 1)) + p[2];
  const grad = (p, i) => {
    const t = i + 1, e = Math.exp(p[1] * t);
    return [e, p[0] * t * e, 1];
  };
  const fit = gaussNewton(y, model, grad, start);
  // dplR rejects a<=0 or b>=0, or a non-positive final fit -> fall back
  if (fit) {
    const [a, b] = fit.params;
    const ok = a > 0 && b < 0 && fit.fitted[nY - 1] > 0 && fit.fitted.every(v => isFinite(v));
    if (ok) return { curve: fit.fitted, method: 'NegativeExponential', params: fit.params };
  }
  return { curve: fallbackCurve(y, posSlope), method: 'fallback' };
}

// ---- Modified Hugershoff: y = a*t^b*exp(-g*t) + d ----
function modHugershoff(y, posSlope = false) {
  const nY = y.length;
  const tail = mean(y.slice(Math.floor(nY * 0.9) - 1));
  const start = [tail, 1, 0.1, tail];
  const model = (p, i) => { const t = i + 1; return p[0] * Math.pow(t, p[1]) * Math.exp(-p[2] * t) + p[3]; };
  const grad = (p, i) => {
    const t = i + 1, tb = Math.pow(t, p[1]), eg = Math.exp(-p[2] * t);
    return [tb * eg, p[0] * tb * Math.log(t) * eg, -p[0] * tb * t * eg, 1];
  };
  const fit = gaussNewton(y, model, grad, start);
  if (fit) {
    const [a, b] = fit.params;
    const ok = a > 0 && b > 0 && fit.fitted[nY - 1] > 0 && fit.fitted.every(v => isFinite(v));
    if (ok) return { curve: fit.fitted, method: 'Hugershoff', params: fit.params };
  }
  return { curve: fallbackCurve(y, posSlope), method: 'fallback' };
}

module.exports = { modNegExp, modHugershoff, linearFit, fallbackCurve };
