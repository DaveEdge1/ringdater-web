'use strict';
// ============================================================================
// heatmap_analysis — data generator for the running-correlation heatmap (port
// of the DATA step of R/heatmap_analysis_function.R).
//
// In R, heatmap_analysis() builds `plot.data` and hands it to plotting_sing_hm()
// which returns a ggplot object. The only DATA it produces is that plot.data:
//
//   plot.data <- running_lead_lag(the_data, s1, s2,
//                                 neg_lag = neg_lag + center,
//                                 pos_lag = pos_lag + center,
//                                 win = win, complete = complete)
//
// So this function reproduces plot.data exactly: it offsets the lag limits by
// `center` and delegates to runningLeadLag. Returns the {year, lag, "R val"}
// Frame (the x/y/fill of the heatmap raster) or null when overlap is too small.
// ============================================================================

const { runningLeadLag } = require('./runningLeadLag.js');

function heatmapAnalysis(frame, opts = {}) {
  const negLag = opts.neg_lag != null ? opts.neg_lag : -20;
  const posLag = opts.pos_lag != null ? opts.pos_lag : 20;
  const center = opts.center != null ? opts.center : 0;

  return runningLeadLag(frame, {
    s1: opts.s1,
    s2: opts.s2,
    neg_lag: negLag + center,
    pos_lag: posLag + center,
    win: opts.win != null ? opts.win : 21,
    complete: opts.complete != null ? opts.complete : true,
  });
}

module.exports = { heatmapAnalysis };
