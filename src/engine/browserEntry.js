'use strict';
// Browser entry for the RingdateR web apps. Bundled by tools/bundle.js into
// web/ringdater.bundle.js and exposed as window.RD.
//
// This exposes the FULL ringdater-js public API (src/index.js: loaders, the two
// crossdating workflows, the six plot builders + renderSvg, filter/align,
// prob-check / Rbar-EPS, buildDownloads, renderReport, the store/actions engine,
// and the Quick Chronology Checker) PLUS two chrono-checker helpers not surfaced
// by index.js (summaryTable, chronStd).
//
// The only browser-incompatible piece in index.js is src/io/xlsx.js, which does
// `require('zlib')`. The bundler (tools/bundle.js) STUBS Node core modules, so
// xlsx.js loads but `readXlsx` throws if actually called — the UI marks .xlsx
// uploads as needing a shim and fully supports the dependency-free formats
// (CSV/TXT/RWL/.pos/.lps/Ring-Measurer).
const RD = require('../index.js');
const { summaryTable } = require('./chronoChecker.js');
const { chronStd } = require('../stats/chron.js');

module.exports = Object.assign({}, RD, { summaryTable, chronStd });
