'use strict';
// ============================================================================
// builder.js — the headless INTERACTIVE CHRONOLOGY BUILDER engine.
//
// A NEW capability layered on top of the already-validated ringdater primitives
// (the R app only does batch auto-alignment). It expresses the manual, iterative
// crossdating workflow a dendrochronologist actually performs:
//
//   * start with a pool of undated series (and/or an existing chronology),
//   * crossdate ONE candidate at a time against the CURRENT mean chronology,
//   * review the suggested best lag, APPROVE it (or override with any lag),
//   * the approved candidate joins the working chronology, its mean is
//     recomputed, and the loop repeats.
//
// Bootstrapping with no chronology: pick a first "anchor" series (placed at
// lag 0 on its own increment axis), then crossdate a second against that
// 1-member chronology, and so on. An existing loaded chronology can instead be
// used to SEED the working set (its members are already mutually aligned on the
// chron's absolute year axis) and grown from there.
//
// ALL the numeric work is delegated to the validated primitives — this module
// only orchestrates state and performs the one thing the batch pipeline never
// needed: a genuine YEAR-KEYED merge of an approved candidate onto the growing
// chronology axis (comb.NA is positional, so it cannot place a series at its
// correct absolute years). Style mirrors engine/workflows.js.
//
//   const b = createBuilder({ undated, chron, detrend });
//   b.setAnchor('sample_a');                 // bootstrap (skip if seeded)
//   const { suggestions } = b.crossdate('sample_b');
//   b.approve('sample_b', suggestions[0].lag);
//   b.chronology();                          // [year, member1, member2, ...]
// ============================================================================

const C = require('../analysis/comb.js');
const { normalise } = require('../detrend/normalise.js');
const { leadLag } = require('../analysis/leadLag.js');
const { alignSeries } = require('../analysis/align.js');
const { meanChronology } = require('./workflows.js');
const { rBarEps } = require('../stats/rBarEps.js');
// aliased: `chron` is also the name of a createBuilder() parameter (the seed
// chronology), which would otherwise shadow this dplR::chron port.
const { chron: chronStat } = require('../stats/chron.js');

const { isNA, NA } = C;
const TARGET = 'mean_chronology';

// Drop column 0 (the year/position axis) — R's `x[,-1]`.
function dropYear(f) { return { names: f.names.slice(1), cols: f.cols.slice(1) }; }

// count of non-NA values in a column.
function countNonNA(a) { let n = 0; for (const v of a) if (!isNA(v)) n++; return n; }

// Run a diagnostic that may legitimately throw on short/thin data and surface an
// { error } instead of throwing (mirrors workflows.js::diag).
function diag(fn) {
  try { return fn(); }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
}

// integer sequence a:b inclusive (R's c(a:b)).
function seq(a, b) { const o = []; for (let x = a; x <= b; x++) o.push(x); return o; }

// complete (year,value) pairs of a column against a year axis.
function completePair(years, vals) {
  const y = [], v = [];
  for (let i = 0; i < years.length; i++) {
    if (!isNA(years[i]) && !isNA(vals[i])) { y.push(+years[i]); v.push(vals[i]); }
  }
  return { y, v };
}

// The 17-column cross_dat_res contract (see leadLag.js / filterCrossdates.js).
// alignSeries only reads Series_1[0], Series_2[1] and First_lag[5]; the rest are
// filled with NA. Synthesises the single filtered row (TARGET, id, lag) that a
// real filter_crossdates(...) would hand to align_series for this one candidate.
const CROSS_NAMES = [
  'Series_1', 'Series_2', 'First_ring', 'Last_ring', 'col',
  'First_lag', 'First_R', 'First_P', 'First_Overlap',
  'Sec_lag', 'Sec_R', 'Sec_P', 'Sec_Overlap',
  'Third_lag', 'Third_R', 'Third_P', 'Third_Overlap',
];
function oneRowCrossDate(id, lag) {
  const row = [TARGET, id, NA, NA, NA, lag, NA, NA, NA, NA, NA, NA, NA, NA, NA, NA, NA];
  return { names: CROSS_NAMES.slice(), cols: row.map(v => [v]) };
}

// ---------------------------------------------------------------------------
// Year-keyed merge: place a candidate's (year -> value) pairs onto the working
// chronology's absolute year axis, growing the axis (union) as needed so the
// candidate lands at its correct absolute years even when it hangs off either
// end. comb.NA is positional and cannot do this. The working frame's year axis
// is always a contiguous integer sequence, so is the union axis, which lets us
// place any existing member column by looking up each of its own row-years.
// ---------------------------------------------------------------------------
function mergeMemberByYear(work, years, vals, id) {
  const workYears = work.cols[0];
  let lo = Infinity, hi = -Infinity;
  for (const y of workYears) { if (y < lo) lo = y; if (y > hi) hi = y; }
  for (const y of years) { if (y < lo) lo = y; if (y > hi) hi = y; }
  const newYears = seq(lo, hi);
  const at = y => y - lo;                 // contiguous axis -> row index

  const cols = [newYears];
  // reposition every existing member column by its own year values.
  for (let c = 1; c < work.cols.length; c++) {
    const dst = Array(newYears.length).fill(NA);
    const src = work.cols[c];
    for (let r = 0; r < workYears.length; r++) {
      if (!isNA(src[r])) dst[at(workYears[r])] = src[r];
    }
    cols.push(dst);
  }
  // place the new member.
  const dst = Array(newYears.length).fill(NA);
  for (let k = 0; k < years.length; k++) dst[at(years[k])] = vals[k];
  cols.push(dst);

  return { names: work.names.concat([id]), cols };
}

// ---------------------------------------------------------------------------
// createBuilder({ undated, chron, detrend })
//   undated : loaded (un-detrended) undated Frame (pool of candidates). optional
//             if chron is supplied, but at least one of undated/chron is needed.
//   chron   : loaded (un-detrended) chronology Frame to SEED the working set.
//   detrend : { detrending_select, splinewindow, ARmod, logT } — one detrending
//             config applied identically to the pool and the seed chronology.
//
// State shape:
//   working : Frame [year, member1, member2, ...] on an absolute year axis.
//             null until an anchor is set / a chron seeds it. `year` is the
//             chron's absolute years when seeded, or the anchor's own increment
//             axis when bootstrapped.
//   pool    : Map id -> detrended candidate column (full length, NA-padded).
//   members : [{ id, lag }] in insertion order. lag is the shift applied vs the
//             mean chronology when the member joined (0 for the anchor and for
//             seeded members, which sit at their native position).
// ---------------------------------------------------------------------------
function createBuilder({ undated, chron, detrend = {} } = {}) {
  if (!undated && !chron) throw new Error('createBuilder: need undated and/or chron.');

  // Per-series disposition: id -> { status, note }.
  //   'pool'    a live candidate available for crossdating (column held in `pool`)
  //   'member'  approved into the working chronology
  //   'skipped' / 'review'  set aside by the user (column still held in `pool`
  //             but blocked from crossdating until restored)
  const disp = new Map();
  const setStatus = (id, status, note) => {
    const prev = disp.get(id);
    disp.set(id, { status, note: note != null ? String(note) : (prev ? prev.note : '') });
  };

  // detrend the pool of undated candidates; address each by column name.
  const pool = new Map();
  let poolYearName = 'year';
  if (undated) {
    const det = normalise(undated, detrend);
    poolYearName = det.names[0];
    for (let c = 1; c < det.cols.length; c++) { pool.set(det.names[c], det.cols[c].slice()); setStatus(det.names[c], 'pool', ''); }
  }

  // seed the working chronology from an existing (detrended) chronology.
  let working = null;
  const members = [];
  if (chron) {
    const cd = normalise(chron, detrend);
    working = { names: cd.names.slice(), cols: cd.cols.map(c => c.slice()) };
    for (let c = 1; c < cd.names.length; c++) { members.push({ id: cd.names[c], lag: 0 }); setStatus(cd.names[c], 'member', ''); }
  }

  // Calendar datum (feature 1). null until pinned; invalidated (cleared) if the
  // pinned series is later removed so stale dating can't mislead.
  let _datum = null;
  let datumInvalidated = false;

  const hasMember = id => members.some(m => m.id === id);

  function requirePool(id) {
    if (!pool.has(id)) throw new Error(`builder: '${id}' is not in the candidate pool.`);
  }
  // Crossdating requires a LIVE pool series (not skipped/review).
  function requireActivePool(id) {
    requirePool(id);
    const d = disp.get(id);
    if (!d || d.status !== 'pool') {
      throw new Error(`builder: '${id}' is set aside (${d ? d.status : 'unknown'}); restore it before crossdating.`);
    }
  }

  // ---- position / span helpers ----------------------------------------------
  // A member's occupied span on the working axis (col 0). firstPos = its earliest
  // (minimum-axis) ring, lastPos = its most recent (maximum-axis) ring.
  function memberSpan(id) {
    if (!working) return null;
    const ci = working.names.indexOf(id);
    if (ci < 1) return null;
    const axis = working.cols[0], colv = working.cols[ci];
    let lo = Infinity, hi = -Infinity;
    for (let r = 0; r < colv.length; r++) {
      if (!isNA(colv[r])) { const p = axis[r]; if (p < lo) lo = p; if (p > hi) hi = p; }
    }
    return lo === Infinity ? null : { firstPos: lo, lastPos: hi };
  }

  // list of ids currently available for crossdating (status 'pool'), Map order.
  function activePoolIds() {
    const out = [];
    for (const [id, d] of disp) if (d.status === 'pool' && pool.has(id)) out.push(id);
    return out;
  }
  // set-aside (skipped/review) entries for state()/summary().
  function asideList() {
    const out = [];
    for (const [id, d] of disp) if (d.status === 'skipped' || d.status === 'review') out.push({ id, status: d.status, note: d.note });
    return out;
  }

  // ---- inspection -----------------------------------------------------------
  function statusOf(id) { const d = disp.get(id); return d ? d.status : null; }
  function noteOf(id) { const d = disp.get(id); return d ? d.note : ''; }

  function state() {
    return {
      members: members.map(m => ({ id: m.id, lag: m.lag, status: 'member', note: noteOf(m.id) })),
      poolIds: activePoolIds(),
      setAside: asideList(),
      hasChronology: working != null && members.length > 0,
      dated: _datum != null,
      datum: datum(),
      datumInvalidated,
    };
  }

  function chronology() {
    if (!working) return null;
    return { names: working.names.slice(), cols: working.cols.map(c => c.slice()) };
  }

  // Arithmetic mean chronology [year, mean_chronology] over the current members,
  // or null when the working set is empty. Reuses the canonical rowMeans path.
  function currentMean() {
    if (!working || members.length === 0) return null;
    return meanChronology(working, TARGET);
  }

  // ---- bootstrap ------------------------------------------------------------
  // Move `id` from the pool into an empty working set as the sole member: its
  // own increment axis becomes the chronology's coordinate, placed at lag 0.
  function setAnchor(id) {
    if (working && members.length > 0) throw new Error('builder: chronology already has members; cannot set an anchor.');
    requireActivePool(id);
    const col = pool.get(id);
    // the pool year axis is the shared increment column carried by normalise.
    // Rebuild it from the pool frame's first column is not stored; recover the
    // 1..n increment via the non-NA run (candidates are contiguous from ring 1).
    const yrs = [], vals = [];
    for (let i = 0, ring = 1; i < col.length; i++) {
      if (!isNA(col[i])) { yrs.push(ring); vals.push(col[i]); ring++; }
    }
    working = { names: [poolYearName, id], cols: [yrs, vals] };
    pool.delete(id);
    members.push({ id, lag: 0 });
    setStatus(id, 'member');
    return state();
  }

  // ---- crossdate ------------------------------------------------------------
  // Build cn = comb.NA(mean_chronology, candidate) named [year, mean_chronology,
  // id] (positional, exactly as chronologyWorkflow does), run lead_lag mode 2
  // with the mean as master, and surface the candidate's best-3 lag suggestions.
  function buildCn(id) {
    const mean = currentMean();
    if (!mean) throw new Error('builder: no chronology yet — set an anchor or seed with a chron first.');
    requireActivePool(id);
    const cn = C.combNA(mean, { names: [id], cols: [pool.get(id)] });
    cn.names = ['year', TARGET, id];
    return cn;
  }

  function crossdate(id, opts = {}) {
    const { neg_lag = -20, pos_lag = 20, complete = true } = opts;
    const cn = buildCn(id);
    const { crossDatRes, masterLeadLag } = leadLag(cn, { mode: 2, neg_lag, pos_lag, complete });

    // find the (mean_chronology, id) result row in cross_dat_res.
    const s1 = crossDatRes.cols[0], s2 = crossDatRes.cols[1];
    let row = -1;
    for (let r = 0; r < s1.length; r++) if (s1[r] === TARGET && s2[r] === id) { row = r; break; }
    if (row < 0) throw new Error(`builder: crossdate produced no result row for '${id}'.`);

    const col = n => crossDatRes.cols[CROSS_NAMES.indexOf(n)][row];
    const suggestions = [
      { lag: col('First_lag'), R: col('First_R'), P: col('First_P'), overlap: col('First_Overlap') },
      { lag: col('Sec_lag'), R: col('Sec_R'), P: col('Sec_P'), overlap: col('Sec_Overlap') },
      { lag: col('Third_lag'), R: col('Third_R'), P: col('Third_P'), overlap: col('Third_Overlap') },
    ].filter(s => !isNA(s.lag));

    return { suggestions, cn, crossDatRes, masterLeadLag };
  }

  // ---- approve --------------------------------------------------------------
  // Accept a lag for `id` (the suggested best, or any override): place the
  // candidate on the mean's axis via align_series, then YEAR-MERGE it onto the
  // working chronology so it lands at its correct absolute years, recompute
  // (implicit), drop it from the pool and record { id, lag }.
  function approve(id, lag) {
    requireActivePool(id);
    if (typeof lag !== 'number' || lag % 1 !== 0) throw new Error('builder: lag must be an integer.');
    const cn = buildCn(id);
    const placed = alignSeries(cn, oneRowCrossDate(id, lag), TARGET);

    // extract the candidate's placed (year -> value) pairs from align_series out
    // ([Year, mean_chronology, id]) and merge them onto the working axis.
    const yearCol = C.colByName(placed, 'Year');
    const idCol = C.colByName(placed, id);
    const pair = completePair(yearCol, idCol);

    working = mergeMemberByYear(working, pair.y, pair.v, id);
    pool.delete(id);
    members.push({ id, lag });
    setStatus(id, 'member');
    return state();
  }

  // ---- remove ---------------------------------------------------------------
  // Return a member to the pool (drops its column; the year axis is left intact
  // so lag references stay stable for any subsequent re-crossdating).
  function remove(id) {
    const mi = members.findIndex(m => m.id === id);
    if (mi < 0) throw new Error(`builder: '${id}' is not a member.`);
    const ci = working.names.indexOf(id);
    const col = working.cols[ci];
    // recover the (year -> value) pairs so the candidate can be re-crossdated.
    const yrs = [], vals = [];
    for (let r = 0; r < col.length; r++) if (!isNA(col[r])) { yrs.push(working.cols[0][r]); vals.push(col[r]); }
    // rebuild the candidate on its own 1..n increment axis for the pool.
    pool.set(id, vals.slice());
    setStatus(id, 'pool');

    working = {
      names: working.names.filter((_, c) => c !== ci),
      cols: working.cols.filter((_, c) => c !== ci),
    };
    members.splice(mi, 1);

    // INVALIDATE the datum if its pinned series just left the chronology — stale
    // calendar dating must not survive removal of the reference series.
    if (_datum && _datum.seriesId === id) { _datum = null; datumInvalidated = true; }
    return state();
  }

  // ==========================================================================
  // FEATURE 1 — calendar dating by pinning a known member's ring.
  // Positions on the working axis increase with time; pinning ring `edge` of a
  // member to a calendar `year` fixes a single affine map calendarYear = pos +
  // offset (monotonic). Pinning the FIRST ring sets the earliest anchor, so any
  // later-added, earlier-extending series correctly dates BEFORE it.
  // ==========================================================================
  function setDatum({ seriesId, edge, year } = {}) {
    if (!hasMember(seriesId)) throw new Error(`builder: setDatum requires '${seriesId}' to be a current member.`);
    if (edge !== 'first' && edge !== 'last') throw new Error("builder: setDatum edge must be 'first' or 'last'.");
    if (typeof year !== 'number' || year % 1 !== 0) throw new Error('builder: setDatum year must be an integer.');
    const span = memberSpan(seriesId);
    if (!span) throw new Error(`builder: '${seriesId}' has no rings to pin.`);
    const referencePos = edge === 'first' ? span.firstPos : span.lastPos;
    _datum = { seriesId, edge, year, referencePos, offset: year - referencePos };
    datumInvalidated = false;
    return state();
  }

  // Map an axis position to its calendar year. Identity when undated so callers
  // never have to special-case it.
  function calendarYear(pos) { return _datum ? pos + _datum.offset : pos; }
  function isDated() { return _datum != null; }
  function datum() { return _datum ? { ..._datum } : null; }

  // The working Frame with col 0 replaced by calendar years. If UNDATED, returns
  // the relative frame unchanged (documented) so it is always safe to call.
  function datedChronology() {
    if (!working) return null;
    const chr = chronology();
    if (!_datum) return chr;
    chr.cols[0] = chr.cols[0].map(p => p + _datum.offset);
    return chr;
  }

  // ==========================================================================
  // FEATURE 2 — per-series disposition + notes.
  // ==========================================================================
  function skip(id, note) {
    const d = disp.get(id);
    if (!d || d.status !== 'pool') throw new Error(`builder: skip requires '${id}' to be a live pool series.`);
    setStatus(id, 'skipped', note);
    return state();
  }
  function flagReview(id, note) {
    const d = disp.get(id);
    if (!d || d.status !== 'pool') throw new Error(`builder: flagReview requires '${id}' to be a live pool series.`);
    setStatus(id, 'review', note);
    return state();
  }
  function setNote(id, note) {
    const d = disp.get(id);
    if (!d) throw new Error(`builder: '${id}' is not a known series.`);
    setStatus(id, d.status, note);
    return state();
  }
  function restore(id) {
    const d = disp.get(id);
    if (!d || (d.status !== 'skipped' && d.status !== 'review')) {
      throw new Error(`builder: restore requires '${id}' to be a set-aside (skipped/review) series.`);
    }
    setStatus(id, 'pool', d.note);
    return state();
  }

  // ==========================================================================
  // FEATURE 3 — automated build (greedy, reviewable).
  // ==========================================================================
  // Seed an empty working set: crossdate every live-pool pair (leadLag mode 1),
  // pick the best pair that passes the thresholds, setAnchor one. If none pass,
  // fall back to seeding with the two longest series (documented). Returns the
  // chosen anchor + the second series still to be approved-vs-mean.
  function seedAuto(o) {
    const ids = activePoolIds();
    if (ids.length === 0) return { seeded: false };
    if (ids.length === 1) { setAnchor(ids[0]); return { seeded: true, anchor: ids[0], second: null, passed: false }; }

    const len = ids.reduce((m, id) => Math.max(m, pool.get(id).length), 0);
    const cols = [{ name: 'increment', values: seq(1, len) }];
    for (const id of ids) cols.push({ name: id, values: pool.get(id) });
    const fr = C.frame(cols);
    const { crossDatRes } = leadLag(fr, { mode: 1, neg_lag: o.neg_lag, pos_lag: o.pos_lag, complete: o.complete });
    const s1 = crossDatRes.cols[0], s2 = crossDatRes.cols[1];
    const Lag = crossDatRes.cols[5], R = crossDatRes.cols[6], P = crossDatRes.cols[7], Ov = crossDatRes.cols[8];
    let best = null;
    for (let r = 0; r < s1.length; r++) {
      const a = s1[r], bb = s2[r];
      if (isNA(a) || isNA(bb) || a === bb) continue;   // skip header + separator rows
      const rr = R[r], pp = P[r], ov = Ov[r], lg = Lag[r];
      if (isNA(rr) || isNA(lg)) continue;
      if (rr >= o.r_val && pp <= o.p_val && ov >= o.overlap) {
        if (!best || rr > best.R || (rr === best.R && lg < best.lag)) best = { a, b: bb, R: rr, P: pp, lag: lg };
      }
    }
    if (best) { setAnchor(best.a); return { seeded: true, anchor: best.a, second: best.b, passed: true }; }

    // fallback: two longest series (by non-NA count), deterministic on ties.
    const byLen = ids.slice().sort((x, y) => (countNonNA(pool.get(y)) - countNonNA(pool.get(x))) || 0);
    setAnchor(byLen[0]);
    return { seeded: true, anchor: byLen[0], second: byLen[1], passed: false, fallback: true };
  }

  function autoBuild(opts = {}) {
    const o = Object.assign({ r_val: 0.5, p_val: 0.05, overlap: 30, neg_lag: -20, pos_lag: 20, complete: true }, opts);
    const passes = s => s && s.R >= o.r_val && s.P <= o.p_val && s.overlap >= o.overlap;
    const cxOpts = { neg_lag: o.neg_lag, pos_lag: o.pos_lag, complete: o.complete };
    const added = [];

    // SEED if there is no chronology yet.
    if (!working || members.length === 0) {
      const s = seedAuto(o);
      if (s.seeded && s.second) {
        const cx = crossdate(s.second, cxOpts);
        const best = cx.suggestions[0];
        if (best) {
          approve(s.second, best.lag);                 // the second seed always joins
          if (passes(best)) added.push({ id: s.second, lag: best.lag, R: best.R, P: best.P });
        }
      }
    }

    // GREEDY LOOP: repeatedly add the best passing pool series vs the current mean.
    for (;;) {
      let best = null;
      for (const id of activePoolIds()) {
        const s = crossdate(id, cxOpts).suggestions[0];
        if (!passes(s)) continue;
        if (!best || s.R > best.R || (s.R === best.R && s.lag < best.lag)) best = { id, lag: s.lag, R: s.R, P: s.P };
      }
      if (!best) break;
      approve(best.id, best.lag);
      added.push({ id: best.id, lag: best.lag, R: best.R, P: best.P });
    }

    // Series that never passed stay in the pool for the user to review.
    return { added, notAdded: activePoolIds() };
  }

  // ==========================================================================
  // FEATURE 4 — report summary.
  // ==========================================================================
  // rBar / EPS / peak sample depth over the current chronology, guarded so short
  // or thin chronologies return { error } / nulls instead of throwing.
  function summaryStats() {
    const chr = chronology();
    if (!chr || members.length < 2) return { rbar: null, eps: null, sampleDepth: members.length >= 1 ? 1 : 0 };
    return diag(() => {
      const window = Math.min(25, chr.cols[0].length);
      const re = rBarEps(chr, { window });
      let sr = 0, cr = 0, se = 0, ce = 0;
      for (const w of re) {
        if (!isNA(w.rbarTot)) { sr += w.rbarTot; cr++; }
        if (!isNA(w.eps)) { se += w.eps; ce++; }
      }
      const cd = chronStat(dropYear(chr));
      let peak = 0; for (const d of cd.cols[1]) if (!isNA(d) && d > peak) peak = d;
      return { rbar: cr ? sr / cr : null, eps: ce ? se / ce : null, sampleDepth: peak };
    });
  }

  function summary() {
    const dated = isDated();
    const mem = members.map(m => {
      const sp = memberSpan(m.id) || { firstPos: null, lastPos: null };
      return {
        id: m.id, lag: m.lag,
        firstPos: sp.firstPos, lastPos: sp.lastPos,
        firstYear: dated && sp.firstPos != null ? calendarYear(sp.firstPos) : null,
        lastYear: dated && sp.lastPos != null ? calendarYear(sp.lastPos) : null,
      };
    });
    let span = null;
    if (working) {
      const axis = working.cols[0];
      let lo = Infinity, hi = -Infinity;
      for (const p of axis) { if (p < lo) lo = p; if (p > hi) hi = p; }
      if (lo !== Infinity) {
        span = dated ? { firstYear: calendarYear(lo), lastYear: calendarYear(hi) } : { firstPos: lo, lastPos: hi };
      }
    }
    return { members: mem, setAside: asideList(), datum: datum(), dated, span, stats: summaryStats() };
  }

  // exportable working chronology (CSV / RWL download) on the relative axis —
  // unchanged. Use datedChronology() for the calendar-year axis when dated.
  function exportChronology() { return chronology(); }

  return {
    state,
    meanChronology: currentMean,
    setAnchor,
    crossdate,
    approve,
    remove,
    chronology,
    exportChronology,
    // feature 1 — calendar dating
    setDatum,
    calendarYear,
    isDated,
    datum,
    datedChronology,
    // feature 2 — dispositions + notes
    skip,
    flagReview,
    setNote,
    restore,
    statusOf,
    // feature 3 — automated build
    autoBuild,
    // feature 4 — report summary
    summary,
  };
}

module.exports = { createBuilder, mergeMemberByYear };
