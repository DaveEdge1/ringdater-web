'use strict';
// ============================================================================
// chronStats.js — the chronology-level statistics COFECHA does not produce.
//
// COFECHA reports the average interseries correlation and the average mean
// sensitivity, and stops. Neither answers the question a chronology is usually
// built to answer: HOW FAR BACK IS IT RELIABLE? That is what Rbar and EPS are
// for, and the app already has the dplR machinery for them (../rwi_stats.js).
// This module puts it on the same footing as the crossdating check — same
// transformed series, same tree grouping — and states the reliability cutoff in
// one line instead of leaving it to be read off a table.
//
// TREES, NOT CORES. Two radii of one tree share wood, not just climate, so
// counting them as independent replicates overstates the sampling. rwi_stats
// now carries the full dplR within/between-tree machinery; this module infers
// the grouping from the core ids, and reports EPS BOTH ways so the convention
// is never hidden. At full sample depth the difference is cosmetic; at the far
// end of a chronology it decides whether a stretch is usable at all.
//
// A note on what EPS is not: it measures whether enough trees agree, not
// whether they are correctly dated. A misdated series lowers it, but a
// chronology can have excellent EPS and a dating error in one member — which is
// why this sits beside crossdateVerdict rather than replacing it.
// ============================================================================

const { rwiStatsRunning, inferTrees, sss } = require('../rwi_stats.js');

const DEFAULTS = {
  window: 50,          // running window length, years
  overlap: null,       // default: half the window (50% overlap, as elsewhere)
  minCorrOverlap: 30,  // years two series must share before their r counts
  epsThreshold: 0.85,  // the conventional bar
  trees: true,         // infer tree grouping from the core ids
  treeOf: null,        // or supply the grouping explicitly
};

// Build an rwl { years, series } from a cofecha() result, keeping ids unique
// even when a file carries the same id in two records (cofecha splits those
// into separate series, so the raw id is not a unique key).
function rwlFromCofecha(res) {
  const rwl = { years: res.years.slice(), series: {} };
  const keyOf = {};                 // unique key -> original id, for tree grouping
  const seen = {};
  for (const s of res.series) {
    if (!s.transformed) {
      throw new Error('chronStats: cofecha() must be run with keepSeries enabled');
    }
    seen[s.id] = (seen[s.id] || 0) + 1;
    const key = seen[s.id] === 1 ? s.id : s.id + '~' + seen[s.id];
    rwl.series[key] = s.transformed.slice();
    keyOf[key] = s.id;
  }
  return { rwl, keyOf };
}

// The earliest year from which EPS stays at or above the threshold all the way
// to the end. Scanning backwards from the most recent window is the honest
// reading: an isolated good window deep in the past does not make that period
// usable if the windows after it fail.
function reliableFrom(windows, threshold, key) {
  if (!windows.length) return null;
  let cutoff = null;
  for (let i = windows.length - 1; i >= 0; i--) {
    const v = windows[i][key];
    if (Number.isFinite(v) && v >= threshold) cutoff = windows[i].startYear;
    else break;
  }
  return cutoff;
}

function chronStats(res, opts) {
  const o = Object.assign({}, DEFAULTS, opts || {});
  if (!res || !res.series || !res.years) {
    throw new Error('chronStats: expected the result of cofecha()');
  }
  const { rwl, keyOf } = rwlFromCofecha(res);
  const keys = Object.keys(rwl.series);

  // Tree grouping is inferred from the ORIGINAL ids, so two records of one core
  // group with that core rather than becoming a tree of their own.
  let treeOf = null, treeInfo = null;
  if (o.treeOf) {
    treeOf = {};
    for (const k of keys) treeOf[k] = o.treeOf[keyOf[k]] != null ? o.treeOf[keyOf[k]] : keyOf[k];
    treeInfo = { grouped: true, explicit: true };
  } else if (o.trees) {
    const inf = inferTrees([...new Set(Object.values(keyOf))]);
    treeOf = {};
    for (const k of keys) treeOf[k] = inf.treeOf[keyOf[k]];
    treeInfo = { grouped: inf.grouped, explicit: false, trees: inf.trees };
  }

  const common = {
    windowLength: o.window,
    windowOverlap: o.overlap != null ? o.overlap : Math.floor(o.window / 2),
    minCorrOverlap: Math.min(o.minCorrOverlap, o.window),
    zeroIsMissing: true,
  };

  let perCore = [], perTree = [], error = null;
  try { perCore = rwiStatsRunning(rwl, common); }
  catch (e) { error = e.message; }
  if (treeOf && !error) {
    try { perTree = rwiStatsRunning(rwl, Object.assign({ treeOf }, common)); }
    catch (e) { perTree = []; }
  }

  const useTree = perTree.length > 0;
  const windows = useTree ? perTree : perCore;

  // group sizes, for the report to show and the user to correct
  const groups = {};
  if (treeOf) for (const k of keys) (groups[treeOf[k]] = groups[treeOf[k]] || []).push(keyOf[k]);
  const nTrees = treeOf ? Object.keys(groups).length : keys.length;

  const cutoffTree = useTree ? reliableFrom(perTree, o.epsThreshold, 'eps') : null;
  const cutoffCore = reliableFrom(perCore, o.epsThreshold, 'eps');

  const last = windows.length ? windows[windows.length - 1] : null;
  const maxTrees = windows.reduce((a, w) => Math.max(a, w.nTrees || 0), 0);

  const mean = (a, k) => {
    const v = a.map(x => x[k]).filter(Number.isFinite);
    return v.length ? v.reduce((p, q) => p + q, 0) / v.length : NaN;
  };

  return {
    options: o,
    error,
    trees: {
      inferred: treeInfo ? !treeInfo.explicit : false,
      grouped: treeInfo ? treeInfo.grouped : false,
      nCores: keys.length,
      nTrees,
      groups,                       // treeId -> [core ids]
      multiCore: Object.keys(groups).filter(t => groups[t].length > 1).length,
    },
    windows, perCore, perTree,
    summary: {
      nCores: keys.length,
      nTrees,
      rbarTot: mean(windows, 'rbarTot'),
      rbarWt: useTree ? mean(perTree, 'rbarWt') : NaN,
      rbarBt: useTree ? mean(perTree, 'rbarBt') : NaN,
      rbarEff: useTree ? mean(perTree, 'rbarEff') : mean(perCore, 'rbarTot'),
      epsMean: mean(windows, 'eps'),
      epsLatest: last ? last.eps : NaN,
      snr: useTree ? mean(perTree, 'snr') : NaN,
      // how well four trees would represent the fullest sample depth reached
      sss4: useTree && last ? sss(4, maxTrees, last.rbarEff) : NaN,
      epsThreshold: o.epsThreshold,
      reliableFromTree: cutoffTree,
      reliableFromCore: cutoffCore,
      // the headline: one sentence a reader can act on
      statement: (() => {
        const c = useTree ? cutoffTree : cutoffCore;
        const basis = useTree ? 'trees' : 'series';
        if (!windows.length) return 'Not enough overlap to compute running Rbar / EPS.';
        if (c == null) {
          return 'EPS never reaches ' + o.epsThreshold + ' and hold it to the present, so no ' +
            'part of this chronology meets the conventional bar on ' + basis + ' alone.';
        }
        if (c === windows[0].startYear) {
          return 'EPS stays at or above ' + o.epsThreshold + ' across the whole chronology (' +
            basis + ' basis).';
        }
        return 'EPS stays at or above ' + o.epsThreshold + ' from ' + c + ' onward (' + basis +
          ' basis); earlier than that the sample is too thin to rely on.';
      })(),
    },
  };
}

module.exports = { chronStats, rwlFromCofecha, reliableFrom, CHRON_DEFAULTS: DEFAULTS };
