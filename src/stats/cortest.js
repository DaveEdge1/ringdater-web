'use strict';
// Pearson correlation test — port of R's cor.test(x, y) (default: pearson,
// two-sided). Returns { r, t, df, p } matching R's estimate / statistic /
// parameter / p.value. Used by the lead-lag crossdating engine. The Student-t
// CDF is the regularized incomplete beta, same math already validated in
// corr_rwl_seg.js (kept standalone here so the analysis layer has no coupling).

function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function betacf(a, b, x) {
  const FPMIN = 1e-300, EPS = 3e-16, MAXIT = 400;
  let qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// Regularized incomplete beta I_x(a,b)
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
  return 1 - bt * betacf(b, a, 1 - x) / b;
}

// Two-sided upper-tail Student-t p-value: P(|T_df| >= |t|)
function pt2sided(t, df) {
  if (df <= 0) return NaN;
  const x = df / (df + t * t);
  return betai(df / 2, 0.5, x); // = 2*pt(-|t|, df)
}

// Pearson cor.test on paired samples (must be equal length, no NA — caller
// supplies the complete-cases overlap). Returns null-ish stats if degenerate.
function pearsonCorTest(x, y) {
  const n = x.length;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const denom = Math.sqrt(sxx * syy);
  const r = denom === 0 ? NaN : sxy / denom;
  const df = n - 2;
  const t = r * Math.sqrt(df / (1 - r * r));
  const p = Number.isFinite(t) ? pt2sided(t, df) : NaN;
  return { r, t, df, p };
}

module.exports = { pearsonCorTest, pt2sided, betai };
