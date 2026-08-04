'use strict';
// ============================================================================
// actions.js — explicit, ordered actions over the store that reproduce the
// recompute DEPENDENCY GRAPH of RingServer_function.R without any Shiny wiring.
// Each action recomputes its own slot(s) and INVALIDATES (nulls) the downstream
// slots R's observers would have recomputed, so stale results never leak.
//
// The heavy lifting is delegated to the pure functions in workflows.js and the
// already-validated analysis/IO/stats modules; actions are the thin reactive
// shell. Dependency edges (upstream -> downstream), from the R server:
//
//   undated ───▶ detrended_undated ─┐
//   chrono  ───▶ chron_detrended ───┴▶ chron_n_undated ─▶ pairwise_res
//                                                        └▶ master_lead_lag
//   pairwise_res ─▶ quick_chron_aligned ─▶ final_chron_aligned / chron_aligned_undet
// ============================================================================

const C = require('../analysis/comb.js');
const io = require('../io/load.js');
const { nameCheck } = require('../analysis/checks.js');
const { normalise } = require('../detrend/normalise.js');
const { leadLag } = require('../analysis/leadLag.js');
const { runningLeadLag } = require('../analysis/runningLeadLag.js');
const { filterCrossdates } = require('../analysis/filterCrossdates.js');
const { alignSeries, alignToChron } = require('../analysis/align.js');
const { removeSeries } = require('../analysis/removeSeries.js');
const { probCheck } = require('../stats/probCheck.js');
const { rBarEps } = require('../stats/rBarEps.js');
const { meanChronology, dropYear } = require('./workflows.js');

// Downstream-of (transitive dependents). Setting a slot nulls all of these so
// derived state is never stale — the headless analogue of Shiny invalidation.
const DOWNSTREAM = {
  undated: ['detrended_undated', 'chron_n_undated', 'master_lead_lag', 'pairwise_res',
    'quick_chron_aligned', 'final_chron_aligned', 'chron_aligned_undet'],
  chrono: ['chron_detrended', 'chron_n_undated', 'master_lead_lag', 'pairwise_res',
    'quick_chron_aligned', 'final_chron_aligned', 'chron_aligned_undet'],
  detrended_undated: ['chron_n_undated', 'master_lead_lag', 'pairwise_res',
    'quick_chron_aligned', 'final_chron_aligned', 'chron_aligned_undet'],
  chron_detrended: ['chron_n_undated', 'master_lead_lag', 'pairwise_res',
    'quick_chron_aligned', 'final_chron_aligned', 'chron_aligned_undet'],
  chron_n_undated: ['master_lead_lag', 'pairwise_res',
    'quick_chron_aligned', 'final_chron_aligned', 'chron_aligned_undet'],
  pairwise_res: ['quick_chron_aligned', 'final_chron_aligned', 'chron_aligned_undet'],
};

// setState `patch` while nulling everything downstream of each patched slot.
function commit(store, patch) {
  const inval = {};
  for (const k of Object.keys(patch)) for (const d of (DOWNSTREAM[k] || [])) inval[d] = null;
  return store.setState(Object.assign(inval, patch));
}

// -------------------------------------------------------------------------
// Loading (RingServer: observeEvent(input$file1 / file2 / example_undated))
// -------------------------------------------------------------------------
function loadUndatedData(store, { files, opts } = {}) {
  const undated = io.loadUndated(files, opts || {});
  commit(store, { undated });
  return undated;
}

function loadChronData(store, { file, opts } = {}) {
  const chrono = io.loadChron(file, opts || {});
  commit(store, { chrono });
  return chrono;
}

// name_check is applied to the loaded frames (RingServer applies it inside the
// loaders / data checks before detrending).
function cleanNames(store) {
  const s = store.getState();
  const patch = {};
  if (s.undated) patch.undated = nameCheck(s.undated);
  if (s.chrono) patch.chrono = nameCheck(s.chrono);
  return commit(store, patch);
}

// -------------------------------------------------------------------------
// Detrending (RingServer: detrending() / chron_mean() / chron_n_series())
// mode 1 -> only detrended_undated; mode 2 -> also chron_detrended + chron_n_undated
// -------------------------------------------------------------------------
function runDetrend(store, { detrend = {}, mode = 1 } = {}) {
  const s = store.getState();
  if (!s.undated) throw new Error('runDetrend: no undated data loaded');
  const patch = { detrended_undated: normalise(s.undated, detrend) };

  if (mode === 2) {
    if (!s.chrono) throw new Error('runDetrend: mode 2 requires chronology data');
    const chronDetrended = normalise(s.chrono, detrend);
    patch.chron_detrended = chronDetrended;
    // chron_n_undated = comb.NA(meanChron, detrended_undated[,-1])
    const target = 'mean_chronology';
    const chronoMean = meanChronology(chronDetrended, target);
    const chronNSeries = C.combNA(chronoMean, dropYear(patch.detrended_undated));
    chronNSeries.names = ['year', target].concat(patch.detrended_undated.names.slice(1));
    patch.chron_n_undated = chronNSeries;
  }
  return commit(store, patch);
}

// -------------------------------------------------------------------------
// Lead-lag crossdating (RingServer: observeEvent(input$Go_pairwise))
// mode 1 uses detrended_undated; mode 2 uses chron_n_undated.
// -------------------------------------------------------------------------
function runPairwise(store, { mode = 1, leadlag = {} } = {}) {
  const s = store.getState();
  const the_data = mode === 2 ? s.chron_n_undated : s.detrended_undated;
  if (!the_data) throw new Error('runPairwise: detrended data not available (run runDetrend first)');
  const { crossDatRes, masterLeadLag } = leadLag(the_data, {
    mode, neg_lag: leadlag.neg_lag, pos_lag: leadlag.pos_lag, complete: leadlag.complete,
  });
  commit(store, { pairwise_res: crossDatRes, master_lead_lag: masterLeadLag });
  return { crossDatRes, masterLeadLag };
}

// runChronology — convenience: detrend (mode 2) + build chron_n_undated.
function runChronology(store, { detrend = {} } = {}) {
  return runDetrend(store, { detrend, mode: 2 });
}

// -------------------------------------------------------------------------
// Filter + align (RingServer: interseries_filt() / aligned reactives)
// mode 2 additionally re-attaches onto the dated members via align_to_chron.
// -------------------------------------------------------------------------
function filterAndAlign(store, { filter = {}, mode = 1 } = {}) {
  const s = store.getState();
  if (!s.pairwise_res) throw new Error('filterAndAlign: no pairwise_res (run runPairwise first)');
  const the_data = mode === 2 ? s.chron_n_undated : s.detrended_undated;
  const filtered = filterCrossdates(s.pairwise_res, filter);
  const alignedSeries = alignSeries(the_data, filtered, filter.target);
  const aligned = mode === 2 ? alignToChron(alignedSeries, s.chron_detrended) : alignedSeries;
  commit(store, {
    quick_chron_aligned: aligned,
    chron_aligned_undet: alignedSeries,
  });
  return { filtered, alignedSeries, aligned };
}

// -------------------------------------------------------------------------
// Diagnostics over the aligned block (RingServer: prob_check / R_bar_EPS reactives)
// -------------------------------------------------------------------------
function runProbCheck(store, { wind = 20, from = 'quick_chron_aligned' } = {}) {
  const aligned = store.getState()[from];
  if (!aligned) throw new Error(`runProbCheck: no aligned data in "${from}"`);
  return probCheck(aligned, { wind });
}

function runRBarEps(store, { window = 25, from = 'quick_chron_aligned' } = {}) {
  const aligned = store.getState()[from];
  if (!aligned) throw new Error(`runRBarEps: no aligned data in "${from}"`);
  return rBarEps(aligned, { window });
}

function runRunningLeadLag(store, { s1, s2, opts = {}, from = 'detrended_undated' } = {}) {
  const the_data = store.getState()[from];
  if (!the_data) throw new Error(`runRunningLeadLag: no data in "${from}"`);
  return runningLeadLag(the_data, Object.assign({ s1, s2 }, opts));
}

// removeSeriesAction — drop a series from the aligned block and re-store it
// (RingServer: remove_series on final_chron_aligned).
function removeSeriesAction(store, { series, from = 'quick_chron_aligned' } = {}) {
  const s = store.getState();
  const aligned = s[from];
  if (!aligned) throw new Error(`removeSeriesAction: no aligned data in "${from}"`);
  const trimmed = removeSeries(aligned, series);
  commit(store, { final_chron_aligned: trimmed });
  return trimmed;
}

module.exports = {
  loadUndatedData, loadChronData, cleanNames,
  runDetrend, runPairwise, runChronology, filterAndAlign,
  runProbCheck, runRBarEps, runRunningLeadLag, removeSeriesAction,
  DOWNSTREAM,
};
