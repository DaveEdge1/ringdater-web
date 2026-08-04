'use strict';
// ============================================================================
// T2.1b  XLSX reader  (port of readxl::read_excel(sheet = 1, na = "NA"))
// ----------------------------------------------------------------------------
// An .xlsx file is a ZIP archive of XML parts. This module unzips the two parts
// ringdater needs -- xl/worksheets/sheet1.xml and xl/sharedStrings.xml -- with
// NO external dependency, using Node's built-in zlib.inflateRawSync to inflate
// the raw-DEFLATE ZIP entries, then parses the XML with small regexes.
//
// It returns the shared `Frame` shape from ../analysis/comb.js: the first sheet
// row becomes the column names (col_names = TRUE), the rest become data; a cell
// whose text is "NA" reads as null (na = "NA"); each column is typed numeric iff
// every non-null cell is numeric, else it stays character -- matching read_excel.
//
// BROWSER CAVEAT: node:zlib is unavailable in browsers. To deploy client-side,
// swap `inflateRaw` below for a JS/wasm raw-inflate (e.g. pako.inflateRaw or
// fflate.inflateSync), or replace this whole module with SheetJS (XLSX.read).
// The ZIP + XML parsing here is otherwise environment-agnostic.
//
// Scope: reads string/number/inline-string/boolean cells. It does NOT convert
// Excel date serials to dates (ringdater's fixtures store plain numbers/strings);
// a styled date column would surface as its numeric serial.
// ============================================================================

const zlib = require('zlib');
const { makeNames } = require('../analysis/checks');

// ---- minimal ZIP reader (central-directory based) ---------------------------
function findEOCD(buf) {
  // End Of Central Directory signature 0x06054b50, scan backwards.
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('xlsx: not a ZIP (no EOCD found)');
}

function unzip(buf) {
  const eocd = findEOCD(buf);
  const nEntries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries = {};
  for (let k = 0; k < nEntries; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // central dir header sig
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // local file header: recompute data start from its own name/extra lengths.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = comp;                       // stored
    else if (method === 8) data = inflateRaw(comp);      // deflate
    else throw new Error('xlsx: unsupported ZIP compression method ' + method);
    entries[name] = data;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// The single node:zlib touch-point -- replace for browser builds (see caveat).
function inflateRaw(comp) { return zlib.inflateRawSync(comp); }

// ---- XML helpers ------------------------------------------------------------
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X'
        ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return m;
  });
}

// concatenate all <t>...</t> text within a fragment (handles <r> rich-text runs)
function collectText(fragment) {
  let out = '';
  const re = /<t[^>]*>([\s\S]*?)<\/t>|<t[^>]*\/>/g;
  let m;
  while ((m = re.exec(fragment)) !== null) out += m[1] != null ? m[1] : '';
  return decodeEntities(out);
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [];
  const re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = re.exec(xml)) !== null) strings.push(m[1] != null ? collectText(m[1]) : '');
  return strings;
}

// column letters ("A","AB",...) -> 0-based index
function colRefToIndex(ref) {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

// ---- worksheet parse --------------------------------------------------------
// returns a matrix of raw cell values (string|number|null), rows x cols.
function parseSheet(xml, shared) {
  const rows = [];
  let maxCol = 0;
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const inner = rm[1] || '';
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(inner)) !== null) {
      const attrs = cm[1];
      const contents = cm[2] || '';
      const refM = /\br="([A-Z]+\d+)"/.exec(attrs);
      const cidx = refM ? colRefToIndex(refM[1]) : cells.length;
      const tM = /\bt="([^"]+)"/.exec(attrs);
      const type = tM ? tM[1] : 'n';
      let value = null;
      if (type === 's') {
        const vM = /<v[^>]*>([\s\S]*?)<\/v>/.exec(contents);
        if (vM) value = shared[parseInt(vM[1], 10)];
      } else if (type === 'inlineStr') {
        value = collectText(contents);
      } else if (type === 'str') {
        const vM = /<v[^>]*>([\s\S]*?)<\/v>/.exec(contents);
        value = vM ? decodeEntities(vM[1]) : '';
      } else if (type === 'b') {
        const vM = /<v[^>]*>([\s\S]*?)<\/v>/.exec(contents);
        value = vM && vM[1].trim() === '1';
      } else { // numeric (t="n" or absent); ignore t="e" error cells -> null
        const vM = /<v[^>]*>([\s\S]*?)<\/v>/.exec(contents);
        if (vM && type !== 'e') value = parseFloat(vM[1]);
      }
      cells[cidx] = value === undefined ? null : value;
      if (cidx + 1 > maxCol) maxCol = cidx + 1;
    }
    rows.push(cells);
  }
  // rectangularise, missing cells -> null
  for (const r of rows) for (let c = 0; c < maxCol; c++) if (r[c] === undefined) r[c] = null;
  return { rows, ncol: maxCol };
}

// ---- main -------------------------------------------------------------------
// readXlsx(buffer, { na, sheetPath }) -> Frame  (reads first worksheet)
function readXlsx(buffer, opts = {}) {
  const na = opts.na !== undefined ? opts.na : 'NA';
  const naSet = new Set(Array.isArray(na) ? na : (na == null ? [] : [na]));
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const entries = unzip(buf);

  const sheetName = opts.sheetPath || 'xl/worksheets/sheet1.xml';
  const sheetXml = entries[sheetName];
  if (!sheetXml) throw new Error('xlsx: ' + sheetName + ' not found');
  const shared = parseSharedStrings(
    entries['xl/sharedStrings.xml'] ? entries['xl/sharedStrings.xml'].toString('utf8') : ''
  );

  const { rows, ncol } = parseSheet(sheetXml.toString('utf8'), shared);
  if (rows.length === 0 || ncol === 0) return { names: [], cols: [] };

  const isNaCell = v => v == null || (typeof v === 'string' && naSet.has(v));

  // header row -> names (col_names = TRUE)
  const headerRow = rows[0];
  let names = [];
  for (let c = 0; c < ncol; c++) {
    const h = headerRow[c];
    names.push(isNaCell(h) ? '' : String(h));
  }
  names = makeNames(names); // read_excel repairs/uniquifies names

  const dataRows = rows.slice(1);
  const cols = [];
  for (let c = 0; c < ncol; c++) {
    const cells = dataRows.map(r => (isNaCell(r[c]) ? null : r[c]));
    let numeric = true;
    for (const v of cells) {
      if (v == null) continue;
      if (typeof v !== 'number') { numeric = false; break; }
    }
    cols.push(numeric ? cells.map(v => (v == null ? null : +v)) : cells);
  }
  return { names, cols };
}

module.exports = { readXlsx, unzip, parseSharedStrings, parseSheet };
