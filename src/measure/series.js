'use strict';
// ============================================================================
// series.js — the ring-width series being measured, and its edit history.
//
// Pure state machine over the numbers a VRO emits: no serial, no DOM. Widths
// are held as integer MICRONS end to end and only converted to millimetres at
// the Frame boundary, so re-editing a ring twenty times never accumulates
// floating-point drift.
//
// Output contract is the shared undated Frame { names, cols } used everywhere
// else in the app: the first column is the RING INDEX (1..n), not a year —
// a freshly measured core is undated by definition, and crossdating is what
// assigns it calendar years. This matches appCore.bindUndated(), which labels
// the index column 'ring'.
//
// Crossdating is not the ONLY way a year gets onto a ring, though: a core cut
// from a living tree has a known outermost year before the first press, and a
// signature year recognised under the microscope dates the middle of a series
// just as well. So a series may also carry a DATING ANCHOR — one ring pinned to
// one calendar year — and toDatedFrame() then emits the same table on a real
// year axis. The anchor is a statement about the wood, not a view setting: it
// is undone by undo, follows the ring through inserts and deletes, and survives
// the autosave round trip.
//
// Two acquisition modes, because the readout does not announce how it is set up
// (see detectMode in vro.js):
//   cumulative  — frames are absolute stage positions; width = this - previous
//   incremental — the readout self-zeroes, so each frame IS a ring width
// ============================================================================

const { CUMULATIVE, INCREMENTAL, MICRONS_PER_MM } = require('./vro.js');

const PITH_TO_BARK = 'pith_to_bark';
const BARK_TO_PITH = 'bark_to_pith';

// Deep enough to undo a bad run of presses, bounded so a long session cannot
// grow the history without limit.
const MAX_UNDO = 500;

function cloneRings(rings) {
  return rings.map(r => ({ width: r.width, position: r.position, note: r.note }));
}

// A ring coming back from storage has been through JSON: widths must land as
// integer microns, a missing position as null, a missing note as ''. Rubbish
// in a restored snapshot becomes a 0 mm ring rather than a NaN that would
// poison every mean downstream.
function normRing(r) {
  r = r || {};
  const w = Number(r.width);
  const p = Number(r.position);
  return {
    width: Number.isFinite(w) ? Math.round(w) : 0,
    position: r.position == null || !Number.isFinite(p) ? null : p,
    note: r.note == null ? '' : String(r.note),
  };
}

// The dating anchor as it comes back out of a snapshot: one ring index and the
// calendar year pinned to it, or null for an undated series. `ring` indexes
// `rings` — MEASUREMENT order, the order the table and the trace are in — so a
// core measured bark-to-pith can pin its very first press (the ring under the
// bark) and keep that anchor as the stage works inward. Years are INTERNAL
// astronomical integers (see src/io/year.js): contiguous across the BC/AD
// boundary, where 0 means 1 BC. An anchor pointing at a ring that is not there
// is dropped rather than carried: a year on no ring dates nothing.
function normDating(d, n) {
  if (!d) return null;
  const ring = Math.round(Number(d.ring));
  const year = Math.round(Number(d.year));
  if (!Number.isFinite(ring) || !Number.isFinite(year)) return null;
  if (ring < 0 || ring >= n) return null;
  return { ring: ring, year: year };
}

function cloneDating(d) { return d ? { ring: d.ring, year: d.year } : null; }

// createMeasureSeries(opts) -> series
//   id        series name; becomes the Frame column name
//   mode      'cumulative' (default) | 'incremental'
//   direction 'pith_to_bark' (default) | 'bark_to_pith'
//   rings, reference, lastPosition, dating
//             restore a series saved with state() — see restoreMeasureSeries
function createMeasureSeries(opts) {
  opts = opts || {};
  let id = opts.id || 'NEW1';
  let mode = opts.mode === INCREMENTAL ? INCREMENTAL : CUMULATIVE;
  let direction = opts.direction === BARK_TO_PITH ? BARK_TO_PITH : PITH_TO_BARK;

  // Rings normally start empty and arrive one press at a time; a series
  // restored from an autosave starts as the state it was saved in, which is
  // why this is a constructor argument and not a setter. Widths stay integer
  // microns across the round trip, so a restored ring is the ring measured.
  let rings = Array.isArray(opts.rings) ? opts.rings.map(normRing) : [];
  // Absolute position of the last recorded ring boundary. Starts at 0, which is
  // a VRO zeroed at the inner edge before the first press.
  let reference = Number.isFinite(Number(opts.reference)) ? Number(opts.reference) : 0;
  let lastPosition = Number.isFinite(Number(opts.lastPosition)) ? Number(opts.lastPosition) : null;
  // The one ring whose calendar year is known, or null while the series is
  // undated — which is how every series starts. See the dating section below.
  let dating = normDating(opts.dating, rings.length);
  const history = [];

  // The anchor rides in the undo history with the rings: pinning a year, and
  // an edit that moves or removes the pinned ring, are both undone by the same
  // Backspace that undoes a press.
  function snapshot() {
    history.push({ rings: cloneRings(rings), reference: reference, dating: cloneDating(dating) });
    if (history.length > MAX_UNDO) history.shift();
  }

  // -- acquisition ---------------------------------------------------------

  // One press of the foot switch. Returns the ring just recorded.
  //
  // A cumulative reading behind the previous boundary yields a NEGATIVE width.
  // It is recorded rather than dropped, and flagged: silently discarding it
  // would leave the operator watching for a ring that never appears, whereas a
  // visible negative row says "the stage went backwards, undo".
  function addReading(microns) {
    lastPosition = microns;
    snapshot();
    let ring;
    if (mode === CUMULATIVE) {
      ring = { width: microns - reference, position: microns, note: '' };
      if (ring.width < 0) ring.note = 'negative — stage moved backwards';
      reference = microns;
    } else {
      ring = { width: microns, position: null, note: microns < 0 ? 'negative reading' : '' };
    }
    rings.push(ring);
    return ring;
  }

  // A locally absent (missing) ring, recorded as zero width — the Tucson
  // convention, and what dplR expects.
  function addAbsent() {
    snapshot();
    const ring = { width: 0, position: reference, note: 'locally absent' };
    rings.push(ring);
    return ring;
  }

  // Treat a stage position as the inner edge WITHOUT recording a ring. With no
  // argument the most recent reading is used: drive to the pith, press once,
  // then hit Zero.
  function zeroAt(microns) {
    snapshot();
    reference = microns == null ? (lastPosition == null ? 0 : lastPosition) : microns;
    return reference;
  }

  // Adopt an existing series so it can be amended, corrected, or carried on
  // where the last session stopped. `widths` are MILLIMETRES, OLDEST RING FIRST
  // — the order every file and Frame in the app uses, and exactly what
  // orderedWidthsMm() emits, so load -> toFrame round-trips. A bark-to-pith
  // core is flipped back into measurement order here, since that is the order
  // the stage will continue in.
  //
  // Nothing is known about where the stage now sits, so positions are dropped
  // and the reference is reset: a cumulative readout has to be re-zeroed at the
  // last ring boundary before measuring resumes (measure.js does that on load).
  // An undo immediately afterwards restores whatever was being measured before.
  function loadWidthsMm(widths, opts) {
    opts = opts || {};
    snapshot();
    const order = direction === BARK_TO_PITH ? widths.slice().reverse() : widths.slice();
    rings = order.map(mm => {
      const missing = mm == null || Number.isNaN(Number(mm));
      const width = missing ? 0 : Math.round(Number(mm) * MICRONS_PER_MM);
      return {
        width,
        position: null,
        note: missing ? 'missing in source' : (width === 0 ? 'locally absent' : (opts.note || 'loaded')),
      };
    });
    reference = 0;
    lastPosition = null;
    // These are somebody else's rings: whatever year was pinned belonged to the
    // series that has just been replaced.
    dating = null;
    return rings.length;
  }

  // -- editing -------------------------------------------------------------
  function setWidth(index, microns) {
    if (!rings[index]) throw new Error('setWidth: no ring at index ' + index);
    snapshot();
    rings[index].width = microns;
    rings[index].note = 'edited';
  }

  // A ring put in ahead of the pinned one pushes it along: the anchor names a
  // RING, not a slot, and inserting the ring that was missed must leave the
  // signature year (or the bark ring) on the wood it was read from.
  function insert(index, microns, note) {
    snapshot();
    rings.splice(index, 0, {
      width: microns || 0,
      position: null,
      note: note || 'inserted',
    });
    if (dating && index <= dating.ring) dating.ring++;
  }

  // Deleting the pinned ring itself leaves the year on nothing, so the dating
  // goes with it rather than sliding onto the neighbour — which would silently
  // shift the whole series by a year. Undo brings both back together.
  function remove(index) {
    if (!rings[index]) throw new Error('remove: no ring at index ' + index);
    snapshot();
    rings.splice(index, 1);
    if (dating) {
      if (index === dating.ring) dating = null;
      else if (index < dating.ring) dating.ring--;
    }
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return false;
    rings = prev.rings;
    reference = prev.reference;
    dating = prev.dating;
    return true;
  }

  function clear() {
    snapshot();
    rings = [];
    reference = 0;
    lastPosition = null;
    dating = null;
  }

  // -- dating --------------------------------------------------------------
  // One ring pinned to one calendar year dates every other ring in the series,
  // because the rings either side of it are the years either side of it. Two
  // pins are worth no more than one and can only disagree, so there is exactly
  // one anchor.
  //
  // Which WAY the years run off that anchor is the direction the core is being
  // measured in: a pith-to-bark series moves forward in time as the table fills,
  // a bark-to-pith one moves back. The commonest case — a living tree collected
  // in a known year, measured bark inward — is therefore the first press pinned
  // to the collection year, and every ring after it dates itself. A signature
  // year recognised mid-series pins just as well, and is how a series measured
  // from the pith gets dated before it reaches the bark.
  //
  // The map is affine and does not mention the length of the series, so rings
  // measured after the pin date themselves as they arrive, and changing the
  // direction turns the years around the pinned ring rather than losing it.

  function timeStep() { return direction === BARK_TO_PITH ? -1 : 1; }

  // The two ends of the core, as MEASUREMENT indices — which end is which
  // depends on the direction, and this is what "date the youngest ring" means.
  function youngestRing() {
    if (!rings.length) return null;
    return direction === BARK_TO_PITH ? 0 : rings.length - 1;
  }
  function oldestRing() {
    if (!rings.length) return null;
    return direction === BARK_TO_PITH ? rings.length - 1 : 0;
  }

  // Pin ring `index` (measurement order) to calendar `year` (internal
  // astronomical integer). Replaces any existing anchor: re-dating a series is
  // one act, not an accumulation of them.
  function setDate(index, year) {
    const i = Math.round(Number(index));
    const y = Math.round(Number(year));
    if (!rings[i]) throw new Error('setDate: no ring at index ' + index);
    if (!Number.isFinite(y)) throw new Error('setDate: year must be a whole number, got ' + year);
    snapshot();
    dating = { ring: i, year: y };
    return { ring: i, year: y };
  }

  function clearDate() {
    if (!dating) return false;
    snapshot();
    dating = null;
    return true;
  }

  function isDated() { return !!dating; }

  // The calendar year of one ring, by MEASUREMENT index; null while undated.
  // Deliberately unbounded: the Measure view draws a shared row axis that runs
  // past the ends of any one series, and the year of a row beyond this core is
  // still a well-defined year — it simply has no ring of ours on it.
  function yearAt(index) {
    if (!dating) return null;
    return dating.year + timeStep() * (Math.round(Number(index)) - dating.ring);
  }

  // Years in measurement order, and oldest-first (ascending) to sit beside
  // orderedWidthsMm. Null while undated, which is what every caller branches on.
  function yearsMeasured() { return dating ? rings.map((_, i) => yearAt(i)) : null; }
  function orderedYears() {
    const y = yearsMeasured();
    return y && direction === BARK_TO_PITH ? y.reverse() : y;
  }

  // The span the series covers, first year to last. Null while undated.
  function span() {
    if (!dating || !rings.length) return null;
    return { first: yearAt(oldestRing()), last: yearAt(youngestRing()) };
  }

  // -- views ---------------------------------------------------------------

  // Widths in measurement order (mm).
  function widthsMm() { return rings.map(r => r.width / MICRONS_PER_MM); }

  // Widths oldest ring first. A core measured bark-to-pith comes off the stage
  // backwards, and every downstream routine — detrending, lead-lag, chronology
  // building — assumes a series runs oldest to youngest, so reverse it here
  // rather than leaving a trap for the analysis side.
  function orderedWidthsMm() {
    const w = widthsMm();
    return direction === BARK_TO_PITH ? w.reverse() : w;
  }

  // The shared undated Frame: ring index + one named series column.
  function toFrame() {
    const w = orderedWidthsMm();
    const index = w.map((_, i) => i + 1);
    return { names: ['ring', id], cols: [index, w] };
  }

  // The same table on a real year axis, oldest year first — the shape a dated
  // .rwl holds and what appCore calls a dated frame. Null while the series is
  // undated, so a caller writing a file falls back to toFrame() rather than
  // inventing years.
  function toDatedFrame() {
    if (!dating || !rings.length) return null;
    return { names: ['year', id], cols: [orderedYears(), orderedWidthsMm()] };
  }

  function summary() {
    if (!rings.length) return 'no rings measured';
    const total = rings.reduce((a, r) => a + r.width, 0) / MICRONS_PER_MM;
    const mean = total / rings.length;
    return rings.length + ' rings · mean ' + mean.toFixed(3) +
           ' mm · total ' + total.toFixed(3) + ' mm';
  }

  function state() {
    return {
      id, mode, direction,
      rings: cloneRings(rings),
      reference, lastPosition,
      dating: cloneDating(dating),
      count: rings.length,
      canUndo: history.length > 0,
    };
  }

  return {
    addReading, addAbsent, zeroAt, loadWidthsMm,
    setWidth, insert, remove, undo, clear,
    setDate, clearDate, isDated, yearAt, yearsMeasured, orderedYears, span,
    youngestRing, oldestRing,
    widthsMm, orderedWidthsMm, toFrame, toDatedFrame, summary, state,
    get id() { return id; },
    set id(v) { id = v || 'NEW1'; },
    get mode() { return mode; },
    set mode(v) { mode = v === INCREMENTAL ? INCREMENTAL : CUMULATIVE; },
    get direction() { return direction; },
    set direction(v) { direction = v === BARK_TO_PITH ? BARK_TO_PITH : PITH_TO_BARK; },
    get length() { return rings.length; },
  };
}

// Rebuild a series from the shape state() emits — the other half of the
// Measure view's autosave. Notes, stage positions and the dating anchor come
// back with the widths, so a restored core is indistinguishable from the one
// that was being measured. The undo HISTORY is deliberately not carried: it records an
// editing sitting rather than the wood, and persisting hundreds of ring
// snapshots to make Backspace work after a reload is not worth the bytes.
function restoreMeasureSeries(st) {
  return createMeasureSeries(st || {});
}

module.exports = { createMeasureSeries, restoreMeasureSeries, PITH_TO_BARK, BARK_TO_PITH, MAX_UNDO };
