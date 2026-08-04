'use strict';
// AR(1) prewhitening, port of ringdater::whitenSeries (COFECHA-style).
// Mirrors: seriesScaled <- scale(series); ar(..., order.max=1, aic=FALSE,
// method="yule-walker", demean=TRUE); out <- c(seriesScaled[1], resid[-1]).
// Assumes NAs already stripped (as ringdater's normalise does before calling).

// z-score with sample sd (n-1 divisor), matching R's scale()
function scale(x) {
  const n = x.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i];
  m /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - m; ss += d * d; }
  const sd = Math.sqrt(ss / (n - 1));
  return x.map(v => (v - m) / sd);
}

// AR(1) Yule-Walker coefficient: biased (divisor n) lag-1 autocorrelation of
// the demeaned series, exactly as stats::ar.yw computes it for order 1.
function arYW1(x) {
  const n = x.length;
  let xbar = 0;
  for (let i = 0; i < n; i++) xbar += x[i];
  xbar /= n;
  let c0 = 0, c1 = 0;
  for (let i = 0; i < n; i++) { const d = x[i] - xbar; c0 += d * d; }
  for (let i = 0; i < n - 1; i++) c1 += (x[i] - xbar) * (x[i + 1] - xbar);
  c0 /= n; c1 /= n;
  return { phi: c1 / c0, xbar };
}

function whitenSeries(series) {
  const y = Float64Array.from(series, Number);
  const s = scale(y);
  const { phi, xbar } = arYW1(s);
  // residuals e[t] = (s[t]-xbar) - phi*(s[t-1]-xbar), t = 1..n-1 (0-based)
  const out = new Array(y.length);
  out[0] = s[0];                                   // seriesScaled[1] kept as-is
  for (let t = 1; t < s.length; t++) out[t] = (s[t] - xbar) - phi * (s[t - 1] - xbar);
  return out;
}

module.exports = { whitenSeries, scale, arYW1 };
