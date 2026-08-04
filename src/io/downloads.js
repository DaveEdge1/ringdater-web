'use strict';
// ============================================================================
// downloads.js — Phase 5 download/export layer.
//
// Turns engine state / results (Frames + plot specs) into framework-agnostic
// DOWNLOAD DESCRIPTORS:
//
//   { filename, mime, content }
//
// so a browser/CLI host can `Blob([content], {type:mime})` -> save-as, without
// any DOM/Shiny wiring. This is the headless equivalent of RingServer's 16
// `downloadHandler`s (RingServer_function.R). We REUSE the R-validated writers
// (writeCsv, writeRwl) and the R-structured SVG renderer (viz/render.js toSVG),
// so the only new code here is (a) filename patterns and (b) the small frame
// reshapes R does inline (e.g. interseries_filt()[,-5]).
//
// -- Filenames -------------------------------------------------------------
// Every R handler builds its name with paste(..., Sys.Date(), ..., sep="").
// We take a deterministic `date` (a Date, an epoch ms, or a pre-formatted
// "YYYY-MM-DD" string) so filenames are testable. Formatting reproduces
// R's Sys.Date() ISO output.
//
// -- PNG vs SVG ------------------------------------------------------------
// RingServer saves the ggplots as PNG (ggsave + grDevices::png). This library
// has no raster device: the six plot builders emit an SVG plot-spec and
// render.js -> toSVG() produces a self-contained <svg> string. So the plot
// descriptors here carry `mime:"image/svg+xml"` and a ".svg" filename (the R
// basename otherwise preserved). To reproduce R's PNG byte-for-byte in a
// browser, draw the returned SVG onto a <canvas> (set an <img> src to a
// data:image/svg+xml URL of `content`, drawImage, then canvas.toBlob(...,
// "image/png")); in Node use resvg/sharp. That rasterisation is a host
// concern and deliberately out of scope for this dependency-free layer.
// ============================================================================

const { writeCsv, writeRwl } = require('./load.js');
const { toSVG } = require('../viz/render.js');

// ---- date -> R Sys.Date() ISO "YYYY-MM-DD" ---------------------------------
function rdate(date) {
  if (date == null) date = new Date();
  if (typeof date === 'string') return date;          // assume already ISO
  const d = date instanceof Date ? date : new Date(date);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- filename patterns (mirror the RingServer paste(..., sep="") handlers) --
// Data/RWL names keep R's exact strings. Plot names keep the R basename but end
// in .svg (see PNG vs SVG note above).
const FILENAMES = {
  // --- CSV / RWL data artifacts ---
  rawUndatedCsv:          d => `Undated_compiled_data_${d}.csv`, // download_undated_raw
  detrendedCsv:           d => `detrended_data_${d}.csv`,        // download_detrend
  crossDatResCsv:         d => `RingdateR_crossdates_${d}.csv`,  // full (unfiltered) cross_dat_res
  filteredCrossdatesCsv:  d => `RingdateR_results_${d}.csv`,     // pairwise_res_download ([,-5])
  meanChronologyCsv:      d => `mean_chronology${d}.csv`,        // initiated_two_column
  alignedChronCsv:        d => `detrended_chrono${d}.csv`,       // initiated.chrono.detrend
  alignedChronRawCsv:     d => `data-${d}.csv`,                  // initiate.chrono.raw
  undatedSeriesCsv:       d => `undated_series_${d}.csv`,        // remove_initiated_series
  alignedChronRwl:        d => `updated_chronology_${d}.rwl`,    // create_initiated_chron_rwl
  // --- plots (R emitted .png; we emit .svg) ---
  detrendedSeriesPlot:    d => `detrended_Series_plot-${d}.svg`, // downloadsingplt
  pairwiseLinePlot:       d => `Pairwise_line_plot${d}.svg`,     // pair_plot_download
  smallHeatmap:           d => `Small_Pairwise_heat_map-${d}.svg`, // pair_small_hm_downlaod
  pairwiseBarPlot:        d => `Pairwise_bar_graph-${d}.svg`,    // pair_bar_plot_download
  fullHeatmap:            d => `Full_pairwise_heatmap${d}.svg`,  // downloadsinghtmp
};

// ---- descriptor factories --------------------------------------------------
function csvDescriptor(frame, filename) {
  return { filename, mime: 'text/csv', content: writeCsv(frame) };
}
function rwlDescriptor(frame, filename, opts) {
  return { filename, mime: 'text/plain', content: writeRwl(frame, opts || {}) };
}
function svgDescriptor(spec, filename) {
  return { filename, mime: 'image/svg+xml', content: toSVG(spec) };
}

// drop a single column (0-based) from a Frame — R's df[,-(i+1)].
function dropCol(frame, i) {
  return {
    names: frame.names.filter((_, c) => c !== i),
    cols: frame.cols.filter((_, c) => c !== i),
  };
}
// keep the first n columns — used to peel the two-column mean chronology.
function firstCols(frame, n) {
  return {
    names: frame.names.slice(0, n),
    cols: frame.cols.slice(0, n).map(c => c.slice()),
  };
}

// ---- individual artifact helpers (each -> one descriptor) ------------------
// CSV/RWL helpers take the relevant Frame; plot helpers take a plot SPEC (the
// object a viz builder returns). All take { date } (+ RWL precision).
function rawUndatedCsv(undated, o = {})        { return csvDescriptor(undated, FILENAMES.rawUndatedCsv(rdate(o.date))); }
function detrendedCsv(detrended, o = {})       { return csvDescriptor(detrended, FILENAMES.detrendedCsv(rdate(o.date))); }
function crossDatResCsv(crossDatRes, o = {})   { return csvDescriptor(crossDatRes, FILENAMES.crossDatResCsv(rdate(o.date))); }
function undatedSeriesCsv(frame, o = {})       { return csvDescriptor(frame, FILENAMES.undatedSeriesCsv(rdate(o.date))); }
function meanChronologyCsv(twoCol, o = {})     { return csvDescriptor(twoCol, FILENAMES.meanChronologyCsv(rdate(o.date))); }
function alignedChronCsv(aligned, o = {})      { return csvDescriptor(aligned, FILENAMES.alignedChronCsv(rdate(o.date))); }
function alignedChronRawCsv(aligned, o = {})   { return csvDescriptor(aligned, FILENAMES.alignedChronRawCsv(rdate(o.date))); }
// R: write.csv(interseries_filt()[,-5]) — drop the 5th column ('col').
function filteredCrossdatesCsv(filtered, o = {}) {
  return csvDescriptor(dropCol(filtered, 4), FILENAMES.filteredCrossdatesCsv(rdate(o.date)));
}
function alignedChronRwl(aligned, o = {}) {
  return rwlDescriptor(aligned, FILENAMES.alignedChronRwl(rdate(o.date)), { precision: o.precision });
}

function detrendedSeriesPlotSvg(spec, o = {}) { return svgDescriptor(spec, FILENAMES.detrendedSeriesPlot(rdate(o.date))); }
function pairwiseLinePlotSvg(spec, o = {})    { return svgDescriptor(spec, FILENAMES.pairwiseLinePlot(rdate(o.date))); }
function smallHeatmapSvg(spec, o = {})        { return svgDescriptor(spec, FILENAMES.smallHeatmap(rdate(o.date))); }
function pairwiseBarPlotSvg(spec, o = {})     { return svgDescriptor(spec, FILENAMES.pairwiseBarPlot(rdate(o.date))); }
function fullHeatmapSvg(spec, o = {})         { return svgDescriptor(spec, FILENAMES.fullHeatmap(rdate(o.date))); }

// map a plot key -> its svg descriptor helper (used for caller-supplied specs).
const PLOT_HELPERS = {
  detrendedSeriesPlot: detrendedSeriesPlotSvg,
  pairwiseLinePlot: pairwiseLinePlotSvg,
  smallHeatmap: smallHeatmapSvg,
  pairwiseBarPlot: pairwiseBarPlotSvg,
  fullHeatmap: fullHeatmapSvg,
};

// ---- buildDownloads --------------------------------------------------------
// Take a workflow result bundle (pairwiseWorkflow / chronologyWorkflow output,
// optionally carrying `undated`) and return every download descriptor that can
// be derived from it, keyed by artifact:
//
//   { detrendedCsv, crossDatResCsv, filteredCrossdatesCsv, alignedChronCsv,
//     alignedChronRwl, meanChronologyCsv?, rawUndatedCsv?, <plotKey>? }
//
// Options: { date, precision, plots }. `plots` lets a host inject already-built
// plot SPECS ({ pairwiseLinePlot: spec, ... }); each is stamped with the R
// filename and returned as an SVG descriptor. Data descriptors are always built
// from the Frames; plot descriptors are only present when a usable spec exists.
function buildDownloads(results, opts = {}) {
  const results_ = results || {};
  const date = opts.date;
  const out = {};

  if (results_.undated)     out.rawUndatedCsv         = rawUndatedCsv(results_.undated, { date });
  if (results_.detrended)   out.detrendedCsv          = detrendedCsv(results_.detrended, { date });
  if (results_.crossDatRes) out.crossDatResCsv        = crossDatResCsv(results_.crossDatRes, { date });
  if (results_.filtered)    out.filteredCrossdatesCsv = filteredCrossdatesCsv(results_.filtered, { date });
  if (results_.aligned) {
    out.alignedChronCsv = alignedChronCsv(results_.aligned, { date });
    out.alignedChronRwl = alignedChronRwl(results_.aligned, { date, precision: opts.precision });
  }
  // chronology mode: the two-column mean chronology is cols [year, mean_*] of
  // chron_n_undated (comb.NA(meanChron, undated)); mirrors initiated_two_column.
  if (results_.chronNSeries && results_.chronNSeries.cols.length >= 2) {
    out.meanChronologyCsv = meanChronologyCsv(firstCols(results_.chronNSeries, 2), { date });
  }

  // Plot descriptors: prefer caller-supplied specs; otherwise best-effort auto-
  // build the two self-contained pairwise plots from the aligned block. Each is
  // guarded so an un-buildable plot is simply omitted (never throws the export).
  const specs = Object.assign({}, opts.plots);
  if (!specs.pairwiseLinePlot && results_.aligned) {
    tryAdd(() => require('../viz/linePlot.js').linePlot(
      results_.aligned, results_.aligned.names[1], results_.aligned.names[2], 0),
      s => { specs.pairwiseLinePlot = s; });
  }
  if (!specs.pairwiseBarPlot && results_.masterLeadLag && results_.aligned) {
    tryAdd(() => require('../viz/leadLagBar.js').leadLagBar(
      results_.masterLeadLag, results_.aligned.names[1], results_.aligned.names[2]),
      s => { specs.pairwiseBarPlot = s; });
  }
  for (const key of Object.keys(PLOT_HELPERS)) {
    if (specs[key]) out[key] = PLOT_HELPERS[key](specs[key], { date });
  }

  return out;
}

// run fn(); on success call ok(result); swallow any throw (defensive plotting).
function tryAdd(fn, ok) {
  try { const r = fn(); if (r) ok(r); } catch (_) { /* plot not buildable */ }
}

module.exports = {
  buildDownloads,
  // descriptor factories
  csvDescriptor, rwlDescriptor, svgDescriptor,
  // data artifacts
  rawUndatedCsv, detrendedCsv, crossDatResCsv, filteredCrossdatesCsv,
  meanChronologyCsv, alignedChronCsv, alignedChronRawCsv, undatedSeriesCsv,
  alignedChronRwl,
  // plot artifacts
  detrendedSeriesPlotSvg, pairwiseLinePlotSvg, smallHeatmapSvg,
  pairwiseBarPlotSvg, fullHeatmapSvg,
  // helpers/tables
  FILENAMES, rdate, dropCol, firstCols,
};
