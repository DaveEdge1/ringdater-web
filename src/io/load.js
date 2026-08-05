'use strict';
// T2.6 — IO dispatcher. Wires the format-specific parsers (pos/lps/rwl) into the
// loaders' pluggable reader hooks and exposes the full RingdateR file surface:
// extension-dispatched loading plus CSV/RWL writers for downloads. Files are
// passed as descriptors { name, text?, buffer? }; extension is sniffed from the
// last 3 chars of `name` (as in ringdater's R). Returns the shared Frame.
const loaders = require('./loaders.js');
const { loadPos } = require('./pos.js');
const { loadLps } = require('./lps.js');
const { readRWL, writeRwl } = require('./rwl.js');
const { readCrn } = require('./crn.js');
const { loadRingMeasurer, combineRMFiles } = require('./ringMeasurer.js');
const meta = require('./meta.js');
const { readTridas, writeTridas } = require('./tridas.js');
const C = require('../analysis/comb.js');

// Default reader hooks, adapting each parser to the signature loaders.js expects.
const READERS = {
  pos: (file) => loadPos(file.text),
  lps: ({ series, file }) => loadLps(file.text, series),
  rwl: (file) => readRWL(file.text, { fileName: file.name }),
  crn: (file) => readCrn(file.text, { fileName: file.name }),
};

function withReaders(opts) {
  return Object.assign({}, opts, { readers: Object.assign({}, READERS, opts && opts.readers) });
}

function loadUndated(files, opts = {}) { return loaders.loadUndated(files, withReaders(opts)); }
function loadChron(file, opts = {}) { return loaders.loadChron(file, withReaders(opts)); }
function ldUndatedChron(files, opts = {}) { return loaders.ldUndatedChron(files, withReaders(opts)); }
const loadDataTabs = loaders.loadDataTabs;

// Frame -> CSV text (for download handlers). Empty for NA, to match write.csv NAs as "".
function writeCsv(frame) {
  const rows = [frame.names.join(',')];
  const n = C.nrow(frame);
  for (let r = 0; r < n; r++) {
    rows.push(frame.cols.map(c => C.isNA(c[r]) ? '' : c[r]).join(','));
  }
  return rows.join('\n') + '\n';
}

module.exports = {
  loadUndated, loadChron, loadDataTabs, ldUndatedChron,
  loadPos, loadLps, readRWL, readCrn, loadRingMeasurer, combineRMFiles,
  writeRwl, writeCsv, READERS,
  // per-series metadata side-channel helpers
  emptySeriesMeta: meta.emptySeriesMeta, normalizeSeriesMeta: meta.normalizeSeriesMeta,
  ensureMeta: meta.ensureMeta, META_EDITABLE: meta.EDITABLE,
  // TRiDaS (Tellervo) XML
  readTridas, writeTridas,
};
