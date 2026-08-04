'use strict';
// Friedman's variable-span super smoother — port of R's stats supsmu/smooth
// Fortran (ppr.f), for the regime dplR/ringdater uses: x = 1..n, unit weights,
// span = "cv" (0 -> cross-validated), bass = 0, non-periodic. Returns the
// smoothed curve. 1-based indexing throughout to mirror the Fortran.

const SPANS = [0, 0.05, 0.2, 0.5];        // tweeter / midrange / woofer (1-based)
const BIG = 1e20, EPS = 1e-3;

// One fixed-span local-linear smoother pass. x,y,w are 1-based (index 1..n).
// iper>0 also fills acvr with cross-validated |residual|s. Mirrors subroutine smooth.
function smoothPass(x, y, w, n, span, iper, vsmlsq) {
  let xm = 0, ym = 0, vv = 0, cvar = 0, fbw = 0;
  const jper = Math.abs(iper);
  let ibw = Math.trunc(0.5 * span * n + 0.5);
  if (ibw < 2) ibw = 2;
  let it = 2 * ibw + 1;
  if (it > n) it = n;

  for (let i = 1; i <= it; i++) {          // initial window fill
    const j = i;                            // jper==1: j=i (periodic path unused here)
    const xti = x[j];
    const wt = w[j];
    const fbo = fbw; fbw += wt;
    if (fbw > 0) { xm = (fbo * xm + wt * xti) / fbw; ym = (fbo * ym + wt * y[j]) / fbw; }
    let tmp = 0; if (fbo > 0) tmp = fbw * wt * (xti - xm) / fbo;
    vv += tmp * (xti - xm);
    cvar += tmp * (y[j] - ym);
  }

  const smo = new Float64Array(n + 1);
  const acvr = new Float64Array(n + 1);
  for (let j = 1; j <= n; j++) {
    let out = j - ibw - 1, inn = j + ibw;
    const boundary = (jper !== 2) && (out < 1 || inn > n);
    if (!boundary) {                        // slide window: drop `out`, add `inn`
      const xto = x[out], xti = x[inn];
      let wt = w[out];
      let fbo = fbw; fbw -= wt;
      let tmp = 0; if (fbw > 0) tmp = fbo * wt * (xto - xm) / fbw;
      vv -= tmp * (xto - xm);
      cvar -= tmp * (y[out] - ym);
      if (fbw > 0) { xm = (fbo * xm - wt * xto) / fbw; ym = (fbo * ym - wt * y[out]) / fbw; }
      wt = w[inn];
      fbo = fbw; fbw += wt;
      if (fbw > 0) { xm = (fbo * xm + wt * xti) / fbw; ym = (fbo * ym + wt * y[inn]) / fbw; }
      tmp = 0; if (fbo > 0) tmp = fbw * wt * (xti - xm) / fbo;
      vv += tmp * (xti - xm);
      cvar += tmp * (y[inn] - ym);
    }
    let a = 0; if (vv > vsmlsq) a = cvar / vv;
    smo[j] = a * (x[j] - xm) + ym;
    if (iper > 0) {
      let h = 0; if (fbw > 0) h = 1 / fbw;
      if (vv > vsmlsq) h += (x[j] - xm) * (x[j] - xm) / vv;
      a = 1 - w[j] * h;
      if (a > 0) acvr[j] = Math.abs(y[j] - smo[j]) / a;
      else if (j > 1) acvr[j] = acvr[j - 1];
      else acvr[j] = 0;
    }
  }
  return { smo, acvr };
}

// Cross-validated super smoother for y (0-based array in, 0-based array out).
function supsmu(yIn) {
  const n = yIn.length;
  const x = new Float64Array(n + 1), y = new Float64Array(n + 1), w = new Float64Array(n + 1);
  for (let i = 1; i <= n; i++) { x[i] = i; y[i] = yIn[i - 1]; w[i] = 1; }

  // vsmlsq from the interquartile-ish spread of x
  let i = Math.trunc(n / 4), j = 3 * i;
  let scale = x[j] - x[i];
  while (!(scale > 0)) { if (j < n) j++; if (i > 1) i--; scale = x[j] - x[i]; }
  const vsmlsq = (EPS * scale) * (EPS * scale);
  const jper = 1;

  // sc[col][row], columns 1..7, rows 1..n
  const sc = Array.from({ length: 8 }, () => new Float64Array(n + 1));
  for (let s = 1; s <= 3; s++) {
    const r1 = smoothPass(x, y, w, n, SPANS[s], jper, vsmlsq);      // smo -> col 2s-1, cv resid -> col7
    for (let k = 1; k <= n; k++) { sc[2 * s - 1][k] = r1.smo[k]; sc[7][k] = r1.acvr[k]; }
    const r2 = smoothPass(x, sc[7], w, n, SPANS[2], -jper, vsmlsq); // smooth cv resid w/ mid span -> col 2s
    for (let k = 1; k <= n; k++) sc[2 * s][k] = r2.smo[k];
  }
  // per point: span minimizing smoothed cv residual (bass alpha=0 -> no tone control)
  for (let k = 1; k <= n; k++) {
    let resmin = BIG;
    for (let s = 1; s <= 3; s++) if (sc[2 * s][k] < resmin) { resmin = sc[2 * s][k]; sc[7][k] = SPANS[s]; }
  }
  const rb = smoothPass(x, sc[7], w, n, SPANS[2], -jper, vsmlsq);   // smooth chosen spans
  for (let k = 1; k <= n; k++) sc[2][k] = rb.smo[k];
  // interpolate the three span-smooths at each point's chosen span
  for (let k = 1; k <= n; k++) {
    if (sc[2][k] <= SPANS[1]) sc[2][k] = SPANS[1];
    if (sc[2][k] >= SPANS[3]) sc[2][k] = SPANS[3];
    let f = sc[2][k] - SPANS[2];
    if (f < 0) { f = -f / (SPANS[2] - SPANS[1]); sc[4][k] = (1 - f) * sc[3][k] + f * sc[1][k]; }
    else { f = f / (SPANS[3] - SPANS[2]); sc[4][k] = (1 - f) * sc[3][k] + f * sc[5][k]; }
  }
  const rf = smoothPass(x, sc[4], w, n, SPANS[1], -jper, vsmlsq);   // final light smooth
  const out = new Array(n);
  for (let k = 1; k <= n; k++) out[k - 1] = rf.smo[k];
  return out;
}

// dplR detrend.series(method="Friedman"): zeros in the series are replaced by
// 0.001 (same preprocessing as the Spline path), the curve is supsmu of that,
// and if any curve value <= 0 dplR falls back to the series mean.
function friedman(yIn) {
  const y = yIn.map(v => (v === 0 ? 0.001 : v));
  const curve = supsmu(y);
  if (curve.some(v => v <= 0)) {
    const m = y.reduce((s, v) => s + v, 0) / y.length;
    return { curve: new Array(y.length).fill(m), method: 'Mean' };
  }
  return { curve, method: 'Friedman' };
}

module.exports = { supsmu, friedman };
