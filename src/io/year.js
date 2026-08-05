'use strict';
// ============================================================================
// Calendar-year conversion for the traditional dendrochronology convention:
// AD/BC with NO year zero.
//
// RingdateR's internal computation axis is a contiguous integer sequence
// (astronomical year numbering, which DOES have a year 0). Keeping the internal
// axis contiguous is what lets the chronology builder's year-keyed merge and
// integer offsets work without special-casing the BC/AD boundary
// (see src/engine/builder.js). This module confines the "no year 0" convention
// to the I/O and display boundary only.
//
//   internal (astronomical)      calendar (traditional)
//        ...  2                        2 AD
//             1                        1 AD
//             0            <->         1 BC
//            -1                        2 BC
//            -2                        3 BC   ...
//
// So there is no internal value that maps to "year 0" in calendar terms: the
// transition 0 <-> -1 is exactly the 1 BC <-> 2 BC step, and 0 <-> 1 is the
// 1 BC <-> 1 AD step. TRiDaS carries a `suffix="BC"|"AD"` on <firstYear> /
// <lastYear>; convert with calToAstro on read and astroToCal on write.
// ============================================================================

// internal astronomical int -> { year: >=1, suffix: 'AD'|'BC' }
function astroToCal(y) {
  const n = Math.trunc(Number(y));
  return n <= 0 ? { year: 1 - n, suffix: 'BC' } : { year: n, suffix: 'AD' };
}

// { year, suffix } -> internal astronomical int. year must be >= 1 (no year 0).
function calToAstro(year, suffix) {
  const yr = Math.trunc(Number(year));
  if (!(yr >= 1)) throw new Error('calToAstro: calendar year must be >= 1 (no year 0), got ' + year);
  const s = String(suffix == null ? 'AD' : suffix).toUpperCase();
  if (s !== 'AD' && s !== 'BC') throw new Error('calToAstro: suffix must be AD or BC, got ' + suffix);
  return s === 'BC' ? 1 - yr : yr;
}

// "12 BC" / "1450 AD" — display string for reports and dated plots.
function formatCal(y) {
  const c = astroToCal(y);
  return c.year + ' ' + c.suffix;
}

module.exports = { astroToCal, calToAstro, formatCal };
