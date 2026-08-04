'use strict';
// ============================================================================
// store.js — a tiny, framework-agnostic state container that mirrors the 13
// `reactiveValues` slots of ringdater's Shiny server (RingServer_function.R),
// with NONE of the Shiny/React/UI wiring. All the render/download/observe-UI
// machinery is deliberately dropped; only the *data* state and the recompute
// DEPENDENCY ORDER survive, re-expressed as the explicit actions in actions.js.
//
// RingServer reactiveValues -> store state slots (all start empty === null):
//   error_log            reactive log of RingdateR_error_message strings
//   loading              staging buffer for an in-progress undated load
//   chron_loading        staging buffer for an in-progress chronology load
//   undated              loaded, un-detrended undated series (Frame)
//   chrono               loaded, un-detrended chronology members (Frame)
//   detrended_undated    normalise(undated)              [depends: undated]
//   chron_detrended      normalise(chrono)               [depends: chrono]
//   chron_n_undated      comb.NA(meanChron, undated)     [depends: chron_detrended, detrended_undated]
//   master_lead_lag      lead_lag_analysis()[[2]][,-1]   [depends: detrended_undated | chron_n_undated]
//   pairwise_res         lead_lag_analysis()[[1]] (cross_dat_res) [same dep]
//   quick_chron_aligned  align_series() -> align_to_chron (mode 2) [depends: pairwise_res, filter]
//   final_chron_aligned  aligned chronology after prob-sample removal
//   chron_aligned_undet  the aligned, still-undetrended chronology
//
// The reactive graph (which slot recomputes when another changes) is encoded in
// actions.js: each action recomputes its slot AND invalidates (nulls) the
// downstream slots that R's observers would have recomputed, so stale results
// never leak. This store itself is dumb: get / set / subscribe / dispatch.
// ============================================================================

// Canonical, ordered list of state slots (topologically ordered: inputs first,
// then derived, matching RingServer's declaration + observer order).
const SLOTS = [
  'error_log', 'loading', 'chron_loading',
  'undated', 'chrono',
  'detrended_undated', 'chron_detrended', 'chron_n_undated',
  'master_lead_lag', 'pairwise_res',
  'quick_chron_aligned', 'final_chron_aligned', 'chron_aligned_undet',
];

function initialState() {
  const s = {};
  for (const k of SLOTS) s[k] = null;
  s.error_log = [];        // RingServer's error_log is an accumulating table
  return s;
}

// createStore({ actions, state }) -> { getState, setState, subscribe, dispatch }.
//   actions : optional { name: (store, payload) => result } map used by dispatch.
//   state   : optional initial-state overrides merged onto the empty slots.
function createStore(opts = {}) {
  let state = Object.assign(initialState(), opts.state || {});
  const actions = Object.assign({}, opts.actions);
  const subs = new Set();

  function getState() { return state; }

  // Shallow-merge a partial into state and notify subscribers with (state, patch).
  function setState(patch) {
    const next = typeof patch === 'function' ? patch(state) : patch;
    state = Object.assign({}, state, next);
    for (const fn of subs) fn(state, next);
    return state;
  }

  // subscribe(fn) -> unsubscribe(). fn is called on every setState.
  function subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  }

  // dispatch(action, payload):
  //   * action is a string -> look it up in the registered `actions` map.
  //   * action is a function -> call directly as (store, payload).
  // The action receives the store, so it can read getState() and setState().
  // Its return value is passed straight back to the caller (e.g. workflow
  // bundles, prob-check tables) — dispatch does not swallow results.
  function dispatch(action, payload) {
    const fn = typeof action === 'function' ? action : actions[action];
    if (typeof fn !== 'function') throw new Error(`store.dispatch: unknown action "${action}"`);
    return fn(store, payload);
  }

  const store = { getState, setState, subscribe, dispatch };
  return store;
}

module.exports = { createStore, initialState, SLOTS };
