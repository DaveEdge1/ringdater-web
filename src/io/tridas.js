'use strict';
// ============================================================================
// TRiDaS (Tree Ring Data Standard, v1.2.2) reader — the interchange format
// Tellervo emits. Import only in this file; the writer lives alongside it
// (added in a later step).
//
// TRiDaS hierarchy:
//   tridas > project > object > element > sample > radius > measurementSeries
//   tridas > project > derivedSeries        (chronologies; linkSeries -> members)
//
// This reader turns that into RingdateR's world:
//   - undated measurementSeries  -> an increment-axis "undated pool" Frame
//   - absolutely-dated series / derivedSeries -> a calendar-year "chron" Frame
//     (col0 = INTERNAL astronomical year integers; the AD/BC no-year-0 mapping
//      is applied only at display/export via src/io/year.js)
//   - all series' identifiers / taxon / units / dating / pith-bark -> a `meta`
//     side-channel (src/io/meta.js), so nothing Tellervo knows is dropped.
//
// Values are integer counts in the series <unit>; we convert to millimetres
// (the Frame's internal convention, matching the RWL reader) using mmPerUnit().
// ============================================================================

const { parseXml, child, childrenOf, text, childText, localName, el, elText, serializeXml } = require('./xml.js');
const { calToAstro, astroToCal } = require('./year.js');
const { emptySeriesMeta, normalizeSeriesMeta } = require('./meta.js');
const { makeNames } = require('../analysis/checks.js');

const TRIDAS_NS = 'http://www.tridas.org/1.2.2';

// ---- unit -> millimetres ----------------------------------------------------
// The TRiDaS controlled unit vocabulary. Unknown/absent units fall back to a
// factor of 1 (values kept as-is) and the raw unit string is preserved in meta
// so a mis-scale is visible rather than silent.
function mmPerUnit(u) {
  if (u == null) return null;
  const s = String(u).toLowerCase().replace(/(\d)\s*th\b/g, '$1').replace(/\s+/g, ' ').trim();
  const table = {
    'metres': 1000, 'meters': 1000,
    'centimetres': 10, 'centimeters': 10,
    'millimetres': 1, 'millimeters': 1,
    '1/10 millimetres': 0.1, '1/10 millimeters': 0.1,
    '1/20 millimetres': 0.05, '1/20 millimeters': 0.05,
    '1/50 millimetres': 0.02, '1/50 millimeters': 0.02,
    '1/100 millimetres': 0.01, '1/100 millimeters': 0.01,
    '1/1000 millimetres': 0.001, '1/1000 millimeters': 0.001,
    'micrometres': 0.001, 'micrometers': 0.001, 'microns': 0.001
  };
  return Object.prototype.hasOwnProperty.call(table, s) ? table[s] : null;
}

// ---- small field readers ----------------------------------------------------
function readIdent(node) {
  const e = child(node, 'identifier');
  return { value: e ? (text(e) || null) : null, domain: e && e.attrs.domain ? e.attrs.domain : null };
}
function firstValuesGroup(series) { return child(series, 'values'); }

function readUnit(values) {
  const u = child(values, 'unit');
  if (!u) return null;
  if (u.attrs.unitless === 'true') return 'unitless';
  if (u.attrs.normalTridas) return u.attrs.normalTridas;
  if (u.attrs.value) return u.attrs.value;
  const nt = child(u, 'normalTridas');
  if (nt && text(nt)) return text(nt);
  return text(u) || null;
}
function readVariable(values) {
  const v = child(values, 'variable');
  if (!v) return null;
  if (v.attrs.normalTridas) return v.attrs.normalTridas;
  if (v.attrs.normal) return v.attrs.normal;
  if (text(v)) return text(v);
  if (v.children.length) return localName(v.children[0].tag);   // e.g. <ringWidth/>
  return null;
}
function presence(wc, tag) {
  const el = wc && child(wc, tag);
  if (!el) return null;
  const p = String(el.attrs.presence || '').toLowerCase();
  if (!p) return null;
  if (p === 'absent') return false;
  if (p === 'present' || p === 'complete' || p === 'incomplete') return true;
  return null;   // 'unknown'
}

// interpretation -> { dated, firstYearInternal, lastYearInternal, datingType }
function readInterp(interp, n) {
  if (!interp) return { dated: false, firstYearInternal: null, lastYearInternal: null, datingType: null };
  const dtEl = child(interp, 'dating');
  const datingType = dtEl ? (dtEl.attrs.type || text(dtEl) || null) : null;
  const isRelative = datingType != null && /relative/i.test(String(datingType));
  const fy = child(interp, 'firstYear');
  const ly = child(interp, 'lastYear');
  let firstYearInternal = null, lastYearInternal = null, dated = false;
  if (fy && text(fy)) {
    const yr = parseInt(text(fy), 10);
    if (Number.isFinite(yr) && !isRelative) {
      firstYearInternal = calToAstro(yr, fy.attrs.suffix || 'AD');
      dated = true;
    }
  }
  if (dated) {
    if (ly && text(ly)) {
      const yr2 = parseInt(text(ly), 10);
      if (Number.isFinite(yr2)) lastYearInternal = calToAstro(yr2, ly.attrs.suffix || 'AD');
    }
    if (lastYearInternal == null && n) lastYearInternal = firstYearInternal + n - 1;
  }
  return { dated, firstYearInternal, lastYearInternal, datingType };
}

// ---- series handlers --------------------------------------------------------
function seriesValuesMm(seriesNode) {
  const values = firstValuesGroup(seriesNode);
  const valEls = values ? childrenOf(values, 'value') : [];
  const raw = valEls.map(v => Number(v.attrs.value));
  const counts = valEls.map(v => (v.attrs.count != null ? Number(v.attrs.count) : null));
  const unit = values ? readUnit(values) : null;
  const variable = values ? readVariable(values) : null;
  const factor = mmPerUnit(unit);
  const mm = factor == null ? 1 : factor;
  const valuesMm = raw.map(v => (Number.isFinite(v) ? v * mm : null));
  return { valuesMm: valuesMm, counts: counts, unit: unit, variable: variable };
}

function handleMeasurement(ms, ctx, undatedRaw, datedRaw) {
  const id = readIdent(ms);
  const title = childText(ms, 'title') || ctx.sampleTitle || ctx.elementTitle || id.value || 'series';
  const v = seriesValuesMm(ms);
  const wc = child(ms, 'woodCompleteness');
  const interp = readInterp(child(ms, 'interpretation'), v.valuesMm.length);
  const metaPartial = {
    title: title, labCode: id.value,
    tridas: {
      projectId: ctx.projectId || null, objectId: ctx.objectId || null, elementId: ctx.elementId || null,
      sampleId: ctx.sampleId || null, radiusId: ctx.radiusId || null,
      seriesId: id.value, identifierDomain: id.domain
    },
    taxon: ctx.taxon || null,
    pith: presence(wc, 'pith'), bark: presence(wc, 'bark'),
    unit: v.unit, variable: v.variable,
    dated: interp.dated ? 'absolute' : (interp.datingType && /relative/i.test(interp.datingType) ? 'relative' : null),
    firstYearInternal: interp.dated ? interp.firstYearInternal : null,
    lastYearInternal: interp.dated ? interp.lastYearInternal : null
  };
  const rec = {
    title: title, valuesMm: v.valuesMm, seriesId: id.value,
    firstYearInternal: interp.dated ? interp.firstYearInternal : null, metaPartial: metaPartial
  };
  (interp.dated ? datedRaw : undatedRaw).push(rec);
}

function handleDerived(ds, ctx, datedRaw) {
  const id = readIdent(ds);
  const title = childText(ds, 'title') || id.value || 'chronology';
  const v = seriesValuesMm(ds);
  const interp = readInterp(child(ds, 'interpretation'), v.valuesMm.length);
  const links = [];
  const ls = child(ds, 'linkSeries');
  if (ls) childrenOf(ls, 'series').forEach(function (s) {
    const sid = readIdent(s);
    if (sid.value) links.push(sid.value);
  });
  const metaPartial = {
    title: title, labCode: id.value,
    tridas: {
      projectId: ctx.projectId || null, seriesId: id.value, identifierDomain: id.domain, derived: true
    },
    unit: v.unit, variable: v.variable,
    dated: interp.dated ? 'absolute' : (interp.datingType && /relative/i.test(interp.datingType) ? 'relative' : null),
    firstYearInternal: interp.dated ? interp.firstYearInternal : null,
    lastYearInternal: interp.dated ? interp.lastYearInternal : null,
    isChronology: true, sampleDepth: v.counts, linkMembers: links
  };
  datedRaw.push({
    title: title, valuesMm: v.valuesMm, seriesId: id.value,
    firstYearInternal: interp.dated ? interp.firstYearInternal : 1, links: links, metaPartial: metaPartial
  });
}

function collectFromObjects(objects, ctx, undatedRaw, datedRaw) {
  objects.forEach(function (obj) {
    const objId = readIdent(obj);
    const objCtx = Object.assign({}, ctx, { objectId: objId.value, objectTitle: childText(obj, 'title') });
    collectFromObjects(childrenOf(obj, 'object'), objCtx, undatedRaw, datedRaw);   // nested objects
    childrenOf(obj, 'element').forEach(function (el) {
      const elId = readIdent(el);
      const elCtx = Object.assign({}, objCtx, {
        elementId: elId.value, taxon: childText(el, 'taxon') || null, elementTitle: childText(el, 'title')
      });
      childrenOf(el, 'sample').forEach(function (sample) {
        const sId = readIdent(sample);
        const sCtx = Object.assign({}, elCtx, { sampleId: sId.value, sampleTitle: childText(sample, 'title') });
        const radii = childrenOf(sample, 'radius');
        if (radii.length) {
          radii.forEach(function (rad) {
            const rCtx = Object.assign({}, sCtx, { radiusId: readIdent(rad).value });
            childrenOf(rad, 'measurementSeries').forEach(ms => handleMeasurement(ms, rCtx, undatedRaw, datedRaw));
          });
        } else {
          childrenOf(sample, 'measurementSeries').forEach(ms => handleMeasurement(ms, sCtx, undatedRaw, datedRaw));
        }
      });
    });
  });
}

// ---- frame assembly ---------------------------------------------------------
function lowerSpace(s) { return String(s).replace(/\s/g, '_').toLowerCase(); }
function safeNames(bases) { return makeNames(bases).map(s => s.replace(/\./g, '_')); }

// undated pool: increment axis (col0 = 1..maxLen), series bottom-padded with NA
function buildUndatedFrame(recs, names) {
  if (!recs.length) return null;
  const maxLen = recs.reduce((m, r) => Math.max(m, r.valuesMm.length), 0);
  const ring = []; for (let i = 0; i < maxLen; i++) ring.push(i + 1);
  const cols = [ring];
  recs.forEach(function (r) {
    const c = r.valuesMm.slice();
    while (c.length < maxLen) c.push(null);
    cols.push(c);
  });
  return { names: ['ring'].concat(names), cols: cols };
}

// dated frame: col0 = contiguous INTERNAL astronomical years spanning all series
function buildDatedFrame(recs, names) {
  if (!recs.length) return null;
  const spans = recs.map(function (r) {
    const start = r.firstYearInternal != null ? r.firstYearInternal : 1;
    return { start: start, end: start + r.valuesMm.length - 1 };
  });
  const axisMin = Math.min.apply(null, spans.map(s => s.start));
  const axisMax = Math.max.apply(null, spans.map(s => s.end));
  const years = []; for (let y = axisMin; y <= axisMax; y++) years.push(y);
  const cols = [years];
  recs.forEach(function (r, i) {
    const col = new Array(years.length).fill(null);
    const start = spans[i].start;
    for (let k = 0; k < r.valuesMm.length; k++) col[start + k - axisMin] = r.valuesMm[k];
    cols.push(col);
  });
  return { names: ['years'].concat(names), cols: cols, axisMin: axisMin };
}

/**
 * readTridas(text, opts) -> { undated, chron, meta, dating, links }
 *   undated : Frame | null  (increment-axis pool of undated measurementSeries)
 *   chron   : Frame | null  (calendar/internal-year axis of dated + derivedSeries)
 *   meta    : { [columnName]: SeriesMeta }  covering every column in both frames
 *   dating  : { anyAbsolute, firstYearInternal } | null
 *   links   : { [chronColumnName]: [memberSeriesId, ...] }  (derivedSeries provenance)
 */
function readTridas(xmlText, opts) {
  if (typeof xmlText !== 'string') throw new Error('readTridas: text must be a string');
  const root = parseXml(xmlText);
  const tridas = child(root, 'tridas') || root;
  const projects = childrenOf(tridas, 'project');
  const scopes = projects.length ? projects : [tridas];   // tolerate a missing <project>

  const undatedRaw = [], datedRaw = [];
  scopes.forEach(function (project) {
    const ctx = { projectId: readIdent(project).value };
    collectFromObjects(childrenOf(project, 'object'), ctx, undatedRaw, datedRaw);
    childrenOf(project, 'derivedSeries').forEach(ds => handleDerived(ds, ctx, datedRaw));
  });

  if (!undatedRaw.length && !datedRaw.length) {
    throw new Error('readTridas: no measurementSeries or derivedSeries found (is this a TRiDaS file?)');
  }

  // Generate globally-unique safe column names across BOTH frames so the single
  // meta object never has a key collision between a pool series and a chronology.
  const allBases = undatedRaw.map(r => lowerSpace(r.title)).concat(datedRaw.map(r => r.title));
  const allSafe = safeNames(allBases);
  const undatedNames = allSafe.slice(0, undatedRaw.length);
  const datedNames = allSafe.slice(undatedRaw.length);

  const undated = buildUndatedFrame(undatedRaw, undatedNames);
  const dated = buildDatedFrame(datedRaw, datedNames);

  const meta = {};
  undatedRaw.forEach((r, i) => { meta[undatedNames[i]] = normalizeSeriesMeta(undatedNames[i], r.metaPartial); });
  datedRaw.forEach((r, i) => { meta[datedNames[i]] = normalizeSeriesMeta(datedNames[i], r.metaPartial); });

  const links = {};
  datedRaw.forEach(function (r, i) { if (r.links && r.links.length) links[datedNames[i]] = r.links.slice(); });

  const anyAbsolute = datedRaw.some(r => r.metaPartial.dated === 'absolute');
  const dating = dated ? { anyAbsolute: anyAbsolute, firstYearInternal: dated.axisMin } : null;
  if (dated) delete dated.axisMin;   // keep the Frame shape clean {names, cols}

  return { undated: undated, chron: dated, meta: meta, dating: dating, links: links };
}

// ============================================================================
// writeTridas — emit a TRiDaS 1.2.2 document for a built/extended chronology.
//
// spec = {
//   chronology: { name, valuesMm:[..], firstYearInternal, sampleDepth?:[..], meta? },
//   members:    [ { name, valuesMm:[..], firstYearInternal|null, meta } ],
//   mode:       'selfContained' | 'derivedOnly',
//   unit:       output unit string (default '1/1000th millimetres'),
//   project:    { title?, identifier?, domain?, laboratory? }
// }
// - selfContained: rebuilds object>element>sample>radius>measurementSeries for
//   every member (grouped by their TRiDaS identifiers when present) AND a
//   derivedSeries linking to them.
// - derivedOnly: just the derivedSeries with <linkSeries> to member identifiers
//   (assumes the members already live in Tellervo).
// ============================================================================

function firstYearNode(tag, internalYear) {
  const c = astroToCal(internalYear);
  return elText(tag, String(c.year), { suffix: c.suffix });
}

// keep the leading contiguous (non-null) run of a series — TRiDaS <values> is a
// dense list; RingdateR columns are bottom-padded with NA.
function densify(valuesMm) {
  const out = [];
  for (let i = 0; i < valuesMm.length; i++) {
    if (valuesMm[i] == null) break;
    out.push(valuesMm[i]);
  }
  return out;
}

function valuesBlock(valuesMm, unit, factor, sampleDepth) {
  const kids = [el('variable', { normalTridas: 'ring width' }), el('unit', { normalTridas: unit })];
  valuesMm.forEach(function (v, i) {
    const attrs = { value: String(Math.round(v / factor)) };
    if (sampleDepth && sampleDepth[i] != null) attrs.count = String(sampleDepth[i]);
    kids.push(el('value', attrs));
  });
  return el('values', {}, kids);
}

function identNode(value, domain) { return elText('identifier', value, { domain: domain || 'ringdater' }); }

function measurementSeriesNode(member, unit, factor) {
  const m = member.meta || {};
  const t = m.tridas || {};
  const kids = [
    elText('title', m.title || member.name),
    identNode(t.seriesId || ('MS_' + member.name), t.identifierDomain)
  ];
  const wc = [];
  if (m.pith != null) wc.push(el('pith', { presence: m.pith ? 'complete' : 'absent' }));
  if (m.bark != null) wc.push(el('bark', { presence: m.bark ? 'present' : 'absent' }));
  if (wc.length) kids.push(el('woodCompleteness', {}, wc));
  if (member.firstYearInternal != null) {
    const vals = densify(member.valuesMm);
    kids.push(el('interpretation', {}, [
      el('dating', { type: 'absolute' }),
      firstYearNode('firstYear', member.firstYearInternal),
      firstYearNode('lastYear', member.firstYearInternal + vals.length - 1)
    ]));
  }
  kids.push(valuesBlock(densify(member.valuesMm), unit, factor));
  return el('measurementSeries', {}, kids);
}

// group members into object>element>sample>radius using TRiDaS ids where present
function buildObjectTree(members, unit, factor) {
  const objects = [];
  const objIndex = {};
  members.forEach(function (member) {
    const t = (member.meta && member.meta.tridas) || {};
    const objId = t.objectId || ('OBJ_' + member.name);
    const elId = t.elementId || ('EL_' + member.name);
    const smpId = t.sampleId || ('SMP_' + member.name);
    const radId = t.radiusId || ('RAD_' + member.name);
    let obj = objIndex[objId];
    if (!obj) {
      obj = { id: objId, title: (member.meta && member.meta.objectTitle) || objId, elements: [], elIndex: {} };
      objIndex[objId] = obj; objects.push(obj);
    }
    let elm = obj.elIndex[elId];
    if (!elm) {
      elm = { id: elId, taxon: (member.meta && member.meta.taxon) || null, samples: [], smpIndex: {} };
      obj.elIndex[elId] = elm; obj.elements.push(elm);
    }
    let smp = elm.smpIndex[smpId];
    if (!smp) { smp = { id: smpId, radii: [], radIndex: {} }; elm.smpIndex[smpId] = smp; elm.samples.push(smp); }
    let rad = smp.radIndex[radId];
    if (!rad) { rad = { id: radId, series: [] }; smp.radIndex[radId] = rad; smp.radii.push(rad); }
    rad.series.push(measurementSeriesNode(member, unit, factor));
  });

  return objects.map(function (obj) {
    return el('object', {}, [
      elText('title', obj.title), identNode(obj.id), elText('type', 'site'),
    ].concat(obj.elements.map(function (elm) {
      const ekids = [elText('title', elm.id), identNode(elm.id)];
      if (elm.taxon) ekids.push(elText('taxon', elm.taxon));
      elm.samples.forEach(function (smp) {
        ekids.push(el('sample', {}, [elText('title', smp.id), identNode(smp.id), elText('type', 'core')].concat(
          smp.radii.map(function (rad) {
            return el('radius', {}, [elText('title', rad.id), identNode(rad.id)].concat(rad.series));
          })
        )));
      });
      return el('element', {}, ekids);
    })));
  });
}

function derivedSeriesNode(chronology, members, unit, factor) {
  const m = chronology.meta || {};
  const t = m.tridas || {};
  const linkSeries = el('linkSeries', {}, members.map(function (mem) {
    const mt = (mem.meta && mem.meta.tridas) || {};
    return el('series', {}, [identNode(mt.seriesId || ('MS_' + mem.name), mt.identifierDomain)]);
  }));
  const vals = densify(chronology.valuesMm);
  const kids = [
    elText('title', chronology.name || m.title || 'chronology'),
    identNode(t.seriesId || ('CHRON_' + (chronology.name || 'x')), t.identifierDomain),
    linkSeries,
    elText('type', 'chronology')
  ];
  if (chronology.firstYearInternal != null) {
    kids.push(el('interpretation', {}, [
      el('dating', { type: 'absolute' }),
      firstYearNode('firstYear', chronology.firstYearInternal),
      firstYearNode('lastYear', chronology.firstYearInternal + vals.length - 1)
    ]));
  }
  kids.push(valuesBlock(vals, unit, factor, chronology.sampleDepth));
  return el('derivedSeries', {}, kids);
}

function writeTridas(spec) {
  spec = spec || {};
  const mode = spec.mode === 'derivedOnly' ? 'derivedOnly' : 'selfContained';
  const unit = spec.unit || '1/1000th millimetres';
  const factor = mmPerUnit(unit) || 0.001;
  const members = spec.members || [];
  const chronology = spec.chronology;
  if (!chronology) throw new Error('writeTridas: spec.chronology is required');
  const proj = spec.project || {};

  const projKids = [
    elText('title', proj.title || 'RingdateR chronology'),
    identNode(proj.identifier || 'ringdater-export', proj.domain),
    elText('type', 'unknown'),
    elText('laboratory', proj.laboratory || 'RingdateR'),
    elText('category', 'unknown'),
    elText('investigator', proj.investigator || 'unknown'),
    elText('period', 'unknown')
  ];
  if (mode === 'selfContained') {
    buildObjectTree(members, unit, factor).forEach(o => projKids.push(o));
  }
  projKids.push(derivedSeriesNode(chronology, members, unit, factor));

  const root = el('tridas', { xmlns: TRIDAS_NS }, [el('project', {}, projKids)]);
  return serializeXml(root);
}

module.exports = { readTridas, writeTridas, mmPerUnit };
