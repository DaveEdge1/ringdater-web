'use strict';
// ============================================================================
// frontend_test.js — functional (no-DOM) validation of the main RingdateR web
// frontend. jsdom is not available, so instead of driving the HTML we drive the
// app's factored logic module (web/appCore.js), which is exactly what app.js
// wires to the DOM. This proves the browser app can run end-to-end:
//
//   load example CSV text  ->  loadUndated (via ringdater.bundle.js)
//   -> pairwiseWorkflow    ->  crossDatRes table (17 cols, row count == engine)
//   -> build each plot spec-> renderSvg  (well-formed non-empty <svg>)
//   -> buildDownloads      ->  descriptors ({filename, mime, content})
//   -> renderReport        ->  HTML string
//
// It loads the SAME bundle the browser loads (web/ringdater.bundle.js), so a
// broken bundle / missing export fails here. Nonzero exit on any failure.
// ============================================================================
const fs = require('fs');
const path = require('path');

const AppCore = require('../web/appCore.js');            // -> requires the bundle
const RD = require('../web/ringdater.bundle.js').RD;     // engine oracle for row-count parity
const EXAMPLE = require('../web/exampleData.js');         // bundled example dataset

let fails = 0;
function ok(name, cond, extra) {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}
function isSvg(s) {
  return typeof s === 'string' && /^<svg[\s\S]*<\/svg>$/.test(s.trim()) && s.length > 100;
}

console.log('RingdateR frontend — functional (no-DOM) test\n');

// 0. the bundled example dataset is present and looks like the CSV -------------
ok('example dataset bundled', EXAMPLE && typeof EXAMPLE.text === 'string' && /^Year,/.test(EXAMPLE.text),
  (EXAMPLE && EXAMPLE.text ? EXAMPLE.text.length + ' chars' : 'missing'));

// 1. load the example CSV via the app's loader --------------------------------
const undated = AppCore.loadUndated([{ name: EXAMPLE.name, text: EXAMPLE.text }]);
ok('loadUndated returns a Frame', !!(undated && undated.names && undated.cols),
  undated ? undated.names.length + ' cols x ' + undated.cols[0].length + ' rows' : 'null');
const names = AppCore.seriesNames(undated);
ok('series names extracted', names.length > 1, names.slice(0, 3).join(', ') + ' ...');

// 2. run the pairwise workflow through appCore --------------------------------
const detrendUI = { detrending_select: 3, splinewindow: 21, ARmod: false, logT: false };
const result = AppCore.runAnalysis({
  mode: 1,
  undated: undated,
  detrend: detrendUI,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: names[0] }
});
ok('runAnalysis (pairwise) produced crossDatRes', !!(result && result.crossDatRes));
ok('runAnalysis produced aligned block', !!(result && result.aligned && result.aligned.names.length > 2),
  result.aligned ? result.aligned.names.length + ' aligned cols' : 'none');

// engine oracle: run the same pairwise workflow directly and compare shapes ----
const engine = RD.pairwiseWorkflow({
  undated: undated,
  detrend: { detrending_select: 3, splinewindow: 21 },
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: names[0] }
});

// 3. crossDatRes table: 17 columns, row count matches the engine --------------
const table = AppCore.crossDatTable(result.crossDatRes);
ok('crossDat table has 17 columns', table.columns.length === 17, table.columns.length + ' cols');
ok('crossDat columns are the fixed contract',
  table.columns[0] === 'Series_1' && table.columns[16] === 'Third_Overlap');
const engineRows = engine.crossDatRes.cols[0].length;
ok('crossDat table row count matches engine', table.rows.length === engineRows,
  'table ' + table.rows.length + ' vs engine ' + engineRows);
ok('every table row has 17 cells', table.rows.every(function (r) { return r.length === 17; }));

// 4. build each plot spec + renderSvg -----------------------------------------
const plots = AppCore.buildPlots(result, { colorScale: 1, lag: 0 });
['line', 'heatmap', 'leadLagBar', 'allSeries', 'detrend'].forEach(function (k) {
  const spec = plots[k];
  ok('plot spec built: ' + k, !!spec);
  const svg = AppCore.renderPlot(spec);
  ok('renderSvg(' + k + ') well-formed non-empty SVG', isSvg(svg), svg ? svg.length + ' chars' : 'empty');
});
// combined stacked SVG (what the plots area renders)
const combined = AppCore.combinedPlot([plots.line, plots.leadLagBar, plots.heatmap]);
ok('combined stacked SVG well-formed', isSvg(combined), combined.length + ' chars');

// 5. re-filter the crossDatRes (results-tab filter controls) -------------------
const refiltered = AppCore.refilter(result.crossDatRes, { r_val: 0.6, p_val: 0.01, overlap: 40, target: names[0] });
ok('refilter returns a Frame with 17 cols', !!(refiltered && refiltered.names.length === 17),
  refiltered ? refiltered.cols[0].length + ' rows kept' : 'null');

// 6. downloads: descriptors with filename/mime/content ------------------------
const dls = AppCore.downloads(result, { date: '2026-08-03' });
const dlKeys = Object.keys(dls);
ok('buildDownloads returns descriptors', dlKeys.length > 0, dlKeys.join(', '));
ok('every download descriptor is well-formed', dlKeys.every(function (k) {
  const d = dls[k];
  return d && typeof d.filename === 'string' && typeof d.mime === 'string' && d.content != null;
}));

// 7. report: self-contained HTML ----------------------------------------------
const html = AppCore.report(result, {
  files: { undated: EXAMPLE.name },
  settings: { verbose: false, probs: 30, rbarWindow: 30 }
});
ok('renderReport returns HTML', typeof html === 'string' && /^<!DOCTYPE html>/i.test(html.trim()) && /RingdateR/.test(html),
  html ? html.length + ' chars' : 'empty');

// ---- done -------------------------------------------------------------------
console.log('\n' + (fails ? fails + ' CHECK(S) FAILED' : 'PASS: web frontend runs end-to-end (load -> workflow -> table -> plots -> downloads -> report).'));
process.exit(fails ? 1 : 0);
