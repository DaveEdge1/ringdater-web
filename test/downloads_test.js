'use strict';
// ============================================================================
// Validates the Phase 5 download/export layer (src/io/downloads.js) and the
// run-report (src/report.js). No R ground-truth file is needed: correctness is
// pinned to already-R-validated primitives —
//   (a) CSV descriptor content is byte-equal to writeCsv() of the same Frame;
//   (b) the aligned-chronology RWL descriptor round-trips through readRWL()
//       back to the source Frame (within the write precision);
//   (c) every plot descriptor carries a well-formed, non-empty <svg>;
//   (d) renderReport() emits HTML containing the expected headings/values;
//   plus filename patterns match the RingServer downloadHandler paste() strings.
// Exits nonzero on any failure.
// ============================================================================
const fs = require('fs');
const path = require('path');

const io = require('../src/io/load.js');
const { writeCsv, readRWL } = io;
const { pairwiseWorkflow, chronologyWorkflow } = require('../src/engine/workflows.js');
const D = require('../src/io/downloads.js');
const { renderReport, detMethod } = require('../src/report.js');
const { correlReplace } = require('../src/analysis/correlReplace.js');

const EXT = path.join(__dirname, 'fixtures', 'extdata');
const DATE = '2026-08-03';

let allPass = true;
function check(name, cond, detail) {
  if (!cond) allPass = false;
  console.log(name.padEnd(52), cond ? 'PASS' : 'FAIL', cond ? '' : (detail || ''));
}

// ---- load bundled data + run both workflows --------------------------------
const undated = io.loadUndated([{ name: 'undated_example.csv', text: fs.readFileSync(path.join(EXT, 'undated_example.csv'), 'utf8') }]);
const chron = io.loadChron({ name: 'dated_example_excel.xlsx', buffer: fs.readFileSync(path.join(EXT, 'dated_example_excel.xlsx')) });
const detrend = { detrending_select: 3, splinewindow: 21 };

const pw = pairwiseWorkflow({
  undated, detrend,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: true },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 30, target: 'sample_a' },
  probWind: 30, rbarWindow: 30,
});
const ch = chronologyWorkflow({
  undated, chron, detrend,
  leadlag: { neg_lag: -20, pos_lag: 20, complete: false },
  filter: { r_val: 0.5, p_val: 0.05, overlap: 40, target: 'mean_chronology' },
  probWind: 40, rbarWindow: 40,
});

// buildDownloads over both bundles (attach raw undated so rawUndatedCsv appears).
const dlPw = D.buildDownloads(Object.assign({ undated }, pw), { date: DATE });
const dlCh = D.buildDownloads(ch, { date: DATE });

// ---------------------------------------------------------------------------
// (a) CSV content == writeCsv(frame) (byte-equality)
// ---------------------------------------------------------------------------
console.log('\n== (a) CSV byte-equality vs writeCsv ==');
check('rawUndatedCsv == writeCsv(undated)',
  dlPw.rawUndatedCsv.content === writeCsv(undated));
check('detrendedCsv == writeCsv(detrended)',
  dlPw.detrendedCsv.content === writeCsv(pw.detrended));
check('crossDatResCsv == writeCsv(crossDatRes)',
  dlPw.crossDatResCsv.content === writeCsv(pw.crossDatRes));
check('filteredCrossdatesCsv == writeCsv(filtered[,-5])',
  dlPw.filteredCrossdatesCsv.content === writeCsv(D.dropCol(pw.filtered, 4)));
check('alignedChronCsv == writeCsv(aligned)',
  dlPw.alignedChronCsv.content === writeCsv(pw.aligned));
check('meanChronologyCsv == writeCsv(first 2 cols of chronNSeries)',
  dlCh.meanChronologyCsv.content === writeCsv(D.firstCols(ch.chronNSeries, 2)));
check('mime is text/csv', dlPw.rawUndatedCsv.mime === 'text/csv');

// ---------------------------------------------------------------------------
// (b) RWL descriptor round-trips through readRWL back to the source frame.
// The Tucson format has 6-char, alphanumeric-only series IDs, so long
// common-prefix names (Chron_samp_1..) collide and cannot round-trip (an
// inherent format limit, identical under R's write.rwl). We therefore relabel
// the aligned chronology to Tucson-safe unique IDs, then round-trip *through the
// descriptor helper* (values re-read within the write precision, matched by
// column position since writeRwl preserves series order for non-all-NA cols).
// ---------------------------------------------------------------------------
console.log('\n== (b) RWL round-trip via readRWL ==');
const safe = { names: ['Year'], cols: [ch.aligned.cols[0].slice()] };
for (let c = 1; c < ch.aligned.names.length; c++) {
  if (ch.aligned.cols[c].every(v => v == null || Number.isNaN(v))) continue; // dropped on write
  safe.names.push('ser' + c);                 // unique, <=6 chars, alphanumeric
  safe.cols.push(ch.aligned.cols[c].slice());
}
const rwlDesc = D.alignedChronRwl(safe, { date: DATE });
check('RWL mime is text/plain', rwlDesc.mime === 'text/plain');
const reread = readRWL(rwlDesc.content, { fileName: rwlDesc.filename });
const PREC = 0.01;                              // writeRwl default precision
check('RWL round-trip preserves series count',
  reread.names.length === safe.names.length, `${reread.names.length} != ${safe.names.length}`);
const reIdx = new Map(reread.cols[0].map((y, i) => [Math.round(Number(y)), i]));
let rtChecked = 0, rtBad = 0, maxErr = 0;
for (let c = 1; c < safe.names.length; c++) {   // safe.cols[c] <-> reread.cols[c] by position
  for (let r = 0; r < safe.cols[0].length; r++) {
    const v = safe.cols[c][r];
    if (v == null || Number.isNaN(v)) continue;
    // Tucson stores NON-NEGATIVE ring widths; negatives are written as the
    // missing marker (matches R's write.rwl) -> out of the representable domain.
    if (v < 0) continue;
    const j = reIdx.get(Math.round(Number(safe.cols[0][r])));
    const back = j == null ? null : reread.cols[c][j];
    rtChecked++;
    if (back == null || Number.isNaN(back)) { rtBad++; continue; }
    const e = Math.abs(back - v);
    if (e > maxErr) maxErr = e;
    if (e > PREC + 1e-9) rtBad++;
  }
}
check(`RWL round-trip within ${PREC} (checked ${rtChecked}, bad ${rtBad}, max|d| ${maxErr.toExponential(2)})`,
  rtChecked > 0 && rtBad === 0);

// ---------------------------------------------------------------------------
// (c) every plot descriptor is a well-formed, non-empty <svg>
// ---------------------------------------------------------------------------
console.log('\n== (c) plot descriptors are well-formed SVG ==');
function isGoodSvg(s) {
  return typeof s === 'string' && s.length > 100 &&
    /^\s*<svg[\s>]/.test(s) && /<\/svg>\s*$/.test(s) &&
    s.includes('xmlns="http://www.w3.org/2000/svg"');
}
// plots auto-built by buildDownloads
const autoPlotKeys = Object.keys(D.FILENAMES).filter(k => k.endsWith('Plot') || k.endsWith('Heatmap'));
let plotDescCount = 0;
for (const key of Object.keys(dlPw)) {
  if (dlPw[key].mime === 'image/svg+xml') {
    plotDescCount++;
    check(`buildDownloads plot ${key} well-formed svg`, isGoodSvg(dlPw[key].content));
  }
}
check('buildDownloads produced >=1 plot descriptor', plotDescCount >= 1, `got ${plotDescCount}`);

// explicitly exercise every plot-descriptor helper via caller-supplied specs
const { linePlot } = require('../src/viz/linePlot.js');
const { allSeries } = require('../src/viz/allSeries.js');
const { datedLinePlot } = require('../src/viz/datedLinePlot.js');
const lineSpec = linePlot(pw.aligned, pw.aligned.names[1], pw.aligned.names[2], 0);
const helperDescs = {
  detrendedSeriesPlot: D.detrendedSeriesPlotSvg(allSeries(pw.aligned), { date: DATE }),
  pairwiseLinePlot: D.pairwiseLinePlotSvg(lineSpec, { date: DATE }),
  smallHeatmap: D.smallHeatmapSvg(lineSpec, { date: DATE }),
  pairwiseBarPlot: D.pairwiseBarPlotSvg(datedLinePlot(pw.aligned), { date: DATE }),
  fullHeatmap: D.fullHeatmapSvg(allSeries(pw.aligned), { date: DATE }),
};
for (const k of Object.keys(helperDescs)) {
  check(`helper ${k} -> svg descriptor`, helperDescs[k].mime === 'image/svg+xml' && isGoodSvg(helperDescs[k].content));
}

// ---------------------------------------------------------------------------
// filename patterns match the RingServer paste() handlers (date-substituted)
// ---------------------------------------------------------------------------
console.log('\n== filename patterns (date = ' + DATE + ') ==');
const fnExpect = {
  rawUndatedCsv: `Undated_compiled_data_${DATE}.csv`,
  detrendedCsv: `detrended_data_${DATE}.csv`,
  filteredCrossdatesCsv: `RingdateR_results_${DATE}.csv`,
  alignedChronCsv: `detrended_chrono${DATE}.csv`,
};
for (const k of Object.keys(fnExpect)) {
  check(`filename ${k}`, dlPw[k].filename === fnExpect[k], `${dlPw[k].filename} != ${fnExpect[k]}`);
}
check('meanChronologyCsv filename', dlCh.meanChronologyCsv.filename === `mean_chronology${DATE}.csv`);
check('alignedChronRwl filename', dlCh.alignedChronRwl.filename === `updated_chronology_${DATE}.rwl`);
check('pairwiseLinePlot filename (.svg)', helperDescs.pairwiseLinePlot.filename === `Pairwise_line_plot${DATE}.svg`);
check('smallHeatmap filename (.svg)', helperDescs.smallHeatmap.filename === `Small_Pairwise_heat_map-${DATE}.svg`);
check('pairwiseBarPlot filename (.svg)', helperDescs.pairwiseBarPlot.filename === `Pairwise_bar_graph-${DATE}.svg`);
check('fullHeatmap filename (.svg)', helperDescs.fullHeatmap.filename === `Full_pairwise_heatmap${DATE}.svg`);
check('detrendedSeriesPlot filename (.svg)', helperDescs.detrendedSeriesPlot.filename === `detrended_Series_plot-${DATE}.svg`);

// ---------------------------------------------------------------------------
// (d) renderReport HTML contains the expected headings and values
// ---------------------------------------------------------------------------
console.log('\n== (d) renderReport content ==');
const cr = correlReplace(ch.aligned);
const state = {
  files: { undated: 'undated_example.csv', chrono: 'dated_example_excel.xlsx' },
  detrend: { detrending_select: 3, splinewindow: 21, ARmod: false, logT: false },
  settings: { verbose: true, probs: 30, rbarWindow: 30 },
  correlReplace: cr,
  probCheck: ch.probCheck,
};
const html = renderReport(state, { date: DATE, runDuration: '1.2 secs' });

check('detMethod(spline) == "21 year spline"', detMethod(state.detrend) === '21 year spline');
const mustContain = [
  'RingdateR output log',
  'Run time:', DATE,
  'Data loaded:', 'undated_example.csv',
  'Chronology loaded:', 'dated_example_excel.xlsx',
  'Detrending mode:', '21 year spline',
  'Prewhitening:', 'Log Transform:', 'Verbose:',
  'Problem sample window:', '30 years',
  'Correlations between each series and the arithmetic mean chronology with replacement',
  'EPS and Rbar window:',
  'Distribution of aligned samples',
  'Overview of correlations',
  'Run duration:', '1.2 secs',
];
for (const s of mustContain) check(`report contains "${s}"`, html.includes(s));
check('report is self-contained HTML (<style>, no external src)',
  html.includes('<style>') && !/src\s*=|href\s*=\s*"https?:/.test(html));
// chron-report layout: single "Data loaded" (the chronology), no separate line
const chHtml = renderReport({ files: { chrono: 'ExampleChron.csv' }, detrend: { detrending_select: 5 },
  settings: { verbose: false, probs: 20, rbarWindow: 20 } }, { date: DATE, chrono: true });
check('chrono report shows chronology as Data loaded', chHtml.includes('ExampleChron.csv'));
check('chrono report omits separate Chronology-loaded line', !chHtml.includes('Chronology loaded:'));
check('chrono report detMethod Friedman', chHtml.includes('Friedman'));

console.log('\n' + (allPass ? 'ALL PASS' : 'FAILURES PRESENT'));
process.exit(allPass ? 0 : 1);
