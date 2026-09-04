'use strict';
// ============================================================================
// detect.js — which columns of a Frame are ALREADY detrended?
//
// Detrending a series that is already an index is not a no-op: fitting a curve
// to a curve-free series and dividing through it adds noise, and a second
// z-scoring flattens whatever the first one left. Crossdating then reads a
// worse signal than the data actually carries. The usual way this happens is
// unremarkable: a .crn chronology is standardised BY DEFINITION, and people
// routinely load indices exported from dplR, from this app, or from a
// colleague, alongside raw measurements.
//
// So this asks of each series column: could these numbers be RING WIDTHS?
// Everything here is a rule about the numbers or the file, never a guess about
// the science — and it is deliberately CONSERVATIVE. Failing to notice an index
// costs a little signal; mistaking ring widths for an index leaves a growth
// trend in place and can cost the date, so a column is only flagged on evidence
// that a width series cannot produce:
//
//   'negative values'   A ring width cannot be below zero. Anything that goes
//                       negative has been differenced, z-scored or otherwise
//                       transformed. (This is what our own detrending emits:
//                       every method but "none" ends in z-scores + 1, so any
//                       ring more than one SD below the mean comes out below 0.)
//   'z-scores'          mean 1 and SD 1 to within a per cent — the signature of
//                       that same z+1 output. A width series whose SD equals its
//                       mean that precisely is not a real possibility.
//   'index units'       the FRAME rule: most of the file's columns average
//                       within 5% of 1.0. One ring-width series averaging 1 mm
//                       is ordinary; a whole file of them agreeing on 1.000 to
//                       within a twentieth of a millimetre is not, so the file
//                       is in index units and its near-1 columns are indices.
//                       Judged over the file precisely BECAUSE one column on
//                       its own proves nothing.
//   '.crn file'         provenance: the Tucson chronology format holds
//                       standardised indices, x1000, and our reader divides
//                       them back. The format itself is the evidence.
//
// Returns the names to leave alone; normalise() takes them as `skip`.
// ============================================================================

const C = require('../analysis/comb.js');

const isNA = C.isNA;
const MIN_N = 5;              // too few rings to say anything about

// Mean / SD / minimum over the non-NA, finite values of a column.
function colStats(col) {
  let n = 0, s = 0, min = Infinity;
  for (const v of col) {
    if (isNA(v)) continue;
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    n++; s += x; if (x < min) min = x;
  }
  if (!n) return null;
  const mean = s / n;
  let ss = 0;
  for (const v of col) {
    if (isNA(v)) continue;
    const x = Number(v);
    if (!Number.isFinite(x)) continue;
    ss += (x - mean) * (x - mean);
  }
  return { n, mean, sd: Math.sqrt(ss / Math.max(1, n - 1)), min };
}

function ext3(name) {
  const s = String(name || '').toLowerCase();
  const dot = s.lastIndexOf('.');
  return dot < 0 ? '' : s.slice(dot + 1);
}

// detectDetrended(frame, opts) -> { names, reasons, all, judged }
//   opts.source   file name the frame was loaded from (provenance rule)
//   opts.minN     minimum non-NA values before a column is judged (default 5)
// `names` are series names in frame order; `reasons[name]` is the rule that
// fired; `all` is true when every judged series column was flagged.
function detectDetrended(frameIn, opts = {}) {
  const out = { names: [], reasons: {}, all: false, judged: 0 };
  const frame = frameIn && frameIn.names && frameIn.cols ? frameIn : null;
  if (!frame || frame.names.length < 2) return out;
  const minN = opts.minN != null ? opts.minN : MIN_N;
  const crn = ext3(opts.source) === 'crn';

  const stats = [];
  for (let i = 1; i < frame.names.length; i++) {
    const st = colStats(frame.cols[i]);
    stats.push(st && st.n >= minN ? st : null);
    if (st && st.n >= minN) out.judged++;
  }

  const flag = (i, why) => {
    const name = frame.names[i + 1];
    if (out.reasons[name]) return;
    out.names.push(name);
    out.reasons[name] = why;
  };

  // 1. per-column evidence: numbers a width series cannot produce.
  stats.forEach((st, i) => {
    if (!st) return;
    if (crn) return flag(i, 'standardised chronology (.crn)');
    if (st.min < 0) return flag(i, 'negative values');
    if (Math.abs(st.mean - 1) <= 0.02 && Math.abs(st.sd - 1) <= 0.02) {
      return flag(i, 'z-scores (mean 1, SD 1)');
    }
  });

  // 2. the frame rule. A single column averaging ~1 is ordinary ring widths in
  // millimetres; most of a file doing so is a file of indices. Needs at least
  // two columns to be a pattern at all, and a clear majority of them.
  if (!crn && out.judged >= 2) {
    const near1 = [];
    stats.forEach((st, i) => {
      if (!st) return;
      if (st.min < 0) return;
      if (st.sd < 0.02 || st.sd > 0.8) return;      // constant / far too spread
      if (Math.abs(st.mean - 1) <= 0.05) near1.push(i);
    });
    if (near1.length >= Math.max(2, Math.ceil(0.6 * out.judged))) {
      near1.forEach(i => flag(i, 'index units (the file averages 1.0)'));
    }
  }

  out.all = out.judged > 0 && out.names.length === out.judged;
  return out;
}

module.exports = { detectDetrended, colStats };
