'use strict';
// ringdater-js: JS port of the numeric core + analysis layer of dplR/ringdater
// (crossdating). Every function is validated against R via tools/*.R + test/*.

// ---- dplR numeric core (bit-exact / bit-close vs R) ------------------------
const { caps, detrendSpline } = require('./spline.js');
const { whitenSeries } = require('./prewhiten.js');
const { modNegExp, modHugershoff } = require('./curvefit.js');
const { supsmu, friedman } = require('./supsmu.js');
const { rwiStatsRunning, rBarEps: rwiRBarEps } = require('./rwi_stats.js');
const { corrRwlSeg } = require('./corr_rwl_seg.js');

// ---- shared contract + stats helpers ---------------------------------------
const comb = require('./analysis/comb.js');                 // Frame contract + comb.NA
const { pearsonCorTest } = require('./stats/cortest.js');   // Pearson cor.test

// ---- detrending -------------------------------------------------------------
const { normalise } = require('./detrend/normalise.js');
const { detcurves } = require('./detrend/detcurves.js');

// ---- analysis (ringdater's own crossdating logic) --------------------------
const { autoCorrel } = require('./analysis/autoCorrel.js');
const { rollcor } = require('./analysis/rollcor.js');
const { leadLag } = require('./analysis/leadLag.js');
const { runningLeadLag } = require('./analysis/runningLeadLag.js');
const { heatmapAnalysis } = require('./analysis/heatmap.js');
const { filterCrossdates } = require('./analysis/filterCrossdates.js');
const { alignSeries, alignToChron, ontoAlignDated } = require('./analysis/align.js');
const { correlReplace } = require('./analysis/correlReplace.js');
const { removeSeries } = require('./analysis/removeSeries.js');
const { RingdateR_error_message } = require('./analysis/errorMessage.js');
const { nameCheck, loadedDataCheck, pairwiseDataCheck } = require('./analysis/checks.js');

// ---- chronology stats (wrappers over the dplR core) ------------------------
const { probCheck } = require('./stats/probCheck.js');
const { rBarEps } = require('./stats/rBarEps.js');

// ---- IO: parsers, loaders, writers (Phase 2) -------------------------------
const io = require('./io/load.js');
const { parseDelimited } = require('./io/csv.js');
const { readXlsx } = require('./io/xlsx.js');
const year = require('./io/year.js');

// ---- visualization (Phase 4): utilities + 6 plot builders ------------------
const { xScaleBar, yScaleBar, colPal, rDateRTheme } = require('./viz/chartUtils.js');
// ---- orchestration engine (Phase 3): store + actions + workflows ----------
const { createStore } = require('./engine/store.js');
const engineActions = require('./engine/actions.js');
const { pairwiseWorkflow, chronologyWorkflow } = require('./engine/workflows.js');
const { createBuilder } = require('./engine/builder.js');

// ---- downloads + report (Phase 5) ------------------------------------------
const { buildDownloads } = require('./io/downloads.js');
const { renderReport } = require('./report.js');

// ---- chrono_checker second app (Phase 7) -----------------------------------
const { chron } = require('./stats/chron.js');
const { chronoCheck } = require('./engine/chronoChecker.js');

const { linePlot } = require('./viz/linePlot.js');
const { datedLinePlot } = require('./viz/datedLinePlot.js');
const { allSeries } = require('./viz/allSeries.js');
const { heatmapPlot } = require('./viz/heatmapPlot.js');
const { detrendPlot } = require('./viz/detrendPlot.js');
const { leadLagBar } = require('./viz/leadLagBar.js');
const { skelPlot } = require('./viz/skelPlot.js');
const { skelValues, hanning } = require('./analysis/skel.js');
const renderSvg = require('./viz/render.js').toSVG;

module.exports = {
  // Frame data-shape contract (build/join/slice ring-width tables)
  Frame: comb,
  frame: comb.frame, asFrame: comb.asFrame, combNA: comb.combNA,

  // dplR numeric core
  caps, detrendSpline, whitenSeries, modNegExp, modHugershoff,
  supsmu, friedman, rwiStatsRunning, corrRwlSeg,

  // detrending
  normalise, detcurves,

  // crossdating analysis
  pearsonCorTest, autoCorrel, rollcor,
  leadLag, runningLeadLag, heatmapAnalysis,
  filterCrossdates, alignSeries, alignToChron, ontoAlignDated,
  correlReplace, removeSeries,

  // chronology stats
  probCheck, rBarEps,

  // validation / cleaning / messaging
  nameCheck, loadedDataCheck, pairwiseDataCheck, RingdateR_error_message,

  // IO — loading (extension-dispatched), format parsers, writers
  loadUndated: io.loadUndated, loadChron: io.loadChron,
  loadDataTabs: io.loadDataTabs, ldUndatedChron: io.ldUndatedChron,
  loadPos: io.loadPos, loadLps: io.loadLps, readRWL: io.readRWL, readCrn: io.readCrn,
  loadRingMeasurer: io.loadRingMeasurer, combineRMFiles: io.combineRMFiles,
  parseDelimited, readXlsx, writeRwl: io.writeRwl, writeCsv: io.writeCsv,
  // per-series metadata side-channel + calendar (AD/BC, no year 0)
  emptySeriesMeta: io.emptySeriesMeta, normalizeSeriesMeta: io.normalizeSeriesMeta,
  ensureMeta: io.ensureMeta, META_EDITABLE: io.META_EDITABLE,
  astroToCal: year.astroToCal, calToAstro: year.calToAstro, formatCal: year.formatCal,
  readTridas: io.readTridas, writeTridas: io.writeTridas,

  // visualization: utilities, 7 plot builders (each returns a spec; renderSvg -> SVG string)
  xScaleBar, yScaleBar, colPal, rDateRTheme,
  linePlot, datedLinePlot, allSeries, heatmapPlot, detrendPlot, leadLagBar, skelPlot, renderSvg,
  skelValues, hanning,

  // orchestration engine: headless workflows + reactive store/actions (the "server")
  pairwiseWorkflow, chronologyWorkflow, createStore, engineActions,
  // interactive iterative chronology builder (manual, one-series-at-a-time)
  createBuilder,

  // downloads (artifact descriptors) + HTML run report
  buildDownloads, renderReport,

  // chrono_checker second app + dplR::chron
  chron, chronoCheck,
};
