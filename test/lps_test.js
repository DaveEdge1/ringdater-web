'use strict';
// Parity test for src/io/lps.js against R ringdater::load_lps ground truth.
const fs = require('fs'), path = require('path');
const { loadLps } = require('../src/io/lps.js');
const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'lps_gt.json'), 'utf8'));

function cellEq(a, b) {
  const an = a == null, bn = b == null;
  if (an || bn) return an === bn;
  return Math.abs(a - b) <= 1e-12 + 1e-12 * Math.abs(b);
}

let ok = true;
for (const c of gt.cases) {
  const got = loadLps(c.lps, c.series);
  let pass = true, why = '';
  if (got.names.join(',') !== c.names.join(',')) { pass = false; why = `names ${got.names} != ${c.names}`; }
  if (pass && got.cols.length !== c.cols.length) { pass = false; why = `ncol ${got.cols.length} != ${c.cols.length}`; }
  let maxdiff = 0;
  if (pass) for (let j = 0; j < c.cols.length; j++) {
    if (got.cols[j].length !== c.cols[j].length) { pass = false; why = `col ${j} nrow ${got.cols[j].length} != ${c.cols[j].length}`; break; }
    for (let i = 0; i < c.cols[j].length; i++) {
      const x = got.cols[j][i], y = c.cols[j][i];
      if (!cellEq(x, y)) { pass = false; why = `col ${j} row ${i}: ${x} != ${y}`; break; }
      if (x != null && y != null) maxdiff = Math.max(maxdiff, Math.abs(x - y));
    }
    if (!pass) break;
  }
  if (!pass) ok = false;
  console.log(c.name.padEnd(26), pass ? 'PASS' : 'FAIL', 'maxdiff', maxdiff.toExponential(2), pass ? '' : ' <- ' + why);
}

// negative case: a line with < 2 measurements must throw (matches R crash)
let threw = false;
try {
  loadLps('<lineprofileengine><lines count="1"><profile><edges><edge><distances><channel>' +
          '<manual count="1"><distance value="5"/></manual></channel></distances></edge></edges></profile></lines></lineprofileengine>', 'X');
} catch (e) { threw = true; }
if (!threw) ok = false;
console.log('throws_on_single_measurement'.padEnd(26), threw ? 'PASS' : 'FAIL');

console.log(ok ? '\nLPS PASS' : '\nLPS FAIL');
process.exit(ok ? 0 : 1);
