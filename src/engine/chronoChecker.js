'use strict';
// ============================================================================
// chronoCheck — headless workflow for the RingdateR "Quick Chronology Checker"
// (a pure-function port of the server logic in R/chrono_checker_app.R).
//
// WHAT IT DOES (mirrors chrono_check_server, observeEvent(input$analyze)):
//   1. Take a loaded CSV chronology Frame: column 0 = years, columns 1..n =
//      samples (date-aligned).
//   2. The user selects ONE sample (by name) and a manual integer `lag`.
//   3. The selected sample's years are shifted by `lag`, then it is spline-
//      detrended (normalise, detrending_select = 3, splinewindow).
//   4. The REMAINING samples are spline-detrended and reduced to a biweight
//      mean chronology (dplR::chron -> the "std" column).
//   5. `combined` = data.frame(year, mean_chronology, <selected sample>).
//   6. Three plot-data pipelines are run on `combined`:
//        line_plot        overlay of chronology (black) vs sample (red, lagged)
//        lead_lag_bar     from lead_lag_analysis(mode 1, complete = TRUE)
//        heatmap_analysis running-correlation raster (win 21, +-10 about lag)
//
// R app calls, reproduced exactly:
//   sel_sample[,1] <- sel_sample[,1] + lag
//   sel_sample     <- normalise(sel_sample, 3, splinewindow)
//   det_chron_data <- normalise(df[,-selCol], 3, splinewindow)
//   chrono         <- chron(det_chron_data[,-1])                 # std column
//   combined       <- cbind(chrono[years,std], sel_sample[,2])
//   cor_res        <- lead_lag_analysis(combined, mode=1, neg=-20+lag,
//                                       pos=20+lag, complete=TRUE)
//   plot1 <- line_plot(combined, "mean_chronology", <sel>, lag = lag)
//   plot2 <- lead_lag_bar(cor_res[[2]], "mean_chronology", <sel>)
//   plot3 <- heatmap_analysis(combined, "mean_chronology", <sel>,
//                             neg=-10+lag, pos=10+lag, win=21, complete=FALSE)
//
// NOTE on the year shift: normalise() carries the year column through untouched
// and the spline detrend is index-based, so shifting sel_sample's years does
// NOT change the detrended VALUES — the lag is applied downstream by line_plot /
// lead_lag / heatmap. The shift is reproduced faithfully regardless.
//
// Returns the plot SPECS (feed to renderSvg) + the plotted DATA + the summary
// table, plus the intermediate Frames (combined / masterLeadLag / heatmapData)
// so every artifact can be diffed against R (test/chrono_checker_test.js).
// ============================================================================

const C = require('../analysis/comb.js');
const { normalise } = require('../detrend/normalise.js');
const { chron } = require('../stats/chron.js');
const { leadLag } = require('../analysis/leadLag.js');
const { heatmapAnalysis } = require('../analysis/heatmap.js');
const { linePlot } = require('../viz/linePlot.js');
const { heatmapPlot } = require('../viz/heatmapPlot.js');
const { leadLagBar } = require('../viz/leadLagBar.js');

// Per-sample start/end year summary (R's summary_df: Column_Name/Start/End).
// Start = min year where the sample is non-NA; End = max such year.
function summaryTable(frame) {
  const year = frame.cols[0];
  const names = [], start = [], end = [];
  for (let c = 1; c < C.ncol(frame); c++) {
    const s = frame.cols[c];
    let mn = Infinity, mx = -Infinity, any = false;
    for (let r = 0; r < s.length; r++) {
      if (!C.isNA(s[r]) && !C.isNA(year[r])) { any = true; const y = +year[r]; if (y < mn) mn = y; if (y > mx) mx = y; }
    }
    names.push(frame.names[c]);
    start.push(any ? mn : C.NA);
    end.push(any ? mx : C.NA);
  }
  return { names: ['Column_Name', 'Start_Year', 'End_Year'], cols: [names, start, end] };
}

// ---------------------------------------------------------------------------
// chronoCheck({ frame, selected, lag, splinewindow })
//   frame        Frame  loaded CSV chronology (col 0 = years, rest = samples)
//   selected     string sample column name to check (must exist in frame.names)
//   lag          int    manual lag applied to the selected sample
//   splinewindow number spline detrending window (default 21)
// ---------------------------------------------------------------------------
function chronoCheck(input) {
  const { frame } = input;
  const selected = input.selected;
  const lag = input.lag != null ? input.lag : 0;
  const splinewindow = input.splinewindow != null ? input.splinewindow : 21;

  if (!frame || !Array.isArray(frame.names) || !Array.isArray(frame.cols)) {
    throw new Error('chronoCheck: frame must be a valid Frame {names, cols}');
  }
  if (lag % 1 !== 0) throw new Error('chronoCheck: lag should be a numeric integer.');
  const selCol = frame.names.indexOf(selected);
  if (selCol < 1) throw new Error('chronoCheck: selected sample "' + selected + '" not found among the chronology samples.');

  const years = frame.cols[0];

  // 1. selected sample: 2-col frame [year+lag, value] -> spline detrend --------
  const selFrame = {
    names: [frame.names[0], selected],
    cols: [years.map(y => (C.isNA(y) ? C.NA : +y + lag)), frame.cols[selCol].slice()],
  };
  const selDet = normalise(selFrame, { detrending_select: 3, splinewindow });
  // sel_sample[,2] — the detrended value column of the selected sample
  const detrendedSample = { names: selDet.names.slice(), cols: [selDet.cols[0].slice(), selDet.cols[1].slice()] };

  // 2. remaining samples: drop selected column -> spline detrend ---------------
  const rawChron = {
    names: frame.names.filter((_, i) => i !== selCol),
    cols: frame.cols.filter((_, i) => i !== selCol),
  };
  const detChron = normalise(rawChron, { detrending_select: 3, splinewindow });
  const chronYears = detChron.cols[0];                 // = df[,1] (row names in R)

  // 3. biweight mean chronology from the detrended remaining samples -----------
  const detChronSeries = { names: detChron.names.slice(1), cols: detChron.cols.slice(1) };
  const ch = chron(detChronSeries);                    // dplR::chron -> std, samp.depth
  const chronology = { names: ['year', 'mean_chronology'], cols: [chronYears.slice(), ch.cols[0].slice()] };

  // 4. combined <- cbind(chronology, selected detrended value) -----------------
  const combined = {
    names: ['year', 'mean_chronology', selected],
    cols: [chronYears.slice(), ch.cols[0].slice(), selDet.cols[1].slice()],
  };

  // 5. lead-lag analysis (mode 1, complete = TRUE — neg/pos lag ignored) --------
  const { masterLeadLag } = leadLag(combined, {
    mode: 1, neg_lag: -20 + lag, pos_lag: 20 + lag, complete: true,
  });

  // 6. running-correlation heatmap data (win 21, +-10 about the lag) -----------
  const heatmapData = heatmapAnalysis(combined, {
    s1: 'mean_chronology', s2: selected,
    neg_lag: -10 + lag, pos_lag: 10 + lag, win: 21, center: 0, complete: false,
  });

  // 7. plot specs (each ready for renderSvg) -----------------------------------
  const linePlotSpec = linePlot(combined, 'mean_chronology', selected, lag);
  const leadLagBarSpec = leadLagBar(masterLeadLag, 'mean_chronology', selected);
  const heatmapSpec = heatmapPlot(heatmapData, { s1: 'mean_chronology', s2: selected });

  return {
    detrendedSample,       // Frame {names:[year, sel], cols:[year+lag, detrended values]}
    chronology,            // Frame {year, mean_chronology}  (biweight mean of the rest)
    chronoDepth: ch.cols[1].slice(), // dplR::chron samp.depth (per-row non-NA count)
    combined,              // Frame {year, mean_chronology, sel}  (the R `combined`)
    summaryTable: summaryTable(frame),
    masterLeadLag,         // full lead_lag_analysis master grid for the pair
    heatmapData,           // running_lead_lag {year, lag, "R val"} (or null)
    linePlotSpec, heatmapSpec, leadLagBarSpec,
  };
}

module.exports = { chronoCheck, summaryTable };
