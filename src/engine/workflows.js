'use strict';
// ============================================================================
// workflows.js — the two headless RingdateR crossdating pipelines, expressed as
// PURE functions over the shared Frame contract. These are the canonical
// pipelines from the ringdater roxygen @examples + the package vignettes
// (ringdateR_Pairwise_Vignette.Rmd, ringdateR_Chronology_Vignette.Rmd) and the
// mode-1 / mode-2 branches of RingServer_function.R, with all Shiny wiring
// stripped. store.js + actions.js are thin wrappers over these.
//
//   pairwiseWorkflow    mode 1: every unordered series pair, aligned to a target.
//   chronologyWorkflow  mode 2: build a mean chronology, combine with the undated
//                       series, crossdate each undated series to the chronology,
//                       align, then re-attach onto the dated members (align_to_chron).
//
// Both take Frame input(s) + option objects and return the full result bundle so
// every artifact can be diffed against R (test/engine_test.js).
// ============================================================================

const C = require('../analysis/comb.js');
const { normalise } = require('../detrend/normalise.js');
const { leadLag } = require('../analysis/leadLag.js');
const { filterCrossdates } = require('../analysis/filterCrossdates.js');
const { alignSeries, alignToChron } = require('../analysis/align.js');
const { probCheck } = require('../stats/probCheck.js');
const { rBarEps } = require('../stats/rBarEps.js');

// Chronology diagnostics (prob_check, Rbar/EPS) are optional add-ons that can
// legitimately fail on short/thin data — e.g. dplR throws "'windowLength' is
// larger than number of years" when the window exceeds the aligned span. In the
// R app these are isolated reactive panels, so one failing doesn't abort the
// analysis. Mirror that: run them safely and surface an { error } instead of
// throwing out of the whole workflow.
function diag(fn) {
  try { return fn(); }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
}

// Arithmetic mean chronology from a detrended chronology Frame (col 0 = years).
// Mirrors R's:  data.frame(chrono[,1], rowMeans(chrono[,-1], na.rm = TRUE)) with
// colnames c("year","mean_chronology").
function meanChronology(chronDetrended, name = 'mean_chronology') {
  const nc = C.ncol(chronDetrended);
  const seriesIdx = [];
  for (let i = 1; i < nc; i++) seriesIdx.push(i);
  const mean = C.rowMeans(chronDetrended, { cols: seriesIdx, naRm: true });
  return { names: ['year', name], cols: [chronDetrended.cols[0].slice(), mean] };
}

// Drop column 0 (the year/increment axis) — R's `undated[,-1]`.
function dropYear(f) {
  return { names: f.names.slice(1), cols: f.cols.slice(1) };
}

// ---------------------------------------------------------------------------
// pairwiseWorkflow (mode 1)
//   input : { undated,               // loaded (un-detrended) undated Frame
//             detrend,               // { detrending_select, splinewindow, ARmod, logT }
//             leadlag,               // { neg_lag, pos_lag, complete }
//             filter,                // { r_val, p_val, overlap, target }
//             probWind = 20, rbarWindow = 25 }
//   output: { detrended, crossDatRes, masterLeadLag, filtered, aligned,
//             probCheck, rBarEps }
// ---------------------------------------------------------------------------
function pairwiseWorkflow(input) {
  const {
    undated, detrend = {}, leadlag = {}, filter = {},
    probWind = 20, rbarWindow = 25,
  } = input;

  // 1. detrend the undated series
  const detrended = normalise(undated, detrend);

  // 2. lead-lag crossdate every unordered pair
  const { crossDatRes, masterLeadLag } = leadLag(detrended, {
    mode: 1,
    neg_lag: leadlag.neg_lag, pos_lag: leadlag.pos_lag,
    complete: leadlag.complete,
  });

  // 3. filter the crossdates to the target series
  const filtered = filterCrossdates(crossDatRes, filter);

  // 4. align the crossdated series onto a common axis about the target
  const aligned = alignSeries(detrended, filtered, filter.target);

  // 5. chronology diagnostics on the aligned block
  const probCheckRes = diag(() => probCheck(aligned, { wind: probWind }));
  const rBarEpsRes = diag(() => rBarEps(aligned, { window: rbarWindow }));

  return {
    detrended,
    crossDatRes, masterLeadLag,
    filtered,
    aligned,
    probCheck: probCheckRes,
    rBarEps: rBarEpsRes,
  };
}

// ---------------------------------------------------------------------------
// chronologyWorkflow (mode 2)
//   input : { undated, chron,        // loaded (un-detrended) Frames
//             detrend, leadlag, filter,
//             probWind = 20, rbarWindow = 25 }
//   output: { detrended,             // detrended undated series
//             chronDetrended,        // detrended chronology members
//             chronNSeries,          // comb.NA(meanChron, undated) analysis frame
//             crossDatRes, masterLeadLag,
//             filtered,
//             alignedSeries,         // align_series result (mean-chron axis)
//             aligned,               // align_to_chron result (onto dated members)
//             probCheck, rBarEps }
// ---------------------------------------------------------------------------
function chronologyWorkflow(input) {
  const {
    undated, chron, detrend = {}, leadlag = {}, filter = {},
    probWind = 20, rbarWindow = 25,
  } = input;

  // 1. detrend undated + chronology series
  const detrended = normalise(undated, detrend);
  const chronDetrended = normalise(chron, detrend);

  // 2. arithmetic mean chronology, then combine with the undated series
  const target = filter.target != null ? filter.target : 'mean_chronology';
  const chronoMean = meanChronology(chronDetrended, target);
  const chronNSeries = C.combNA(chronoMean, dropYear(detrended));
  // comb.NA keeps the two chrono col names + every undated series name.
  chronNSeries.names = ['year', target].concat(detrended.names.slice(1));

  // 3. lead-lag crossdate each undated series against the mean chronology (col 2)
  const { crossDatRes, masterLeadLag } = leadLag(chronNSeries, {
    mode: 2,
    neg_lag: leadlag.neg_lag, pos_lag: leadlag.pos_lag,
    complete: leadlag.complete,
  });

  // 4. filter to the mean-chronology target
  const filtered = filterCrossdates(crossDatRes, Object.assign({}, filter, { target }));

  // 5. align the crossdated undated series about the mean chronology ...
  const alignedSeries = alignSeries(chronNSeries, filtered, target);
  // ... then re-attach onto the individual dated chronology members.
  const aligned = alignToChron(alignedSeries, chronDetrended);

  // 6. diagnostics on the fully aligned chronology
  const probCheckRes = diag(() => probCheck(aligned, { wind: probWind }));
  const rBarEpsRes = diag(() => rBarEps(aligned, { window: rbarWindow }));

  return {
    detrended,
    chronDetrended,
    chronNSeries,
    crossDatRes, masterLeadLag,
    filtered,
    alignedSeries,
    aligned,
    probCheck: probCheckRes,
    rBarEps: rBarEpsRes,
  };
}

module.exports = { pairwiseWorkflow, chronologyWorkflow, meanChronology, dropYear };
