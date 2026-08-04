'use strict';
// Port of dplR::corr.rwl.seg — segment correlation flags for crossdating checks,
// in the exact regime ringdater::prob_check uses it:
//   method="spearman", prewhiten=TRUE, biweight=TRUE, bin.floor=10, pcrit=0.05,
//   floor.plus1=FALSE, master=NULL, n=NULL.
//
// Each series is normalized (divided by its mean), AR-prewhitened (full ar()
// with AIC order selection, see ar.js), and compared against a "master" that is
// the Tukey biweight robust mean (tbrm, C=9) of all OTHER prewhitened series.
// For each 50%-overlapping segment the Spearman rank correlation of the series
// vs the master is computed with a one-sided ("greater") p-value exactly as
// stats::cor.test does (exact AS 89 distribution when untied, t-approx on ties).
// A segment is flagged when its p-value >= pcrit (correlation not significant,
// i.e. below the critical value, or negative).
//
// Input `rwl`:
//   { years:  number[]  // strictly ascending, step 1 (contiguous)
//     series: { [id:string]: (number|null)[] }  // aligned to years; null/NaN = NA
//   }
// Options: { segLength=20, binFloor=10, pcrit=0.05, floorPlus1=false }
//
// Returns:
//   { flags:   { [id]: "b1.b2, b3.b4" }   // only series with >=1 flagged segment
//     segRho:  { [id]: (number|null)[] }  // per-segment Spearman rho  (== $spearman.rho)
//     pval:    { [id]: (number|null)[] }  // per-segment one-sided p   (== $p.val)
//     overall: { [id]: [rho, pval] }      // whole-series rho / p      (== $overall)
//     avgSegRho: (number|null)[]          // colMeans(segRho, na.rm)   (== $avg.seg.rho)
//     bins: [start,end][], binNames: string[], segLength, segLag, pcrit }
//
// Dependency-free; validated element-by-element against R (tools/corr_ground_truth.R).

const { whitenColumnAR } = require('./ar.js');

// ---------------------------------------------------------------- math kernels
// erf/erfc: Taylor series for |x|<2, Lentz continued fraction for erfc otherwise.
// Accurate to ~1e-15, enough to match R's pnorm through the AS 89 approximation.
function erfcCF(x) { // x > 0, returns erfc(x)
  const tiny = 1e-300;
  let f = x; if (f === 0) f = tiny;
  let C = f, D = 0;
  for (let i = 1; i < 300; i++) {
    const a = i / 2;
    D = x + a * D; if (D === 0) D = tiny; D = 1 / D;
    C = x + a / C; if (C === 0) C = tiny;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-x * x) / Math.sqrt(Math.PI) / f;
}
function erf(x) {
  if (x === 0) return 0;
  const ax = Math.abs(x);
  let r;
  if (ax < 2) {
    let term = ax, sum = ax;
    for (let n = 1; n < 300; n++) {
      term *= -ax * ax * (2 * n - 1) / (n * (2 * n + 1));
      sum += term;
      if (Math.abs(term) <= Math.abs(sum) * 1e-18) break;
    }
    r = 2 / Math.sqrt(Math.PI) * sum;
  } else {
    r = 1 - erfcCF(ax);
  }
  return x < 0 ? -r : r;
}
function erfc(x) {
  const ax = Math.abs(x);
  if (ax < 2) { const e = erf(ax); return x < 0 ? 1 + e : 1 - e; }
  const c = erfcCF(ax);
  return x < 0 ? 2 - c : c;
}
function pnormLower(z) { return 0.5 * erfc(-z / Math.SQRT2); }
// pnorm(x,0,1, lower_tail)
function pnormT(x, lower) { return lower ? pnormLower(x) : pnormLower(-x); }

// regularized incomplete beta (Numerical Recipes) — only for the tie/large-n
// t-approx fallback of the Spearman p-value.
function betacf(a, b, x) {
  const FPMIN = 1e-300, qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d;
  let h = d;
  for (let m = 1; m < 300; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}
function gammaln(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let xx = x, y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y += 1; ser += g[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / xx);
}
function betai(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) +
    a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
  return 1 - bt * betacf(b, a, 1 - x) / b;
}
// P(T > t) for Student-t with df.
function ptUpper(t, df) {
  const ib = 0.5 * betai(df / 2, 0.5, df / (df + t * t)); // P(T > |t|)
  return t > 0 ? ib : 1 - ib;
}

// stats prho / C_pRho — Algorithm AS 89 (Best & Roberts 1975), verbatim port.
// is: integer S statistic argument; returns lower/upper tail probability.
function prho(n, is, lowerTail) {
  let pv = lowerTail ? 0 : 1;
  if (n <= 1) return pv;
  if (is <= 0) return pv;
  const n3 = n * (n * n - 1) / 3;
  if (is > n3) return 1 - pv;
  if (n <= 9) {
    let nfac = 1; const l = [];
    for (let i = 1; i <= n; i++) { nfac *= i; l[i - 1] = i; }
    let ifr;
    if (is === n3) { ifr = 1; }
    else {
      ifr = 0;
      for (let m = 0; m < nfac; m++) {
        let ise = 0;
        for (let i = 0; i < n; i++) { const d = i + 1 - l[i]; ise += d * d; }
        if (is <= ise) ifr++;
        let n1 = n, mt;
        do {
          mt = l[0];
          for (let i = 1; i < n1; i++) l[i - 1] = l[i];
          n1--; l[n1] = mt;
        } while (mt === n1 + 1 && n1 > 1);
      }
    }
    return (lowerTail ? nfac - ifr : ifr) / nfac;
  }
  const c1 = .2274, c2 = .2531, c3 = .1745, c4 = .0758, c5 = .1033, c6 = .3932,
    c7 = .0879, c8 = .0151, c9 = .0072, c10 = .0831, c11 = .0131, c12 = 4.6e-4;
  let y = n; const b = 1 / y;
  let x = (6 * (is - 1) * b / (y * y - 1) - 1) * Math.sqrt(y - 1);
  y = x * x;
  const u = x * b * (c1 + b * (c2 + c3 * b) +
    y * (-c4 + b * (c5 + c6 * b) -
      y * b * (c7 + c8 * b - y * (c9 - c10 * b + y * b * (c11 - c12 * y)))));
  y = u / Math.exp(y / 2);
  pv = (lowerTail ? -y : y) + pnormT(x, lowerTail);
  if (pv < 0) pv = 0; if (pv > 1) pv = 1;
  return pv;
}

// average ranks (R's rank(), ties.method="average")
function rankAvg(x) {
  const n = x.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a] - x[b]);
  const r = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && x[idx[j + 1]] === x[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k]] = avg;
    i = j + 1;
  }
  return r;
}
function pearson(a, b) {
  const n = a.length; let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}
function uniqCount(x) { return new Set(x).size; }

// cor.test(x, y, method="spearman", alternative="greater"). x,y complete (no NaN).
function spearmanGreater(x, y) {
  const n = x.length;
  if (n < 2) return { rho: NaN, p: NaN };
  const rho = pearson(rankAvg(x), rankAvg(y));
  if (!Number.isFinite(rho)) return { rho: NaN, p: NaN };
  const ties = uniqCount(x) < n || uniqCount(y) < n;
  const q = (n * n * n - n) * (1 - rho) / 6;
  const exact = !ties && n <= 1290;
  let p;
  if (exact) {
    p = prho(n, Math.round(q) + 2, true); // lower.tail=TRUE
  } else {
    const den = (n * (n * n - 1)) / 6;
    const r2 = 1 - q / den;
    const tval = r2 / Math.sqrt((1 - r2 * r2) / (n - 2));
    p = ptUpper(tval, n - 2); // pt(..., lower.tail=FALSE)
  }
  return { rho, p };
}

// ------------------------------------------------------------------ tbrm (C=9)
function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const n = s.length, h = n >> 1;
  return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}
// dplR::tbrm — NAs removed, cutoff = C*MAD + 1e-6, weights (1-u^2)^2 for |u|<=1.
function tbrm(vals, C = 9) {
  const x = [];
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v != null && !Number.isNaN(v)) x.push(v);
  }
  const n = x.length;
  if (n === 0) return NaN;
  if (n === 1) return x[0];
  const med = median(x);
  const dev = x.map(v => Math.abs(v - med));
  const madv = median(dev);
  const div = C * madv + 1e-6;
  let wx = 0, w = 0;
  for (let i = 0; i < n; i++) {
    const u = (x[i] - med) / div;
    if (u >= -1 && u <= 1) {
      let ww = 1 - u * u; ww *= ww;
      wx += ww * x[i]; w += ww;
    }
  }
  return wx / w;
}

// ------------------------------------------------------------------- normalize1
// divide each series by its mean (na.rm), flag idx.good (>3 present values),
// then AR-prewhiten each column. Returns { rwi:number[][] (col-major), idxGood }.
function normalize1(cols) {
  const nser = cols.length;
  const rwi = new Array(nser);
  const idxGood = new Array(nser);
  for (let j = 0; j < nser; j++) {
    const col = cols[j];
    let s = 0, cnt = 0;
    for (let i = 0; i < col.length; i++) {
      const v = col[i];
      if (v != null && !Number.isNaN(v)) { s += v; cnt++; }
    }
    const m = s / cnt;
    const divided = col.map(v => (v == null || Number.isNaN(v)) ? NaN : v / m);
    idxGood[j] = cnt > 3;
    rwi[j] = whitenColumnAR(divided);
  }
  return { rwi, idxGood };
}

function isNA(v) { return v == null || Number.isNaN(v); }

function corrRwlSeg(rwl, opts = {}) {
  const segLength = opts.segLength != null ? opts.segLength : 20;
  const binFloor = opts.binFloor != null ? opts.binFloor : 10;
  const pcrit = opts.pcrit != null ? opts.pcrit : 0.05;
  const floorPlus1 = !!opts.floorPlus1;

  const years = rwl.years.map(Number);
  const cnames = Object.keys(rwl.series);
  const nser = cnames.length;
  const cols = cnames.map(id => rwl.series[id]);

  const minYr = years[0], maxYr = years[years.length - 1];
  const segLag = segLength / 2;

  // bin layout
  let minBin;
  if (!binFloor) minBin = minYr;
  else if (floorPlus1) minBin = Math.ceil((minYr - 1) / binFloor) * binFloor + 1;
  else minBin = Math.ceil(minYr / binFloor) * binFloor;
  const maxBin = maxYr - segLength + 1;
  if (maxBin < minBin) throw new Error("shorten 'segLength' or adjust 'binFloor'");
  const bins = [];
  for (let b = minBin; b <= maxBin; b += segLag) bins.push([b, b + (segLength - 1)]);
  const nbins = bins.length;
  const binNames = bins.map(b => b[0] + '.' + b[1]);
  // year index lookup
  const yrIndex = new Map();
  for (let i = 0; i < years.length; i++) yrIndex.set(years[i], i);

  const { rwi, idxGood } = normalize1(cols);

  const segRho = cnames.map(() => new Array(nbins).fill(null));
  const pval = cnames.map(() => new Array(nbins).fill(null));
  const overall = {};

  for (let i = 0; i < nser; i++) {
    // master2 = row-wise tbrm of all OTHER good series
    const master2 = new Array(years.length);
    for (let t = 0; t < years.length; t++) {
      const row = [];
      for (let j = 0; j < nser; j++) {
        if (j === i || !idxGood[j]) continue;
        row.push(rwi[j][t]);
      }
      master2[t] = tbrm(row, 9);
    }
    const series = rwi[i];

    for (let j = 0; j < nbins; j++) {
      const [b1, b2] = bins[j];
      const xs = [], ys = [];
      let ok = true, any = false;
      for (let yr = b1; yr <= b2; yr++) {
        const t = yrIndex.get(yr);
        if (t === undefined) continue;
        any = true;
        if (isNA(series[t]) || isNA(master2[t])) { ok = false; break; }
        xs.push(series[t]); ys.push(master2[t]);
      }
      if (!any || !ok) continue;
      const { rho, p } = spearmanGreater(xs, ys);
      segRho[i][j] = rho; pval[i][j] = p;
    }

    // overall: complete cases of (series, master2)
    const xs = [], ys = [];
    for (let t = 0; t < years.length; t++) {
      if (isNA(series[t]) || isNA(master2[t])) continue;
      xs.push(series[t]); ys.push(master2[t]);
    }
    const o = spearmanGreater(xs, ys);
    overall[cnames[i]] = [o.rho, o.p];
  }

  // avg.seg.rho = colMeans(segRho, na.rm=TRUE)
  const avgSegRho = new Array(nbins).fill(null);
  for (let j = 0; j < nbins; j++) {
    let s = 0, c = 0;
    for (let i = 0; i < nser; i++) {
      const v = segRho[i][j];
      if (v != null && !Number.isNaN(v)) { s += v; c++; }
    }
    avgSegRho[j] = c > 0 ? s / c : NaN;
  }

  // flags: segments where p.val >= pcrit
  const flags = {};
  for (let i = 0; i < nser; i++) {
    const flagged = [];
    for (let j = 0; j < nbins; j++) {
      const p = pval[i][j];
      if (p != null && !Number.isNaN(p) && p >= pcrit) flagged.push(binNames[j]);
    }
    if (flagged.length) flags[cnames[i]] = flagged.join(', ');
  }

  const segRhoObj = {}, pvalObj = {};
  for (let i = 0; i < nser; i++) { segRhoObj[cnames[i]] = segRho[i]; pvalObj[cnames[i]] = pval[i]; }

  return {
    flags, segRho: segRhoObj, pval: pvalObj, overall, avgSegRho,
    bins, binNames, segLength, segLag, pcrit,
  };
}

module.exports = { corrRwlSeg, tbrm, spearmanGreater, prho, pnormLower, normalize1 };
