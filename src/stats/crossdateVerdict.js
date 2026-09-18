'use strict';
// ============================================================================
// crossdateVerdict.js — one verdict per series, instead of one flag per segment.
//
// WHY THIS EXISTS
// COFECHA flags segments, and on real data most of those flags are noise. On
// chronologies/ut550.rwl — published, already crossdated — COFECHA raises 25
// flags, and every one of its 12 'B' flags fails COFECHA's own test (manual
// p. 215: an alternate dating position only matters if its correlation is
// roughly twice the dated one). All twelve sit at ratios of 1.0-1.3 with
// scattered shifts (+6 -10 +1 +5 -5 -9 +8 +8 +9 +5 -1 -5). A reader who checks
// twenty-five segments and finds nothing wrong learns to ignore flags.
//
// A real dating error looks completely different. Removing one ring from
// RCB107B at 1500 produced 21 flags, ALL at +1, with ratios from 3.2 to 180.
// The difference is not the size of any single correlation — it is that a real
// error is SUSTAINED and SYSTEMATIC, and noise is neither.
//
// HOW IT WORKS
// For each series, run a correlation against the chronology built from every
// OTHER series, in a sliding window, at every dating position from -shift to
// +shift. That is the running-correlation heatmap the app already draws
// (analysis/heatmap.js -> analysis/runningLeadLag.js), with the leave-one-out
// master cofecha() already computed on the other axis. Then trace the RIDGE:
// the best-fitting lag in each year. Measured on ut550:
//
//   RCB107B with a ring removed at 1500   ridge: lag 0 for 163-1480,
//                                                then lag +1 for 1481-1989
//   all nine series carrying ut550's       ridge: one run at lag 0, holding for
//   twelve 'B' flags                              94-99% of their years
//
// A ridge that holds one lag is a dated series. A ridge that steps from one lag
// to another, and stays there, is a dating error, and the step locates it.
//
// WHERE THE ERROR IS. The window is centred, so a step is detected about half a
// window early: the step above lands at 1480 for an error at 1500, because the
// window centred on 1480 already covers 1455-1505. The reported bracket is
// therefore the step year +/- win/2, which contains the true year. Reporting a
// single year would be false precision.
//
// DIRECTION. Reading from pith to bark, a MISSING ring makes everything after it
// dated one year too early, so the later portion fits at a HIGHER lag. An extra
// or false ring does the reverse. That is the sign convention used below, and
// it is the one the injected-error tests check.
// ============================================================================

const { heatmapAnalysis } = require('../analysis/heatmap.js');

const DEFAULTS = {
  win: null,        // running window; default segLength+1 from the cofecha run
  shift: null,      // +/- dating positions; default the cofecha run's shift
  minRun: 30,       // years a ridge run must hold before it counts as sustained...
  minRunFrac: 0.5,  // ...but never more than this share of the ridge that exists
  minRunFloor: 8,   // ...and never fewer than this many years
  minWin: 21,       // shortest running window to fall back to on a short series
  minRidgeR: 0.2,   // ignore years where even the best lag correlates this weakly
  dominantFrac: 0.9,// a ridge this much at one lag is a clean single-lag ridge
  invertedR: -0.3,  // whole-series correlation at or below this = inverted
  duplicateR: 0.98, // pair correlation at or above this = the same core twice
  minOverlap: 100,  // years two series must share before a duplicate check counts
};

const isNA = v => v == null || (typeof v === 'number' && Number.isNaN(v));

// ---------------------------------------------------------------------------
// Ridge: the best-correlating lag in each year, compressed into runs.
// ---------------------------------------------------------------------------
function traceRidge(hm, optsIn) {
  const opts = Object.assign({}, DEFAULTS, optsIn || {});
  const Y = hm.cols[0], L = hm.cols[1], R = hm.cols[2];
  const best = new Map();
  for (let i = 0; i < Y.length; i++) {
    const y = Math.round(Y[i]), r = R[i];
    if (isNA(r)) continue;
    const cur = best.get(y);
    if (!cur || r > cur.r) best.set(y, { lag: L[i], r });
  }
  const years = [...best.keys()].sort((a, b) => a - b).filter(y => best.get(y).r >= opts.minRidgeR);
  const points = years.map(y => ({ year: y, lag: best.get(y).lag, r: best.get(y).r }));

  const runs = [];
  let cur = null;
  for (const p of points) {
    // a gap in years breaks a run just as a change of lag does
    if (cur && p.lag === cur.lag && p.year === cur.to + 1) { cur.to = p.year; cur.n++; cur.rSum += p.r; }
    else { if (cur) runs.push(cur); cur = { lag: p.lag, from: p.year, to: p.year, n: 1, rSum: p.r }; }
  }
  if (cur) runs.push(cur);
  runs.forEach(r => { r.years = r.to - r.from + 1; r.meanR = r.rSum / r.n; delete r.rSum; delete r.n; });
  return { points, runs };
}

// ---------------------------------------------------------------------------
// Verdict from the ridge runs.
// ---------------------------------------------------------------------------
function verdictFrom(ridge, win, optsIn) {
  // Exported and callable on its own, so it fills in its own defaults rather
  // than trusting the caller to have merged them.
  const opts = Object.assign({}, DEFAULTS, optsIn || {});
  const total = ridge.points.length;
  // A run has to hold for `minRun` years to count — but a 75-year series gives
  // only ~25 ridge points under a 51-year window, so an absolute 30 could never
  // be met and every short series came back "unstable" however well it dated
  // (CMP34A in ut585 correlates at 0.874 and was being escalated). Scale the
  // threshold to the ridge that actually exists, with a floor so it stays a
  // real test.
  const need = Math.max(opts.minRunFloor,
    Math.min(opts.minRun, Math.ceil(opts.minRunFrac * total)));
  const sustained = ridge.runs.filter(r => r.years >= need);
  const atZero = ridge.points.filter(p => p.lag === 0).length;
  const fracZero = total ? atZero / total : 0;
  const half = Math.floor(win / 2);

  if (!total) {
    return { status: 'no-signal', fracZero, sustained, problems: [],
      message: 'No window correlates well enough with the rest of the chronology to place this series.' };
  }
  if (!sustained.length) {
    return { status: 'unstable', fracZero, sustained, problems: [],
      message: 'The best-fitting dating position never holds for ' + need +
        ' years together — this series does not crossdate against the others.' };
  }

  // Merge consecutive sustained runs that share a lag (a short interruption
  // between them is not a dating change).
  const merged = [];
  for (const r of sustained) {
    const last = merged[merged.length - 1];
    if (last && last.lag === r.lag) { last.to = r.to; last.years = last.to - last.from + 1; }
    else merged.push(Object.assign({}, r));
  }

  if (merged.length === 1) {
    const only = merged[0];
    if (only.lag === 0) {
      return { status: 'dated', fracZero, sustained: merged, problems: [],
        message: 'Dated. The best fit is the dated position throughout (' +
          Math.round(100 * fracZero) + '% of years).' };
    }
    return {
      status: 'offset', fracZero, sustained: merged,
      problems: [{ kind: 'offset', shift: only.lag, from: only.from, to: only.to }],
      message: 'The whole series fits better ' + Math.abs(only.lag) + ' year' +
        (Math.abs(only.lag) === 1 ? '' : 's') + (only.lag > 0 ? ' later' : ' earlier') +
        ' than dated — it looks uniformly misdated rather than damaged at one point.',
    };
  }

  // Two or more sustained runs at different lags: each step is a dating error.
  const problems = [];
  for (let i = 1; i < merged.length; i++) {
    const a = merged[i - 1], b = merged[i];
    if (a.lag === b.lag) continue;
    const step = b.lag - a.lag;
    const at = Math.round((a.to + b.from) / 2);
    problems.push({
      kind: step > 0 ? 'missing-ring' : 'extra-ring',
      shift: step, at,
      bracket: [at - half, at + half],
      before: { lag: a.lag, from: a.from, to: a.to },
      after: { lag: b.lag, from: b.from, to: b.to },
    });
  }
  const first = problems[0];
  const msg = problems.map(p =>
    (p.kind === 'missing-ring' ? 'a ring is likely missing' : 'an extra ring has likely been counted') +
    ' between ' + p.bracket[0] + ' and ' + p.bracket[1] +
    ' (everything after it fits ' + Math.abs(p.shift) + ' year' + (Math.abs(p.shift) === 1 ? '' : 's') +
    (p.shift > 0 ? ' later' : ' earlier') + ')').join('; ');
  return {
    status: 'dating-error', fracZero, sustained: merged, problems,
    message: msg.charAt(0).toUpperCase() + msg.slice(1) + '.',
    at: first.at, bracket: first.bracket, shift: first.shift,
  };
}

// ---------------------------------------------------------------------------
// Severity — what to put at the top of the list.
// A dating error dominates; within that, a longer sustained run after the step
// and a bigger jump in correlation at the alternate position rank higher.
// ---------------------------------------------------------------------------
function severityOf(v, series) {
  if (v.status === 'dated') return 0;
  const flagged = (series.segments || []).filter(g => g.flag);
  const ratios = flagged
    .map(g => (g.r > 0 && Number.isFinite(g.rHigh) ? g.rHigh / g.r : (Number.isFinite(g.rHigh) ? 10 : 1)))
    .filter(Number.isFinite);
  const maxRatio = ratios.length ? Math.max(...ratios) : 1;
  const runLen = v.sustained.length ? Math.max(...v.sustained.filter(r => r.lag !== 0).map(r => r.years), 0) : 0;
  const base = { 'dating-error': 100, 'offset': 80, 'unstable': 60, 'no-signal': 40 }[v.status] || 0;
  return base + Math.min(30, runLen / 20) + Math.min(20, 4 * Math.log(Math.max(1, maxRatio)));
}

// ---------------------------------------------------------------------------
// crossdateVerdict(cofechaResult, opts)
//   Consumes the result of cofecha() (which must have been run with the default
//   keepSeries:true, so each series carries its transformed values and the
//   leave-one-out master it was tested against).
// ---------------------------------------------------------------------------
function crossdateVerdict(res, opts) {
  if (!res || !res.series || !res.years) {
    throw new Error('crossdateVerdict: expected the result of cofecha()');
  }
  const o = Object.assign({}, DEFAULTS, opts || {});
  const shift = o.shift != null ? o.shift : res.options.shift;
  let win = o.win != null ? o.win : res.options.segLength + 1;
  if (win % 2 === 0) win += 1;                 // runningLeadLag forces odd anyway
  const half = Math.floor(win / 2);

  const years = res.years;
  const out = [];
  for (const s of res.series) {
    if (!s.transformed || !s.looMaster) {
      throw new Error('crossdateVerdict: cofecha() must be run with keepSeries enabled');
    }
    const frame = {
      names: ['year', '__master', '__series'],
      cols: [years.slice(), s.looMaster.slice(), s.transformed.slice()],
    };
    // A series shorter than the window gets a narrower one rather than no
    // verdict at all. Narrower means noisier, so the window used is reported
    // per series and the report says when it differs from the run's.
    let useWin = win;
    if (s.nYears < win * 1.5) {
      useWin = Math.max(o.minWin, Math.floor(0.6 * s.nYears));
      if (useWin % 2 === 0) useWin -= 1;
      if (useWin > win) useWin = win;
    }
    let hm = null;
    try {
      hm = heatmapAnalysis(frame, {
        s1: '__master', s2: '__series',
        neg_lag: -shift, pos_lag: shift, win: useWin, complete: false, fast: true,
      });
    } catch (e) { hm = null; }

    let ridge = { points: [], runs: [] };
    let v;
    if (!hm) {
      v = { status: 'too-short', fracZero: NaN, sustained: [], problems: [],
        message: 'Too short for even a ' + useWin +
          '-year running window — judge this one from the segment table.' };
    } else {
      ridge = traceRidge(hm, o);
      v = verdictFrom(ridge, useWin, o);
    }

    out.push({
      seq: s.seq, id: s.id, first: s.first, last: s.last,
      status: v.status, message: v.message,
      fracZero: v.fracZero, problems: v.problems, runs: v.sustained,
      at: v.at, bracket: v.bracket, shift: v.shift,
      corrWithMaster: s.corrWithMaster, nFlags: s.nFlags, nSegments: s.nSegments,
      severity: severityOf(v, s),
      ridge, heatmap: hm, win: useWin, winDefault: win,
    });
  }
  out.sort((a, b) => b.severity - a.severity || a.seq - b.seq);

  // ---- collection-level checks the per-series pass cannot see ---------------
  const collection = [];

  // Inverted series: a strong NEGATIVE correlation is a sign or column error,
  // not a dating error, and it reads as "just a bad series" without this.
  for (const s of res.series) {
    if (Number.isFinite(s.corrWithMaster) && s.corrWithMaster <= o.invertedR) {
      collection.push({
        kind: 'inverted', ids: [s.id], r: s.corrWithMaster,
        message: s.id + ' correlates NEGATIVELY with the rest of the chronology (r = ' +
          s.corrWithMaster.toFixed(2) + '). That is usually a sign error or a column read ' +
          'in the wrong direction rather than a dating problem.',
      });
    }
  }

  // Near-duplicate series: the same core entered twice inflates sample depth and
  // EPS while looking like excellent agreement.
  const S = res.series;
  for (let i = 0; i < S.length; i++) {
    for (let j = i + 1; j < S.length; j++) {
      const a = S[i].transformed, b = S[j].transformed;
      if (!a || !b) continue;
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let k = 0; k < a.length; k++) {
        if (isNA(a[k]) || isNA(b[k])) continue;
        n++; sx += a[k]; sy += b[k]; sxx += a[k] * a[k]; syy += b[k] * b[k]; sxy += a[k] * b[k];
      }
      if (n < o.minOverlap) continue;
      const den = Math.sqrt((sxx - sx * sx / n) * (syy - sy * sy / n));
      if (!(den > 0)) continue;
      const r = (sxy - sx * sy / n) / den;
      if (r >= o.duplicateR) {
        collection.push({
          kind: 'duplicate', ids: [S[i].id, S[j].id], r, overlap: n,
          message: S[i].id + ' and ' + S[j].id + ' correlate at r = ' + r.toFixed(3) +
            ' over ' + n + ' years. Two radii of one tree do not agree this closely; ' +
            'this is usually the same measurement entered twice, and it inflates sample depth and EPS.',
        });
      }
    }
  }

  const counts = {};
  out.forEach(v => { counts[v.status] = (counts[v.status] || 0) + 1; });
  const attention = out.filter(v => v.status !== 'dated' && v.status !== 'too-short');

  return {
    options: { win, shift, minRun: o.minRun, minRidgeR: o.minRidgeR },
    series: out,
    collection,
    summary: {
      nSeries: out.length,
      counts,
      nAttention: attention.length,
      attention: attention.map(v => v.id),
    },
  };
}

module.exports = { crossdateVerdict, traceRidge, verdictFrom, CROSSDATE_DEFAULTS: DEFAULTS };
