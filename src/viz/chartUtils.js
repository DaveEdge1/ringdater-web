'use strict';
// ============================================================================
// Shared visualization utilities, ports of four ringdater R helpers:
//   x.scale.bar   -> xScaleBar    (R/x_scale_bar_function.R)
//   y.scale.bar   -> yScaleBar    (R/y_scale_bar_function.R)
//   col_pal       -> colPal       (R/col_pal_function.R)
//   R_dateR_theme -> rDateRTheme  (R/R_dateR_theme_function.R)
//
// R is the oracle. xScaleBar/yScaleBar/colPal reproduce R exactly (validated
// in test/chartutils_test.js). rDateRTheme is a ggplot theme; there is no
// numeric R-parity target, so it is ported to a plain style-config object that
// documents the meaningful ggplot::theme() -> web-style mapping.
// ============================================================================

// ---- base R seq(from, to, by) ----------------------------------------------
// Faithful port of base R's seq.default when `by` is supplied, including the
// integer fuzz on the step count and the final pmin/pmax overshoot clamp.
function rSeqBy(from, to, by) {
  const del = to - from;
  // R: n <- as.integer(n + 1e-10); as.integer() truncates toward zero.
  const n = Math.trunc(del / by + 1e-10);
  const out = new Array(n + 1);
  for (let i = 0; i <= n; i++) {
    let x = from + i * by;
    // R: if (by > 0) pmin(x, to) else pmax(x, to)  -- correct for fp overshoot
    x = by > 0 ? Math.min(x, to) : Math.max(x, to);
    out[i] = x;
  }
  return out;
}

// ---- x.scale.bar -----------------------------------------------------------
// Bucketed axis tick breaks for the x-axis. Step chosen by span magnitude.
function xScaleBar(xMin, xMax) {
  if (typeof xMin !== 'number') {
    throw new Error('Error in x.scale.bar: x.min is not a numeric integer');
  }
  if (typeof xMax !== 'number') {
    throw new Error('Error in x.scale.bar: x.miax is not a numeric integer');
  }
  if (xMax <= xMin) {
    throw new Error('Errpr in x.scale.bar: x.max must be greater than x.min');
  }
  const span = xMax - xMin;
  let by;
  if (span > 1000) by = 100;
  else if (span > 500) by = 50;
  else if (span > 100) by = 20;
  else if (span > 50) by = 10;
  else if (span > 20) by = 5;
  else by = 2;
  return rSeqBy(xMin, xMax, by);
}

// ---- y.scale.bar -----------------------------------------------------------
// Bucketed axis tick breaks for the y-axis. NOTE: differs from x.scale.bar at
// the mid buckets -- y switches to by=20 at span>250 (x switches at span>100).
function yScaleBar(yMin, yMax) {
  if (typeof yMin !== 'number') {
    throw new Error('Error in y.scale.bar: y.min is not a numeric integer');
  }
  if (typeof yMax !== 'number') {
    throw new Error('Error in y.scale.bar: y.miax is not a numeric integer');
  }
  if (yMax <= yMin) {
    throw new Error('Error in y.scale.bar: y.max must be great than y.min');
  }
  const span = yMax - yMin;
  let by;
  if (span > 1000) by = 100;
  else if (span > 500) by = 50;
  else if (span > 250) by = 20;
  else if (span > 50) by = 10;
  else if (span > 20) by = 5;
  else by = 2;
  return rSeqBy(yMin, yMax, by);
}

// ---- col_pal ---------------------------------------------------------------
// Hardcoded hex colour ramps for the RingdateR heatmaps. The (uneven) repeated
// stops shift where white sits on the gradient:
//   1 = blue -> white -> red   (diverging)
//   2 = white -> red           (white held over the first half)
//   3 = white -> blue          (white held over the first three fifths)
//   4 = white -> black         (white held over the first half)
const COL_PAL = {
  1: ['#4575b4', '#e0f3f8', '#d73027'],
  2: ['#ffffff', '#ffffff', '#ca0020'],
  3: ['#ffffff', '#ffffff', '#ffffff', '#0571b0', '#00216d'],
  4: ['#ffffff', '#ffffff', '#000000'],
};
function colPal(colourScale = 1) {
  if (![1, 2, 3, 4].includes(colourScale)) {
    throw new Error('Error in col_pal(). colour_scale must be a numeric from 1 to 4.');
  }
  return COL_PAL[colourScale].slice();
}

// ---- R_dateR_theme ---------------------------------------------------------
// The R original is a ggplot2 theme() object. Ported here as a plain style
// config capturing every meaningful parameter so a JS plotting layer can
// reproduce the look. Values map 1:1 to the ggplot theme elements:
//   panel.background = element_blank()            -> panel.background = 'none'
//   axis.line/axis.ticks (colour black, linewidth)-> axis line/tick color+width
//   axis.ticks.length = unit(.25,'cm')            -> tickLength ('0.25cm')
//   panel.grid.major (grey, 0.5, 'dashed')        -> gridMajor
//   legend.position = 'bottom'                    -> legend.position
//   legend.key.width = unit(leg_size,'cm')        -> legend.keyWidth ('<leg_size>cm')
//   plot.margin = margin(10,0,0,l)                -> plotMargin (T,R,B,L, px)
//   axis.title.y margin(0,20,10,l)                -> axisTitleY.margin
function rDateRTheme(opts = {}) {
  const { text_size = 12, line_width = 1, l = 10, leg_size = 3 } = opts;
  if (typeof text_size !== 'number' || text_size <= 0) {
    throw new Error('Warning: an error occurred in R_dateR_theme: text_size was not a numeric value > 0');
  }
  if (typeof line_width !== 'number' || line_width <= 0) {
    throw new Error('Warning: an error occurred in R_dateR_theme: line_width was not a numeric value > 0');
  }
  if (typeof leg_size !== 'number' || leg_size <= 0) {
    throw new Error('Warning: an error occurred in R_dateR_theme: leg_size was not a numeric value > 0');
  }
  if (typeof l !== 'number') {
    throw new Error('Warning: an error occurred in R_dateR_theme: l (left margin) was not a numeric value');
  }
  return {
    text: { size: text_size },
    panel: { background: 'none' },
    axis: {
      line: { color: 'black', width: line_width },
      ticks: { color: 'black', width: line_width },
      tickLength: '0.25cm',
      text: { size: text_size, color: 'black' },
      titleY: { size: text_size, margin: { t: 0, r: 20, b: 10, l } }, // px
    },
    gridMajor: { color: 'grey', width: 0.5, lineType: 'dashed' },
    gridMinor: { color: 'none' },
    legend: {
      position: 'bottom',
      key: { borderWidth: 1 },
      keyWidth: `${leg_size}cm`,
      text: { size: text_size },
    },
    plotMargin: { t: 10, r: 0, b: 0, l }, // px, ggplot margin(T,R,B,L)
  };
}

module.exports = { xScaleBar, yScaleBar, colPal, rDateRTheme };
