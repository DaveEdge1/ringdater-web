'use strict';
// ============================================================================
// loadLps: port of ringdater::load_lps (Image-Pro `.lps` line-profile XML).
//
// R traverses (via xml2::read_xml + as_list, then `$`/`[i]` list indexing):
//   lineprofileengine > lines[count] > (profile)[i]
//                     > edges > edge > distances > channel > manual[count]
//                     > (distance)[j]  -- read the `value` attribute
// For each line the edge `value`s are read, sorted ascending, and successive
// differences taken -> ring widths. Lines are column-bound (comb.NA), each
// bottom-padded with NA to the longest line; the first column is replaced by
// the 1..nrow ring/increment number. Columns are named `<series>_L<i>`, first
// column "ring".
//
// Note on parity: R errors if a line yields fewer than 2 measurements (its
// empty diff vector crashes comb.NA/vertLen). We replicate that by throwing.
//
// Output: the shared Frame contract {names:string[], cols:(number|null)[][]}.
// Dependency-free: a tiny XML element walker is enough for this fixed schema.
// ============================================================================

const NA = null;

// ---- minimal XML walk -------------------------------------------------------
// The element walker now lives in ./xml.js (generalized for TRiDaS with
// text-node capture, entity decoding, and namespace tolerance). For the fixed
// .lps schema — which puts every value in an attribute and uses no namespaces —
// these helpers behave identically to the original local copy.
const { parseXml, child, childrenOf } = require('./xml.js');

// ---- loader -----------------------------------------------------------------

function toNum(x) {
  if (x == null) return NaN;
  const v = parseFloat(String(x));
  return v;
}

// ascending numeric sort dropping NA (R sort default: na.last = NA)
function sortedValues(vals) {
  return vals.filter(v => !Number.isNaN(v)).sort((a, b) => a - b);
}

/**
 * loadLps(text, series) -> Frame {names, cols}
 * @param {string} text   raw .lps XML content
 * @param {string} series sample id used for column names (`<series>_L<i>`)
 */
function loadLps(text, series) {
  if (typeof text !== 'string') throw new Error('loadLps: text must be a string');
  if (typeof series !== 'string') throw new Error('loadLps: series must be a string');

  const root = parseXml(text);
  const engine = child(root, 'lineprofileengine');
  const linesEl = child(engine, 'lines');
  const lineCount = parseInt((linesEl && linesEl.attrs.count) || '', 10);
  if (!(lineCount >= 1)) throw new Error('loadLps: missing/invalid lines count');

  // the i-th <profile> child of <lines> is line i (R uses positional lines[i])
  const profiles = childrenOf(linesEl, 'profile');

  const lineCols = [];   // diff arrays, one per line
  let maxLen = 0;
  for (let i = 0; i < lineCount; i++) {
    const prof = profiles[i];
    const manual = child(child(child(child(child(prof, 'edges'), 'edge'), 'distances'), 'channel'), 'manual');
    const measureCount = parseInt((manual && manual.attrs.count) || '', 10);
    const distEls = childrenOf(manual, 'distance');
    const vals = [];
    for (let j = 0; j < measureCount; j++) {
      const d = distEls[j];
      // R: manual[j]$distance ; missing -> numeric(0) (dropped). value attr -> as.numeric
      if (d === undefined) continue;
      vals.push(toNum(d.attrs.value));
    }
    const sorted = sortedValues(vals);
    const diffs = [];
    for (let k = 1; k < sorted.length; k++) diffs.push(sorted[k] - sorted[k - 1]);
    // R crashes (comb.NA/vertLen) when a line produces an empty diff vector.
    if (diffs.length === 0) {
      throw new Error(`loadLps: line ${i + 1} has fewer than 2 measurements`);
    }
    lineCols.push(diffs);
    if (diffs.length > maxLen) maxLen = diffs.length;
  }

  // assemble Frame: ring column then padded line columns
  const ring = [];
  for (let r = 0; r < maxLen; r++) ring.push(r + 1);
  const names = ['ring'];
  const cols = [ring];
  for (let i = 0; i < lineCount; i++) {
    const c = lineCols[i].slice();
    while (c.length < maxLen) c.push(NA);
    names.push(`${series}_L${i + 1}`);
    cols.push(c);
  }
  return { names, cols };
}

module.exports = { loadLps, parseXml };  // parseXml re-exported for back-compat
