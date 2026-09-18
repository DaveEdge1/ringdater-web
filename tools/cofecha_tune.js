'use strict';
// Experiment harness: try variants of the COFECHA transform chain and score each
// against the real COFECHA master series parsed out of UT550COF.OUT.
//
//   node tools/cofecha_tune.js
//
// Scored on three things, in order of how much they constrain the chain:
//   sample depth  — exact match proves no data is being lost or invented
//   master r      — the whole chain (spline -> AR -> log -> mean) in one number
//   AR order      — agreement with the order COFECHA selected per series
const fs = require('fs');
const path = require('path');
const { detrendSpline } = require('../src/spline.js');
const { levinson, acov } = require('../src/ar.js');
const RD = require('../src/index.js');

const ROOT = path.join(__dirname, '..');
const M = JSON.parse(fs.readFileSync(path.join(ROOT, 'cofecha_run', 'ut550_master.json'), 'utf8'));
const P7 = JSON.parse(fs.readFileSync(path.join(ROOT, 'cofecha_run', 'ut550_part7.json'), 'utf8'));
const frame = RD.readRWL(fs.readFileSync(path.join(ROOT, 'chronologies', 'ut550.rwl'), 'utf8'),
  { fileName: 'ut550.rwl' });

const isNA = v => v == null || (typeof v === 'number' && Number.isNaN(v));
const mean = a => { let s = 0, n = 0; for (const v of a) if (!isNA(v)) { s += v; n++; } return n ? s / n : NaN; };
const sd = a => { const m = mean(a); let s = 0, n = 0; for (const v of a) if (!isNA(v)) { s += (v - m) * (v - m); n++; } return n > 1 ? Math.sqrt(s / (n - 1)) : NaN; };
function pearson(a, b) {
  const n = a.length; let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(saa * sbb);
}

// AR fit with a selectable criterion / cap / floor, returning residuals with the
// mean added back and a choice about what to do with the first `order` values.
function arFit(x, opt) {
  const n = x.length, xm = mean(x);
  const xc = x.map(v => v - xm);
  const cap = Math.min(n - 1, opt.cap);
  if (cap < 1) return { order: 0, resid: x.slice() };
  const r = acov(Float64Array.from(xc), cap);
  const { coefs, vars } = levinson(r, cap);
  const vp = [r[0]].concat(Array.from(vars));
  let best = Infinity, order = 0;
  for (let k = opt.floor; k <= cap; k++) {
    const pen = opt.crit === 'aic' ? 2 * k : k * Math.log(n);
    const v = n * Math.log(vp[k]) + pen;
    if (v < best) { best = v; order = k; }
  }
  const ar = order > 0 ? coefs[order - 1] : [];
  const resid = new Array(n);
  for (let t = 0; t < n; t++) {
    if (t < order) { resid[t] = opt.keepLeading ? x[t] : NaN; continue; }
    let e = xc[t];
    for (let j = 1; j <= order; j++) e -= ar[j - 1] * xc[t - j];
    resid[t] = e + xm;
  }
  return { order, resid };
}

// contiguous runs of present values in a column (COFECHA reads each record of
// the .rwl as its own series, and two records under one id show up here as two
// runs separated by a gap)
function runs(col, split) {
  const out = [];
  let cur = null;
  for (let i = 0; i < col.length; i++) {
    if (isNA(col[i])) { if (cur) { out.push(cur); cur = null; } continue; }
    if (!cur) cur = { lo: i, hi: i }; else cur.hi = i;
  }
  if (cur) out.push(cur);
  if (split) return out;
  return out.length ? [{ lo: out[0].lo, hi: out[out.length - 1].hi }] : [];
}

function build(opt) {
  const nrow = frame.cols[0].length;
  const sum = new Float64Array(nrow), cnt = new Float64Array(nrow);
  const depth = new Float64Array(nrow);   // every present measurement, absent included
  const orders = [];
  for (let c = 1; c < frame.cols.length; c++) {
    const col = frame.cols[c].map(v => (isNA(v) ? NaN : Number(v)));
    for (const rg of runs(col, opt.splitRuns)) {
      const at = [];
      for (let i = rg.lo; i <= rg.hi; i++) if (!isNA(col[i])) at.push(i);
      if (at.length < 20) continue;
      let v = at.map(i => col[i]);
      const zero = v.map(x => x === 0);
      v = Array.from(detrendSpline(v, 32, 0.5).detrended);
      const doLog = (vv) => {
        if (opt.noLog) return vv;
        const cst = mean(vv) / opt.logDiv;
        return vv.map(x => (isNA(x) ? NaN : (x + cst > 0 ? Math.log(x + cst) : NaN)));
      };
      if (opt.logFirst) v = doLog(v);
      const fit = arFit(v, opt);
      orders.push({ id: frame.names[c], order: fit.order });
      v = fit.resid;
      if (!opt.logFirst) v = doLog(v);
      if (opt.zPerSeries) {
        const mu = mean(v), sg = sd(v);
        if (sg > 0) v = v.map(x => (isNA(x) ? NaN : (x - mu) / sg));
      }
      for (let k = 0; k < at.length; k++) {
        depth[at[k]]++;                              // Part 3 "No" counts these
        if (isNA(v[k])) continue;
        if (opt.omitAbsent !== false && zero[k]) continue;   // Option 9
        sum[at[k]] += v[k]; cnt[at[k]]++;
      }
    }
  }
  const idx = new Array(nrow);
  for (let i = 0; i < nrow; i++) idx[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
  const mm = mean(idx), ms = sd(idx);
  return { z: idx.map(v => (isNA(v) ? NaN : (v - mm) / ms)), depth: Array.from(depth), orders };
}

function score(opt) {
  const b = build(opt);
  const years = frame.cols[0].map(Number);
  const A = [], B = [];
  let nD = 0, okD = 0;
  for (let i = 0; i < years.length; i++) {
    const c = M[String(years[i])];
    if (!c) continue;
    nD++; if (c.n === b.depth[i]) okD++;
    if (Number.isFinite(b.z[i])) { A.push(c.v); B.push(b.z[i]); }
  }
  // AR order agreement (only for ids COFECHA reports exactly once)
  const cofBy = {};
  P7.forEach(r => { (cofBy[r.id] = cofBy[r.id] || []).push(r); });
  let nO = 0, okO = 0;
  for (const o of b.orders) {
    const c = cofBy[o.id];
    if (!c || c.length !== 1) continue;
    nO++; if (c[0].ar === o.order) okO++;
  }
  const d = A.map((v, i) => Math.abs(v - B[i])).sort((x, y) => x - y);
  return {
    r: pearson(A, B), n: A.length,
    depth: 100 * okD / nD, med: d[d.length >> 1],
    within10: 100 * d.filter(x => x < 0.1).length / d.length,
    arExact: nO ? 100 * okO / nO : 0,
  };
}

const DEF = { logDiv: 6 };
const VARIANTS = [
  { name: 'spline+log, mean of raw values', crit:'bic',cap:0,floor:0,keepLeading:true,splitRuns:true },
  { name: 'spline+log, z per series', crit:'bic',cap:0,floor:0,keepLeading:true,splitRuns:true, zPerSeries:true },
  { name: 'spline+AR(bic3)+log, z per series', crit:'bic',cap:3,floor:1,keepLeading:true,splitRuns:true, zPerSeries:true },
  { name: 'spline+AR(bic9)+log, z per series', crit:'bic',cap:9,floor:1,keepLeading:true,splitRuns:true, zPerSeries:true },
  { name: 'spline+AR(aic9)+log, z per series', crit:'aic',cap:9,floor:1,keepLeading:true,splitRuns:true, zPerSeries:true },
  { name: 'spline+AR(aic,uncapped)+log, z per series', crit:'aic',cap:1e9,floor:1,keepLeading:true,splitRuns:true, zPerSeries:true },
  { name: 'spline+AR(1)+log, z per series', crit:'bic',cap:1,floor:1,keepLeading:true,splitRuns:true, zPerSeries:true },
  { name: 'spline+AR(bic3), z per series, NO log', crit:'bic',cap:3,floor:1,keepLeading:true,splitRuns:true, zPerSeries:true, noLog:true },
];

console.log('variant'.padEnd(46) + 'masterR   depth%   med|d|  <0.1%   AR%');
for (const v of VARIANTS) {
  const s = score(Object.assign({}, DEF, v));
  console.log(v.name.padEnd(46) +
    s.r.toFixed(4).padStart(7) + '  ' +
    s.depth.toFixed(1).padStart(6) + '  ' +
    s.med.toFixed(3).padStart(7) + '  ' +
    s.within10.toFixed(1).padStart(5) + '  ' +
    s.arExact.toFixed(0).padStart(4));
}
