'use strict';
// Unit tests for src/io/year.js — the AD/BC (no year 0) calendar convention.
const { astroToCal, calToAstro, formatCal } = require('../src/io/year.js');

let ok = true;
function check(name, cond, why) {
  if (!cond) ok = false;
  console.log(name.padEnd(40), cond ? 'PASS' : 'FAIL', cond ? '' : ' <- ' + (why || ''));
}
function eqCal(a, b) { return a.year === b.year && a.suffix === b.suffix; }

// --- boundary mapping: internal 0 = 1 BC, 1 = 1 AD, -1 = 2 BC ----------------
check('astro 1 -> 1 AD', eqCal(astroToCal(1), { year: 1, suffix: 'AD' }));
check('astro 0 -> 1 BC', eqCal(astroToCal(0), { year: 1, suffix: 'BC' }));
check('astro -1 -> 2 BC', eqCal(astroToCal(-1), { year: 2, suffix: 'BC' }));
check('astro 1450 -> 1450 AD', eqCal(astroToCal(1450), { year: 1450, suffix: 'AD' }));
check('astro -99 -> 100 BC', eqCal(astroToCal(-99), { year: 100, suffix: 'BC' }));

check('cal 1 AD -> 1', calToAstro(1, 'AD') === 1);
check('cal 1 BC -> 0', calToAstro(1, 'BC') === 0);
check('cal 2 BC -> -1', calToAstro(2, 'BC') === -1);
check('cal default suffix is AD', calToAstro(753) === 753);
check('cal lowercase suffix ok', calToAstro(44, 'bc') === -43);

// --- round-trip invariant over a range that straddles the boundary -----------
let rt = true;
for (let y = -500; y <= 500; y++) {
  const c = astroToCal(y);
  if (calToAstro(c.year, c.suffix) !== y) { rt = false; break; }
  if (c.year < 1) rt = false;                 // no calendar year 0 ever produced
}
check('round-trip -500..500 (no year 0)', rt);

// --- formatting ---------------------------------------------------------------
check('format 0 -> "1 BC"', formatCal(0) === '1 BC');
check('format 2024 -> "2024 AD"', formatCal(2024) === '2024 AD');

// --- guards -------------------------------------------------------------------
let threw = false; try { calToAstro(0, 'AD'); } catch (e) { threw = true; }
check('calToAstro rejects year 0', threw);
threw = false; try { calToAstro(5, 'CE'); } catch (e) { threw = true; }
check('calToAstro rejects bad suffix', threw);

console.log(ok ? '\nYEAR PASS' : '\nYEAR FAIL');
process.exit(ok ? 0 : 1);
