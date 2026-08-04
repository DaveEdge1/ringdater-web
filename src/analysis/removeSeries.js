'use strict';
// Port of ringdater::remove_series.
// Removes every column whose name matches an entry of `series_id` from a Frame.
// Names not present are silently skipped (matching the R NULL branch).

const { ncol } = require('./comb.js');

function removeSeries(the_data, series_id) {
  if (!the_data || !Array.isArray(the_data.names) || !Array.isArray(the_data.cols)) {
    throw new Error('Error in remove_series(). Required data are not a data.frame');
  }
  if (ncol(the_data) <= 2) {
    throw new Error('Error in remove_series(). In sufficient data loaded (loaded data < 2 cols).');
  }
  const ids = Array.isArray(series_id) ? series_id : [series_id];
  if (ids.length < 1) {
    throw new Error('Error in remove_series(). No series to remove.');
  }

  let names = the_data.names.slice();
  let cols = the_data.cols.slice();

  for (const id of ids) {
    const key = String(id);
    // remove ALL columns whose name equals this id (R's which(names %in% id))
    const keptNames = [], keptCols = [];
    for (let c = 0; c < names.length; c++) {
      if (names[c] !== key) { keptNames.push(names[c]); keptCols.push(cols[c]); }
    }
    names = keptNames;
    cols = keptCols;
  }

  return { names, cols };
}

module.exports = { removeSeries };
