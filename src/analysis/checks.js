'use strict';
// ============================================================================
// Data validation / cleaning checks, ports of three ringdater R functions:
//   name_check         -> nameCheck        (R/name_check_function.R)
//   loaded_data_check  -> loadedDataCheck  (R/loaded_data_check_function.R)
//   pairwise_data_check-> pairwiseDataCheck(R/pairwise_data_check_function.R)
//
// All three consume the shared `Frame` shape from ./comb.js (ordered named
// columns; first column = years/increment, rest = series; missing === null).
//
// R is the oracle; the string transforms below reproduce base R's make.names
// and make.unique exactly (validated in test/checks_test.js).
// ============================================================================

const { ncol, nrow, col, isNA, subsetRows } = require('./comb');

// ---- Frame guard ------------------------------------------------------------
// R's checks all begin with `if (class(the_data) != "data.frame") stop(...)`.
// A Frame is our data.frame analogue; anything else is "not a data.frame".
function isFrame(x) {
  return !!x && Array.isArray(x.names) && Array.isArray(x.cols);
}

// ============================================================================
// make.names / make.unique (base R) reproductions
// ============================================================================

// R's reserved words that make.names suffixes with "." (note: `...` and `..1`
// are NOT suffixed by make.names, confirmed against R).
const RESERVED = new Set([
  'if', 'else', 'repeat', 'while', 'function', 'for', 'in', 'next', 'break',
  'TRUE', 'FALSE', 'NULL', 'Inf', 'NaN', 'NA',
  'NA_integer_', 'NA_real_', 'NA_complex_', 'NA_character_',
]);

// A "letter" per R's isalnum in a UTF-8 locale is any Unicode letter; a "digit"
// is ASCII 0-9 (iswdigit). Valid name chars (allow_ = TRUE): letters, digits,
// '.', '_'. Everything else is translated to '.'.
const RE_LETTER = /\p{L}/u;
function isLetter(ch) { return RE_LETTER.test(ch); }
function isDigit(ch) { return ch >= '0' && ch <= '9'; }
function isValidChar(ch) { return isLetter(ch) || isDigit(ch) || ch === '.' || ch === '_'; }

// make.names for a single element (input already a JS string; NA handled by
// caller). Order matters: the "X" prefix decision uses the RAW first character
// (before invalid chars are translated to '.'), matching R exactly -- e.g.
// "-a" -> "X.a" (raw '-' invalid start) but ".foo" -> ".foo".
function makeNameOne(s) {
  if (s == null) return 'NA.';
  const chars = Array.from(String(s)); // iterate by code point
  // prefix decision from the raw first character
  let needPrefix = false;
  if (chars.length === 0) {
    needPrefix = true;
  } else {
    const c0 = chars[0];
    if (isLetter(c0)) {
      needPrefix = false;
    } else if (c0 === '.') {
      // valid unless '.' is followed by a digit
      needPrefix = chars.length >= 2 && isDigit(chars[1]);
    } else {
      needPrefix = true; // digit, '_', or any other char
    }
  }
  // translate: invalid chars -> '.'
  let out = '';
  for (const ch of chars) out += isValidChar(ch) ? ch : '.';
  if (needPrefix) out = 'X' + out;
  if (RESERVED.has(out)) out += '.';
  return out;
}

// make.unique(names, sep=".") -- exact port of base R's algorithm:
//  * every name present in the ORIGINAL vector is reserved up-front;
//  * each duplicate (2nd+ occurrence) gets base+sep+k for the smallest k that
//    is not already used (used = all original names + all names assigned so far);
//  * the per-base counter k persists across duplicates of that base.
function makeUnique(names, sep = '.') {
  const n = names.length;
  const used = new Set(names);      // all original names are reserved
  const counter = new Map();        // base -> last used suffix number
  const seenFirst = new Set();      // bases whose first occurrence has passed
  const result = names.slice();
  for (let i = 0; i < n; i++) {
    const nm = names[i];
    if (!seenFirst.has(nm)) {
      // first occurrence: keep as-is
      seenFirst.add(nm);
      continue;
    }
    // duplicate
    let k = counter.get(nm) || 0;
    let cand;
    do { k += 1; cand = nm + sep + k; } while (used.has(cand));
    counter.set(nm, k);
    result[i] = cand;
    used.add(cand);
  }
  return result;
}

// make.names(x, unique=TRUE)
function makeNames(names) {
  return makeUnique(names.map(makeNameOne));
}

// ---- R string helpers for the "pretty" loop ---------------------------------
// substr(x, start, stop): 1-based inclusive, character (code point) based,
// clamped to the string bounds; returns "" if start > length or start > stop.
function rSubstr(s, start, stop) {
  const chars = Array.from(s);
  const from = Math.max(1, start);
  const to = Math.min(chars.length, stop);
  if (from > to) return '';
  return chars.slice(from - 1, to).join('');
}
function firstChar(s) { const a = Array.from(s); return a.length ? a[0] : ''; }
function nchar(s) { return Array.from(s).length; }

// ============================================================================
// nameCheck -- port of name_check
// ============================================================================
// Sanitises/dedupes the column (series) names of a Frame and returns a new
// Frame with the cleaned names (columns/data untouched).
function nameCheck(frame) {
  if (!isFrame(frame)) {
    throw new Error('Error in name_check: the_data is not a valid data.frame');
  }
  const oldNames = frame.names.slice();
  // make.names(unique=TRUE) then gsub("\\.","_")
  let newNames = makeNames(oldNames).map(s => s.replace(/\./g, '_'));
  // "Make them look pretty"
  for (let i = 0; i < oldNames.length; i++) {
    const oldN = oldNames[i];
    if (firstChar(oldN) !== firstChar(newNames[i])) {
      newNames[i] = 'ID_' + rSubstr(newNames[i], 2, nchar(oldN) + 1);
    }
    if (firstChar(oldN) === 'x') {
      newNames[i] = 'ID_' + rSubstr(newNames[i], 2, nchar(oldN) + 1);
    }
  }
  return { names: newNames, cols: frame.cols };
}

// ============================================================================
// loadedDataCheck -- port of loaded_data_check
// ============================================================================
// Returns an integer status code:
//   0 = no problems
//   1 = the first (year) column contains NA where a series has data
//   2 = a series is discontinuous within its own year range (interior NA)
function loadedDataCheck(frame) {
  if (!isFrame(frame)) {
    throw new Error(' Required data are not a data.frame');
  }
  if (ncol(frame) < 2) {
    throw new Error('Insufficient data');
  }
  const nc = ncol(frame);
  const nr = nrow(frame);
  const year = col(frame, 0);
  let prob = 0;
  for (let c = 1; c < nc; c++) {
    const series = col(frame, c);
    // rows where the series is not NA
    const idx = [];
    for (let r = 0; r < nr; r++) if (!isNA(series[r])) idx.push(r);
    // any NA in the year column among those rows?
    if (idx.some(r => isNA(year[r]))) { prob = 1; break; }
    // year range of the series (empty -> -Inf / Inf, matching R's max/min)
    let maxT = -Infinity, minT = Infinity;
    for (const r of idx) { const y = year[r]; if (y > maxT) maxT = y; if (y < minT) minT = y; }
    // within [minT, maxT] (NA year excluded), any NA in the series?
    let bad = false;
    for (let r = 0; r < nr; r++) {
      const y = year[r];
      if (!isNA(y) && y >= minT && y <= maxT && isNA(series[r])) { bad = true; break; }
    }
    if (bad) { prob = 2; break; }
  }
  return prob;
}

// ============================================================================
// pairwiseDataCheck -- port of pairwise_data_check
// ============================================================================
// R uses shinyalert (a side effect) for warnings and returns NULL on failure or
// the trimmed data.frame on success. We surface both as a result object:
//   { ok, code, title, message, data }
// where `data` is the trimmed Frame on success (ok:true) or null on failure,
// and `title`/`message` reproduce the exact shinyalert strings.
function pairwiseDataCheck(frame) {
  if (!isFrame(frame)) {
    throw new Error('Error in pairwise_data_check: the_data must be a data.frame.');
  }
  if (ncol(frame) < 2) {
    throw new Error('Error in pairwise_data_check: insufficient data in the_data.');
  }
  const year = col(frame, 0);
  // years[1] > years[2] (1-based) -> wrong direction
  if (year[0] > year[1]) {
    return {
      ok: false, code: 'direction', title: 'Warning!',
      message: 'Year Values in your data go in the wrong direction. Please fix this and reload the data',
      data: null,
    };
  }
  const test = loadedDataCheck(frame);
  if (test === 0) {
    const nc = ncol(frame);
    const nr = nrow(frame);
    const minDate = [], maxDate = [];
    for (let c = 1; c < nc; c++) {
      const series = col(frame, c);
      let mx = -Infinity, mn = Infinity;
      for (let r = 0; r < nr; r++) {
        const y = year[r];
        if (!isNA(y) && !isNA(series[r])) { if (y > mx) mx = y; if (y < mn) mn = y; }
      }
      maxDate.push(mx); minDate.push(mn);
    }
    const lo = Math.min(...minDate);
    const hi = Math.max(...maxDate);
    const data = subsetRows(frame, row => { const y = row[0]; return !isNA(y) && y >= lo && y <= hi; });
    return { ok: true, code: 0, title: null, message: null, data };
  } else if (test === 1) {
    return {
      ok: false, code: 1, title: 'Warning!',
      message: 'Check the data that was loaded, possible issue with your year column',
      data: null,
    };
  } else { // test === 2
    return {
      ok: false, code: 2, title: 'Warning!',
      message: 'Some of the data contain missing values',
      data: null,
    };
  }
}

module.exports = {
  nameCheck, loadedDataCheck, pairwiseDataCheck,
  // exposed for testing / reuse
  makeNames, makeUnique, makeNameOne,
};
