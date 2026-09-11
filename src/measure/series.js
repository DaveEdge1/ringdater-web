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

// createMeasureSeries(opts) -> series
//   id        series name; becomes the Frame column name
//   mode      'cumulative' (default) | 'incremental'
//   direction 'pith_to_bark' (default) | 'bark_to_pith'
//   rings, reference, lastPosition
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
  const history = [];

  function snapshot() {
    history.push({ rings: cloneRings(rings), reference: reference });
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
    return rings.length;
  }

  // -- editing -------------------------------------------------------------
  function setWidth(index, microns) {
    if (!rings[index]) throw new Error('setWidth: no ring at index ' + index);
    snapshot();
    rings[index].width = microns;
    rings[index].note = 'edited';
  }

  function insert(index, microns, note) {
    snapshot();
    rings.splice(index, 0, {
      width: microns || 0,
      position: null,
      note: note || 'inserted',
    });
  }

  function remove(index) {
    if (!rings[index]) throw new Error('remove: no ring at index ' + index);
    snapshot();
    rings.splice(index, 1);
  }

  function undo() {
    const prev = history.pop();
    if (!prev) return false;
    rings = prev.rings;
    reference = prev.reference;
    return true;
  }

  function clear() {
    snapshot();
    rings = [];
    reference = 0;
    lastPosition = null;
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
      count: rings.length,
      canUndo: history.length > 0,
    };
  }

  return {
    addReading, addAbsent, zeroAt, loadWidthsMm,
    setWidth, insert, remove, undo, clear,
    widthsMm, orderedWidthsMm, toFrame, summary, state,
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
// Measure view's autosave. Notes and stage positions come back with the
// widths, so a restored core is indistinguishable from the one that was
// being measured. The undo HISTORY is deliberately not carried: it records an
// editing sitting rather than the wood, and persisting hundreds of ring
// snapshots to make Backspace work after a reload is not worth the bytes.
function restoreMeasureSeries(st) {
  return createMeasureSeries(st || {});
}

module.exports = { createMeasureSeries, restoreMeasureSeries, PITH_TO_BARK, BARK_TO_PITH, MAX_UNDO };
