'use strict';
// ============================================================================
// cofecha.js — a faithful re-implementation of the crossdating quality checks
// performed by COFECHA (Holmes 1983), following the program description in
//   Grissino-Mayer, H.D. (2001) "Evaluating crossdating accuracy: a manual and
//   tutorial for the computer program COFECHA", Tree-Ring Research 57(2):205-221
// (the copy in ringdater-web/GrissinoCOFECHA.pdf). Page references below are to
// that paper.
//
// WHAT COFECHA DOES (p. 210, "WHAT COFECHA DOES"):
//   1. Each measurement series is transformed: spline fit (Option 1), then
//      autoregressive modelling (Option 3), then log transform (Option 4), then
//      first differencing (Option F) if selected.
//   2. Transformed values accumulate into a sum series and a counter series
//      (number of series present per year); master = sum / counter, i.e. the
//      ARITHMETIC mean of all transformed dated series.
//   3. Each series is tested against the master with ITS OWN contribution
//      removed ("to avoid comparing the tested series against itself").
//   4. For each segment a correlation is computed, checked to be positive and
//      significant at the chosen confidence level, and compared against the
//      correlations obtained by shifting the segment -10..+10 years.
//
// FLAGS. The program prints its own legend above the Part 5 matrix, and it is
// the authoritative statement of the rule:
//   "A = correlation under <crit> but highest as dated;
//    B = correlation higher at other than dated position"
// So 'B' depends ONLY on a better alternate position existing: a segment can
// correlate significantly as dated and still be flagged B. Only 'A' requires the
// segment to have failed the critical value. Reading p. 212's prose as though
// both flags required failing significance misses most of COFECHA's B flags —
// on ut550 it flags RCB124B 200-249 at r = 0.39, well above the 0.3281 critical
// value, because a shifted position scored higher.
//
// SEGMENTATION (p. 211, col. 1):
//   "the first segment to be tested will always begin with the first year of the
//    series, while the last segment to be tested always ends with the last year
//    of the series. All segments tested, no matter when they begin, are of the
//    same length ... Intermediate segments being tested will always begin on
//    years evenly divisible by the lag value."
//   Verified against the worked examples: LLC003B 1695-1887 gives 8 segments,
//   the last being 1838-1887 (Table 8); LLC001B 1705-1858 gives 6 (Table 3).
//
// CRITICAL VALUES (p. 209, Table 2): the one-tailed Student-t critical value at
//   `pcrit` on df = n-2, converted to r. Reproduces Table 2 exactly
//   (n=50 -> 0.3281, n=10 -> 0.7155, n=100 -> 0.2324).
//
// INPUT is the shared Frame contract: cols[0] = years (ascending integers),
// cols[1..] = RAW ring-width measurements (missing = null/NaN, absent ring = 0).
//
// VALIDATED against the real program: Cofecha_MRWE.exe (COFECHA 6.06) run on
// chronologies/ut550.rwl (110 columns / 114 series, 504 BC - AD 2014) with every
// Main Menu default accepted. See tools/cofecha_compare.js and the ut550 section
// of test/cofecha_test.js. On that run:
//   EXACT   series count, every series' interval, years, segments tested per
//           series, sample depth and absent-ring count on all 2503 years, and
//           the unfiltered statistics (mean, std dev, autocorrelation)
//   ~EXACT  mean sensitivity (0.3867 vs COFECHA's 0.3864 over the run)
//   CLOSE   master dating series r = 0.963 over 2503 years; correlation with
//           master within 0.05 on 89% of series; 99.1% of segments reach the
//           SAME verdict (flagged / not, and the same letter)
//   OPEN    the AR order agrees on 67% of series, and Part 7's two "Filtered"
//           columns (max value, std dev) do not reproduce — COFECHA's printed
//           max sits in a narrow 2.35-2.84 band that is uncorrelated with series
//           length, so it is evidently not a plain maximum of the index, and
//           what it is has not been identified. Those two columns are reported
//           here as the honest maximum and standard deviation of the detrended,
//           AR-modelled series and will not match COFECHA's.
//
// Deliberate divergences from ringdater's own pipeline, all for COFECHA fidelity:
//   * the log transform adds ONE SIXTH OF THE SERIES MEAN (p. 208, Option 4),
//     not ringdater normalise()'s constant of (abs(min)+1)*7/6;
//   * the master is the plain arithmetic mean, not dplR's Tukey biweight;
//   * correlations are Pearson (p. 208-209, Option 5) and flags use the 99%
//     ONE-TAILED level, not dplR / prob_check's two-sided p = 0.05.
// ============================================================================

const C = require('../analysis/comb.js');
const { detrendSpline } = require('../spline.js');
const { levinson, acov } = require('../ar.js');
const { pt2sided } = require('./cortest.js');

// The COFECHA Main Menu defaults (pp. 207-210).
const COFECHA_DEFAULTS = {
  splineLength: 32,   // Option 1: 50% frequency response at 32 years; <= 0 = no detrending
  segLength: 50,      // Option 2: segment length to examine
  segLag: 25,         // Option 2: lag between successive segments (50% overlap)
  arModel: true,      // Option 3: autoregressive modelling
  arMaxOrder: 3,      // highest AR order considered (see arFit)
  arMinOrder: 1,      // COFECHA never reports order 0
  standardize: true,  // z-score each transformed series before it joins the master
  logTransform: true, // Option 4: log transform of the detrended, AR-modelled series
  pcrit: 0.01,        // Option 5: 99% one-tailed confidence level
  shift: 10,          // -10..+10 alternate dating positions (p. 210)
  omitAbsent: true,   // Option 9: omit absent rings from the master
  firstDiff: false,   // Option F: transform series using first differences
  minOthers: 3,       // series needed before an "all other series" SD is meaningful
  outlierHigh: 3.0,   // Part 6[E]: > 3.0 SD ABOVE the mean of the other series
  outlierLow: 4.5,    // Part 6[E]: > 4.5 SD BELOW the mean of the other series
  divergeSD: 4.0,     // Part 6[C]: consecutive year change diverging by >= 4 SD
  leverageN: 4,       // Part 6[B]: the four years that most lower / raise r
  keepSeries: true,   // return each series' transformed values + its leave-one-out master
};

const isNA = v => v == null || (typeof v === 'number' && Number.isNaN(v));

// ---------------------------------------------------------------------------
// Critical correlation coefficient: Table 2 (p. 209).
// r_crit = t / sqrt(t^2 + df) where P(T_df > t) = alpha (ONE-tailed), df = n-2.
// pt2sided(t, df) = P(|T| >= t) = 2 * P(T > t), so solve pt2sided = 2*alpha.
// ---------------------------------------------------------------------------
function criticalR(n, alpha) {
  const df = n - 2;
  if (!(df >= 1) || !(alpha > 0) || !(alpha < 0.5)) return NaN;
  const target = 2 * alpha;
  let lo = 0, hi = 1000;                     // pt2sided is monotone decreasing in t
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (pt2sided(mid, df) > target) lo = mid; else hi = mid;
  }
  const t = (lo + hi) / 2;
  return t / Math.sqrt(t * t + df);
}

// ---------------------------------------------------------------------------
// Correlation kernels. Sums are carried so a single observation can be dropped
// in O(1) for the Part 6[B] leverage profile.
// ---------------------------------------------------------------------------
function rFromSums(n, sx, sy, sxx, syy, sxy) {
  if (n < 3) return NaN;
  const dxx = sxx - sx * sx / n;
  const dyy = syy - sy * sy / n;
  const den = Math.sqrt(dxx * dyy);
  return den > 0 ? (sxy - sx * sy / n) / den : NaN;
}

function sumsOf(x, y) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < x.length; i++) {
    const a = x[i], b = y[i];
    n++; sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
  }
  return { n, sx, sy, sxx, syy, sxy };
}

function corr(x, y) {
  const s = sumsOf(x, y);
  return { n: s.n, r: rFromSums(s.n, s.sx, s.sy, s.sxx, s.syy, s.sxy) };
}

function meanOf(a) { let s = 0, n = 0; for (const v of a) if (!isNA(v)) { s += v; n++; } return n ? s / n : NaN; }

function sdOf(a) {
  const m = meanOf(a);
  let ss = 0, n = 0;
  for (const v of a) if (!isNA(v)) { const d = v - m; ss += d * d; n++; }
  return n > 1 ? Math.sqrt(ss / (n - 1)) : NaN;
}

// Lag-1 autocorrelation (Part 7 "Auto corr").
function ac1(a) {
  const v = a.filter(x => !isNA(x));
  if (v.length < 3) return NaN;
  return corr(v.slice(0, -1), v.slice(1)).r;
}

// Mean sensitivity (Part 7 "Mean sens"): mean |2(x[t+1]-x[t]) / (x[t+1]+x[t])|.
function meanSensitivity(a) {
  const v = a.filter(x => !isNA(x));
  let s = 0, n = 0;
  for (let i = 0; i + 1 < v.length; i++) {
    const sum = v[i + 1] + v[i];
    if (sum === 0) continue;
    s += Math.abs(2 * (v[i + 1] - v[i]) / sum); n++;
  }
  return n ? s / n : NaN;
}

// ---------------------------------------------------------------------------
// Autoregressive model (Option 3). COFECHA reports the order it selected but
// not the rule it used, and plain AIC is not it: on ut550 AIC keeps adding
// terms until it hits whatever ceiling it is given (order 30+ uncapped), while
// COFECHA reports order 1 for 75 of 114 series and never more than 9. The
// Schwarz/BIC penalty of k*log(n) reproduces that parsimony — on RCB012A, where
// AIC declines monotonically past order 12, BIC has its minimum at exactly the
// order 1 COFECHA chose — and `arMaxOrder` bounds the search as COFECHA's
// ceiling does. Matching it on ut550 is empirical, not documented: BIC with
// arMaxOrder 3 agrees with COFECHA's order on 67% of series, against 16% for
// uncapped AIC.
//
// Unlike dplR's ar.func, the first `order` values are NOT dropped. COFECHA
// reports each series over its full measurement interval and counts it in the
// sample depth from its first ring, so discarding the leading values would lose
// real data from the master — with an order of 30 it emptied the early years of
// ut550 entirely.
// ---------------------------------------------------------------------------
function arFit(x, o) {
  const n = x.length;
  const xm = meanOf(x);
  const xc = x.map(v => v - xm);
  const cap = Math.min(n - 1, o.arMaxOrder != null ? o.arMaxOrder : 3);
  const floor = Math.max(0, Math.min(cap, o.arMinOrder != null ? o.arMinOrder : 1));
  if (cap < 1) return { order: 0, resid: x.slice() };
  const r = acov(Float64Array.from(xc), cap);
  const { coefs, vars } = levinson(r, cap);
  const varPred = [r[0]].concat(Array.from(vars));
  let best = Infinity, order = floor;
  for (let k = floor; k <= cap; k++) {
    if (!(varPred[k] > 0)) continue;
    const crit = n * Math.log(varPred[k]) + k * Math.log(n);   // Schwarz / BIC
    if (crit < best) { best = crit; order = k; }
  }
  const ar = order > 0 ? coefs[order - 1] : [];
  const resid = new Array(n);
  for (let t = 0; t < n; t++) {
    if (t < order) { resid[t] = x[t]; continue; }   // keep, do not discard
    let e = xc[t];
    for (let j = 1; j <= order; j++) e -= ar[j - 1] * xc[t - j];
    resid[t] = e + xm;
  }
  return { order, resid };
}

// ---------------------------------------------------------------------------
// The per-series transform chain (p. 210). `raw` is the full-length column; the
// chain runs on the present values only and is written back in place, so
// leading / trailing gaps stay NA.
// ---------------------------------------------------------------------------
function transformSeries(raw, o) {
  const at = [];
  for (let i = 0; i < raw.length; i++) if (!isNA(raw[i])) at.push(i);
  const out = new Array(raw.length).fill(NaN);
  if (at.length < 5) return { values: out, preLog: out.slice(), arOrder: 0, nLogFailed: 0 };

  let v = at.map(i => Number(raw[i]));

  // Option 1 — spline. detrendSpline replaces zeros with 0.001 and returns the
  // ratio series/curve, exactly as dplR::detrend.series does. A non-positive
  // splineLength means "no detrending": test the untransformed measurements.
  if (o.splineLength > 0) v = Array.from(detrendSpline(v, o.splineLength, 0.5).detrended);

  // Option 3 — AR modelling.
  let arOrder = 0;
  if (o.arModel) { const fit = arFit(v, o); arOrder = fit.order; v = fit.resid; }

  // Part 7's "Filtered" statistics are quoted on the detrended, AR-modelled
  // series BEFORE the log transform — COFECHA prints a max around 2.5 and a
  // standard deviation around 0.35 for it, i.e. an index with mean 1, not log
  // units. Keep that series alongside the one the correlations run on.
  const preLog = v.slice();

  // Option 4 — log transform, adding one sixth of the series mean (p. 208).
  let nLogFailed = 0;
  if (o.logTransform) {
    const c = meanOf(v) / 6;
    v = v.map(x => {
      if (isNA(x)) return NaN;
      const z = x + c;
      if (!(z > 0)) { nLogFailed++; return NaN; }
      return Math.log(z);
    });
  }

  // Option F — first differences.
  if (o.firstDiff) {
    const d = new Array(v.length).fill(NaN);
    for (let i = 1; i < v.length; i++) if (!isNA(v[i]) && !isNA(v[i - 1])) d[i] = v[i] - v[i - 1];
    v = d;
  }

  // Option 4b — put every series on one scale before it joins the master, so a
  // variable series cannot outweigh a quiet one in the mean.
  if (o.standardize) {
    const mu = meanOf(v), sg = sdOf(v);
    if (sg > 0) v = v.map(x => (isNA(x) ? NaN : (x - mu) / sg));
  }

  const out2 = new Array(raw.length).fill(NaN);
  for (let k = 0; k < at.length; k++) { out[at[k]] = v[k]; out2[at[k]] = preLog[k]; }
  return { values: out, preLog: out2, arOrder, nLogFailed };
}

// ---------------------------------------------------------------------------
// Segment layout for one series (p. 211). Returns [[start, end], ...].
// ---------------------------------------------------------------------------
function buildSegments(start, end, segLength, segLag) {
  if (!(end - start + 1 >= segLength)) return [];
  const starts = new Set([start]);                       // first segment: series start
  const firstMult = Math.ceil(start / segLag) * segLag;  // intermediates: divisible by lag
  for (let b = firstMult; b + segLength - 1 <= end; b += segLag) starts.add(b);
  starts.add(end - segLength + 1);                       // last segment: ends at series end
  return [...starts].sort((a, b) => a - b).map(b => [b, b + segLength - 1]);
}

// ---------------------------------------------------------------------------
// cofecha(frame, opts)
// ---------------------------------------------------------------------------
function cofecha(frame, opts) {
  if (!frame || !Array.isArray(frame.names) || !Array.isArray(frame.cols)) {
    throw new Error('cofecha: input must be a Frame { names, cols }');
  }
  const o = Object.assign({}, COFECHA_DEFAULTS, opts || {});
  if (C.ncol(frame) - 1 < 2) throw new Error('cofecha: at least two series are required');
  if (!(o.segLag > 0) || !(o.segLength > o.segLag)) {
    throw new Error('cofecha: segLength must exceed segLag, and segLag must be positive');
  }

  const years = frame.cols[0].map(Number);
  const nrow = years.length;
  const rowOfYear = new Map();
  for (let i = 0; i < nrow; i++) rowOfYear.set(years[i], i);

  // Each column becomes one or more ANALYSIS UNITS. A Tucson file may carry the
  // same id in two stop-marked records (a core measured in two pieces, or a
  // re-used id); the loader merges them into one column with a gap, and COFECHA
  // treats them as two series — ut550 has four such ids, which is why it reports
  // 114 series for 110 columns. Splitting on the gap also stops one spline being
  // fitted across an interval that was never sampled.
  const units = [];
  for (let c = 1; c < frame.cols.length; c++) {
    const col = frame.cols[c].map(v => (isNA(v) ? NaN : Number(v)));
    let lo = -1;
    for (let i = 0; i <= nrow; i++) {
      const present = i < nrow && !isNA(col[i]);
      if (present && lo < 0) lo = i;
      if (!present && lo >= 0) {
        const run = new Array(nrow).fill(NaN);
        for (let k = lo; k < i; k++) run[k] = col[k];
        units.push({ id: frame.names[c], raw: run });
        lo = -1;
      }
    }
  }
  if (units.length < 2) throw new Error('cofecha: at least two series are required');
  const nser = units.length;
  units.forEach((u, i) => { u.seq = i + 1; });

  // -- 1. transform every series --------------------------------------------
  const tr = units.map(u => transformSeries(u.raw, o));
  const idx = tr.map(t => t.values);                        // transformed indices
  const zeroMask = units.map(u => u.raw.map(v => v === 0));  // absent rings

  // -- 2. accumulate the master (sum + counter), Option 9 omitting absent ----
  // Two counters, because they answer different questions: `depth` is how many
  // series recorded a ring that year (Part 3's "No", which counts absent rings
  // among them), while `cnt` is how many values went into the mean, which under
  // Option 9 excludes them. Conflating the two put the sample depth out on every
  // year that had an absent ring.
  const sum = new Float64Array(nrow), cnt = new Float64Array(nrow);
  const depth = new Int32Array(nrow), absentCount = new Int32Array(nrow);
  for (let s = 0; s < nser; s++) {
    for (let i = 0; i < nrow; i++) {
      if (isNA(units[s].raw[i])) continue;
      depth[i]++;
      if (zeroMask[s][i]) absentCount[i]++;
      if (isNA(idx[s][i])) continue;
      if (o.omitAbsent && zeroMask[s][i]) continue;
      sum[i] += idx[s][i]; cnt[i]++;
    }
  }
  const masterIdx = new Array(nrow);
  for (let i = 0; i < nrow; i++) masterIdx[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
  // Part 3: the printed master is standardized to mean 0, SD 1.
  const mMean = meanOf(masterIdx), mSD = sdOf(masterIdx);
  const masterZ = masterIdx.map(v => (isNA(v) ? NaN : (v - mMean) / mSD));

  // -- 3. per-series analysis ----------------------------------------------
  const seriesOut = [];
  for (let s = 0; s < nser; s++) {
    const x = idx[s], rawx = units[s].raw, pre = tr[s].preLog;

    // leave-one-out master: remove this series' own contribution (p. 210).
    const m = new Array(nrow);
    for (let i = 0; i < nrow; i++) {
      let si = sum[i], ci = cnt[i];
      if (!isNA(x[i]) && !(o.omitAbsent && zeroMask[s][i])) { si -= x[i]; ci -= 1; }
      m[i] = ci > 0 ? si / ci : NaN;
    }

    // measurement span (Part 7 "Interval") and the span with usable indices
    let firstRow = -1, lastRow = -1, firstIdx = -1, lastIdx = -1;
    for (let i = 0; i < nrow; i++) {
      if (!isNA(rawx[i])) { if (firstRow < 0) firstRow = i; lastRow = i; }
      if (!isNA(x[i]) && !isNA(m[i])) { if (firstIdx < 0) firstIdx = i; lastIdx = i; }
    }
    if (firstRow < 0) continue;                          // series is entirely missing

    // ---- Part 5 / 6[A]: segments, shifts and flags ------------------------
    // Segments span the MEASUREMENT interval. COFECHA reports each series over
    // its full interval and tests segments across all of it.
    const segments = [];
    if (firstIdx >= 0) {
      for (const [b, e] of buildSegments(years[firstRow], years[lastRow], o.segLength, o.segLag)) {
        const rByShift = new Array(2 * o.shift + 1).fill(NaN);
        const nByShift = new Array(2 * o.shift + 1).fill(0);
        for (let d = -o.shift; d <= o.shift; d++) {
          const xs = [], ms = [];
          for (let y = b; y <= e; y++) {
            const ri = rowOfYear.get(y), rj = rowOfYear.get(y + d);
            if (ri === undefined || rj === undefined) continue;
            if (isNA(x[ri]) || isNA(m[rj])) continue;
            xs.push(x[ri]); ms.push(m[rj]);
          }
          const c0 = corr(xs, ms);
          rByShift[d + o.shift] = c0.r; nByShift[d + o.shift] = c0.n;
        }
        const n0 = nByShift[o.shift], r0 = rByShift[o.shift];
        if (!(n0 >= 3)) continue;                        // nothing to test here
        const crit = criticalR(n0, o.pcrit);
        const ok = Number.isFinite(r0) && r0 > 0 && r0 >= crit;

        // best ALTERNATE position (the zero shift is the dated position)
        let high = 0, rHigh = -Infinity;
        for (let d = -o.shift; d <= o.shift; d++) {
          if (d === 0) continue;
          const rr = rByShift[d + o.shift];
          if (Number.isFinite(rr) && rr > rHigh) { rHigh = rr; high = d; }
        }
        const haveAlt = Number.isFinite(rHigh);
        if (!haveAlt) { rHigh = NaN; high = 0; }

        // COFECHA's own legend, printed above its Part 5 matrix, is the exact
        // rule and it is NOT the one the paper's prose suggests:
        //   "A = correlation under <crit> but highest as dated;
        //    B = correlation higher at other than dated position"
        // A 'B' therefore depends only on a better alternate position existing —
        // a segment can correlate significantly as dated and still be flagged B.
        // Requiring it to fail significance first (the obvious reading of p.212)
        // missed most of COFECHA's B flags on ut550: it flags RCB124B 200-249 at
        // r = 0.39, comfortably above the 0.3281 critical value.
        let flag = null;
        if (haveAlt && rHigh > r0) flag = 'B';
        else if (!ok) flag = 'A';

        segments.push({
          start: b, end: e, n: n0, r: r0, crit,
          significant: ok, flag,
          high: flag === 'B' ? high : 0,
          rHigh,
          rHighSignificant: haveAlt && rHigh >= criticalR(nByShift[high + o.shift], o.pcrit),
          rByShift, nByShift, shiftMin: -o.shift,
        });
      }
    }
    const nFlags = segments.filter(g => g.flag).length;

    // ---- whole-series correlation with master (Part 7 "Corr with Master") --
    const wx = [], wm = [];
    for (let i = 0; i < nrow; i++) if (!isNA(x[i]) && !isNA(m[i])) { wx.push(x[i]); wm.push(m[i]); }
    const whole = corr(wx, wm);

    // ---- Part 6[B]: years that most lower / raise the correlation ---------
    const leverageOver = (rowsFrom, rowsTo) => {
      const px = [], pm = [], py = [];
      for (let i = rowsFrom; i <= rowsTo; i++) {
        if (isNA(x[i]) || isNA(m[i])) continue;
        px.push(x[i]); pm.push(m[i]); py.push(years[i]);
      }
      const S = sumsOf(px, pm);
      const rAll = rFromSums(S.n, S.sx, S.sy, S.sxx, S.syy, S.sxy);
      if (!Number.isFinite(rAll) || S.n < 5) return null;
      const eff = [];
      for (let k = 0; k < px.length; k++) {
        const a = px[k], b2 = pm[k];
        const rMinus = rFromSums(S.n - 1, S.sx - a, S.sy - b2,
          S.sxx - a * a, S.syy - b2 * b2, S.sxy - a * b2);
        if (Number.isFinite(rMinus)) eff.push({ year: py[k], delta: rAll - rMinus });
      }
      eff.sort((p, q) => p.delta - q.delta);
      return {
        r: rAll,
        lower: eff.slice(0, o.leverageN),
        higher: eff.slice(-o.leverageN).reverse(),
      };
    };
    const entireLeverage = firstIdx >= 0 ? leverageOver(firstIdx, lastIdx) : null;
    const segLeverage = [];
    for (const g of segments) {
      if (!g.flag) continue;
      const a = rowOfYear.get(g.start), b2 = rowOfYear.get(g.end);
      if (a === undefined || b2 === undefined) continue;
      const lv = leverageOver(a, b2);
      if (lv) segLeverage.push(Object.assign({ start: g.start, end: g.end, flag: g.flag }, lv));
    }

    // ---- Part 6[C]: consecutive year changes diverging by >= 4 SD ---------
    const divergent = [];
    for (let i = 1; i < nrow; i++) {
      if (isNA(x[i]) || isNA(x[i - 1])) continue;
      const mine = x[i] - x[i - 1];
      const others = [];
      for (let t = 0; t < nser; t++) {
        if (t === s) continue;
        if (isNA(idx[t][i]) || isNA(idx[t][i - 1])) continue;
        others.push(idx[t][i] - idx[t][i - 1]);
      }
      if (others.length < o.minOthers) continue;
      const mu = meanOf(others), sd = sdOf(others);
      if (!(sd > 0)) continue;
      const z = (mine - mu) / sd;
      if (Math.abs(z) >= o.divergeSD) {
        divergent.push({ year: years[i], change: mine, meanOther: mu, sdOther: sd, sd: z });
      }
    }

    // ---- Part 6[D]: absent rings -----------------------------------------
    // "ring is not normally narrow" (p. 213) — the master does not show a narrow
    // ring in the year this series recorded no growth.
    const absent = [];
    for (let i = 0; i < nrow; i++) {
      if (!zeroMask[s][i]) continue;
      const mz = isNA(m[i]) ? NaN : (m[i] - mMean) / mSD;
      absent.push({
        year: years[i], masterZ: mz, sampleDepth: depth[i],
        totalAbsent: absentCount[i], notNarrow: Number.isFinite(mz) && mz >= 0,
      });
    }

    // ---- Part 6[E]: outliers vs the other series in the same year ---------
    const outliers = [];
    for (let i = 0; i < nrow; i++) {
      if (isNA(x[i])) continue;
      const others = [];
      for (let t = 0; t < nser; t++) { if (t !== s && !isNA(idx[t][i])) others.push(idx[t][i]); }
      if (others.length < o.minOthers) continue;
      const mu = meanOf(others), sd = sdOf(others);
      if (!(sd > 0)) continue;
      const z = (x[i] - mu) / sd;
      if (z > o.outlierHigh) outliers.push({ year: years[i], value: x[i], meanOther: mu, sdOther: sd, sd: z, side: 'high' });
      else if (z < -o.outlierLow) outliers.push({ year: years[i], value: x[i], meanOther: mu, sdOther: sd, sd: z, side: 'low' });
    }

    // ---- Part 7: descriptive statistics ----------------------------------
    const msmt = [];
    for (let i = firstRow; i <= lastRow; i++) if (!isNA(rawx[i])) msmt.push(rawx[i]);
    const indexVals = pre.filter(v => !isNA(v));

    seriesOut.push({
      seq: units[s].seq, id: units[s].id,
      // The transformed series and the master it was actually tested against.
      // crossdateVerdict re-correlates these two through a running window, so it
      // has to be the SAME leave-one-out master the segment correlations used —
      // rebuilding it from the run master would compare the series partly
      // against itself. `keepSeries` suppresses these when the caller only wants
      // the tables, since together they are two arrays per series.
      transformed: o.keepSeries === false ? null : x.slice(),
      looMaster: o.keepSeries === false ? null : m.slice(),
      first: years[firstRow], last: years[lastRow], nYears: msmt.length,
      arOrder: tr[s].arOrder, nLogFailed: tr[s].nLogFailed,
      corrWithMaster: whole.r, overlapWithMaster: whole.n,
      nSegments: segments.length, nFlags,
      segments,
      stats: {
        meanMsmt: meanOf(msmt), maxMsmt: msmt.length ? Math.max(...msmt) : NaN,
        sdMsmt: sdOf(msmt), ac1Msmt: ac1(msmt), meanSens: meanSensitivity(msmt),
        maxIndex: indexVals.length ? Math.max(...indexVals) : NaN,
        sdIndex: sdOf(indexVals), ac1Index: ac1(indexVals),
      },
      problems: {
        leverage: { entire: entireLeverage, segments: segLeverage },
        divergent, absent, outliers,
      },
    });
  }

  // -- 4. the Part 5 display grid ------------------------------------------
  // COFECHA prints the segment matrix on a global grid of bins stepping by the
  // lag. A series' FIRST segment is printed under the last bin starting strictly
  // before the series begins, and the remaining segments fill columns in order —
  // which is why a segment's true span can differ from its column heading
  // (Table 3: LLC001A's 1725-1774 segment prints under the 1700-1749 heading).
  // True spans stay on each segment; this is the classic layout only.
  let gridMin = Infinity, gridMax = -Infinity;
  for (const sr of seriesOut) {
    if (sr.first < gridMin) gridMin = sr.first;
    if (sr.last > gridMax) gridMax = sr.last;
  }
  const binStarts = [];
  if (Number.isFinite(gridMin)) {
    const b0 = Math.floor((gridMin - 1) / o.segLag) * o.segLag;
    for (let b = b0; b <= gridMax; b += o.segLag) binStarts.push(b);
  }
  let usedCols = 0;
  for (const sr of seriesOut) {
    if (!sr.segments.length) { sr.gridOffset = 0; continue; }
    const b0 = Math.floor((sr.segments[0].start - 1) / o.segLag) * o.segLag;
    const off = Math.max(0, binStarts.indexOf(b0));
    sr.gridOffset = off;
    sr.segments.forEach((g, k) => { g.col = off + k; });
    usedCols = Math.max(usedCols, off + sr.segments.length);
  }
  if (usedCols > 0) binStarts.length = Math.min(binStarts.length, usedCols);

  // -- 5. run summary (Part 1 / Part 7 totals) ------------------------------
  const totSeg = seriesOut.reduce((a, b) => a + b.nSegments, 0);
  const totFlag = seriesOut.reduce((a, b) => a + b.nFlags, 0);
  const corrs = seriesOut.map(s => s.corrWithMaster).filter(Number.isFinite);
  const senss = seriesOut.map(s => s.stats.meanSens).filter(Number.isFinite);
  const lens = seriesOut.map(s => s.nYears);

  return {
    options: o,
    years,
    master: {
      index: masterIdx, z: masterZ,
      sampleDepth: Array.from(depth), absent: Array.from(absentCount),
    },
    timeSpans: seriesOut.map(s => ({ seq: s.seq, id: s.id, first: s.first, last: s.last, nYears: s.nYears })),
    grid: { binStarts, segLength: o.segLength, segLag: o.segLag },
    series: seriesOut,
    summary: {
      nSeries: seriesOut.length,
      interval: [gridMin, gridMax],
      nSegments: totSeg,
      nFlags: totFlag,
      pctFlagged: totSeg ? 100 * totFlag / totSeg : NaN,
      meanCorr: meanOf(corrs),
      meanSens: meanOf(senss),
      meanLength: meanOf(lens),
      totalAbsent: seriesOut.reduce((a, b) => a + b.problems.absent.length, 0),
    },
  };
}

module.exports = { cofecha, COFECHA_DEFAULTS, criticalR, buildSegments, meanSensitivity };
