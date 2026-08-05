'use strict';
// ============================================================================
// Per-series metadata side-channel.
//
// The Frame contract {names, cols} (src/analysis/comb.js) carries only ring
// widths and a (sanitized, possibly 6-char-truncatable) series name — it has
// nowhere to hold the identifiers, taxon, units, and dating that Tellervo /
// TRiDaS attach to each series. Rather than change that widely-validated shape,
// metadata rides ALONGSIDE the Frame in a plain object keyed by the sanitized
// internal column name (the Frame column key):
//
//     meta = { [columnName]: SeriesMeta }
//
// A plain object (not a Map) so it serializes straight into the session JSON.
// The TRiDaS reader (src/io/tridas.js) populates these; non-TRiDaS loads get
// empty entries so the UI can still display/annotate every series.
// ============================================================================

// Fields the light in-app editor is allowed to write (see PR5 UI + writeTridas).
const EDITABLE = ['taxon', 'pith', 'bark', 'labCode', 'notes'];

function emptySeriesMeta(columnName, title) {
  return {
    columnName: columnName,
    title: title != null ? title : columnName,   // original (unsanitized) TRiDaS <title>
    labCode: null,                                // lab / keycode identifier
    tridas: null,                                 // { projectId, objectId, elementId, sampleId, radiusId, seriesId, identifierDomain }
    taxon: null,                                  // e.g. "Quercus robur"    (EDITABLE)
    pith: null,                                   // true | false | null(unknown) (EDITABLE)
    bark: null,                                   // true | false | null(unknown) (EDITABLE)
    unit: null,                                   // source unit string; Frame values are mm
    variable: null,                               // 'ring width' | 'earlywood width' | ...
    dated: null,                                  // 'absolute' | 'relative' | null(undated)
    firstYearInternal: null,                      // astronomical-int first year (null if undated)
    lastYearInternal: null,
    notes: null,                                  // free text              (EDITABLE)
    raw: null                                     // opaque sub-tree snapshot for lossless round-trip
  };
}

// Merge a partial into a fresh empty meta, forcing columnName to the key.
function normalizeSeriesMeta(columnName, partial) {
  return Object.assign(emptySeriesMeta(columnName), partial || {}, { columnName: columnName });
}

// Return a meta object covering exactly `names`: reuse existing entries where
// present (preserving edits/imported fields), add empty entries for new names,
// and drop entries for names no longer loaded. `titleFor` optionally supplies a
// display title for freshly-created entries.
function ensureMeta(existing, names, titleFor) {
  const out = {};
  (names || []).forEach(function (n) {
    out[n] = (existing && existing[n]) ? existing[n] : emptySeriesMeta(n, titleFor ? titleFor(n) : n);
  });
  return out;
}

module.exports = { EDITABLE, emptySeriesMeta, normalizeSeriesMeta, ensureMeta };
