'use strict';
// Validates src/io (csv.js, xlsx.js, loaders.js) against R ground truth
// (io_csv_gt.json, produced by the ACTUAL ringdater R loaders). Exits nonzero
// on any parity failure.
const fs = require('fs');
const path = require('path');
const { loadUndated, loadChron, loadDataTabs, ldUndatedChron } = require('../src/io/loaders');

const FIX = path.join(__dirname, 'fixtures');
const EXT = path.join(FIX, 'extdata');
const VIG = path.join(FIX, 'vignettes');
const TXT = path.join(FIX, 'txt');
const txt = p => ({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') });
const xls = p => ({ name: path.basename(p), buffer: fs.readFileSync(p) });

const gt = JSON.parse(fs.readFileSync(path.join(__dirname, 'io_csv_gt.json'), 'utf8'));

const TOL = 1e-9;
function cellEq(a, b) {
  const an = a == null || (typeof a === 'number' && Number.isNaN(a));
  const bn = b == null || b === 'null';
  if (an || bn) return an && bn;
  if (typeof a === 'number' || (typeof b === 'string' && /^[-+]?[\d.]/.test(b) && !isNaN(+b))) {
    const x = +a, y = +b, d = Math.abs(x - y);
    return d <= TOL || d <= TOL * Math.max(Math.abs(x), Math.abs(y));
  }
  return String(a) === String(b);
}

function compare(name, got, exp) {
  const errs = [];
  if (got.names.length !== exp.names.length) errs.push(`ncol ${got.names.length} != ${exp.names.length}`);
  for (let c = 0; c < Math.min(got.names.length, exp.names.length); c++) {
    if (String(got.names[c]) !== String(exp.names[c])) errs.push(`name[${c}] "${got.names[c]}" != "${exp.names[c]}"`);
  }
  const gnr = got.cols[0] ? got.cols[0].length : 0;
  const enr = exp.cols[0] ? exp.cols[0].length : 0;
  if (gnr !== enr) errs.push(`nrow ${gnr} != ${enr}`);
  for (let c = 0; c < Math.min(got.cols.length, exp.cols.length) && errs.length < 8; c++) {
    const gc = got.cols[c], ec = exp.cols[c];
    for (let r = 0; r < Math.min(gc.length, ec.length); r++) {
      if (!cellEq(gc[r], ec[r])) { errs.push(`cell[${c}][${r}] ${JSON.stringify(gc[r])} != ${JSON.stringify(ec[r])}`); break; }
    }
  }
  return errs;
}

const cases = {
  load_undated_undated_example_csv: () => loadUndated(txt(path.join(EXT, 'undated_example.csv'))),
  load_undated_UndatedSeries_csv:   () => loadUndated(txt(path.join(VIG, 'UndatedSeries.csv'))),
  load_undated_dated_xlsx:          () => loadUndated(xls(path.join(EXT, 'dated_example_excel.xlsx'))),
  load_undated_two_col_txt:         () => loadUndated(txt(path.join(TXT, 'two_col.txt'))),
  load_chron_chron_comp_1_csv:      () => loadChron(txt(path.join(EXT, 'chron_comp_1.csv'))),
  load_chron_chron_comp_2_csv:      () => loadChron(txt(path.join(EXT, 'chron_comp_2.csv'))),
  load_chron_ExampleChron_csv:      () => loadChron(txt(path.join(VIG, 'chronologies', 'ExampleChron.csv'))),
  load_chron_dated_xlsx:            () => loadChron(xls(path.join(EXT, 'dated_example_excel.xlsx'))),
  ld_undated_chron_xlsx:            () => ldUndatedChron(xls(path.join(EXT, 'undated_Chron.xlsx'))),
  ld_undated_chron_ExampleChron_csv:() => ldUndatedChron(txt(path.join(VIG, 'chronologies', 'ExampleChron.csv'))),
  ld_undated_chron_chron_txt:       () => ldUndatedChron(txt(path.join(TXT, 'chron.txt'))),
  load_data_tabs_undated_example:   () => loadDataTabs(loadUndated(txt(path.join(EXT, 'undated_example.csv')))),
};

let allPass = true;
console.log('case'.padEnd(38), 'result'.padEnd(6), 'detail');
for (const key of Object.keys(gt)) {
  let errs;
  try { errs = compare(key, cases[key](), gt[key]); }
  catch (e) { errs = ['THREW: ' + e.message]; }
  const pass = errs.length === 0;
  if (!pass) allPass = false;
  console.log(key.padEnd(38), (pass ? 'PASS' : 'FAIL').padEnd(6), pass ? '' : errs.slice(0, 3).join('; '));
}
console.log(allPass ? '\nALL PASS' : '\nFAILURES PRESENT');
process.exit(allPass ? 0 : 1);
