'use strict';
// ============================================================================
// Dependency-free XML reader + serializer.
//
// Generalized from the tiny element walker originally in src/io/lps.js. It is
// deliberately NOT a conforming XML parser — it is a pragmatic scanner good
// enough for the fixed schemas RingdateR consumes (Image-Pro `.lps` and TRiDaS
// `.xml`). Over the lps-only walker it adds three things TRiDaS needs:
//
//   1. TEXT-NODE CAPTURE  — character data between tags is stored on the owning
//      element's `.text`, so `<title>Quercus robur</title>` is readable. The
//      lps schema put everything in attributes; TRiDaS puts much in element
//      text (titles, units, years, lab codes, taxon).
//   2. ENTITY DECODING    — `&amp; &lt; &gt; &quot; &apos; &#nn; &#xHH;` are
//      decoded in both text and attribute values.
//   3. NAMESPACE TOLERANCE — child()/childrenOf() match on the LOCAL name, so a
//      default-namespaced (`xmlns="…"`) or prefixed (`tridas:value`) document
//      navigates the same as an unprefixed one.
//
// Node model:  { tag, attrs:{}, children:[node], text:string }
// `tag` keeps the raw (possibly prefixed) name; `text` is the concatenation of
// this element's direct character data (use text(node) for a trimmed read).
// ============================================================================

// ---- entity decoding --------------------------------------------------------
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
  if (s == null || s.indexOf('&') < 0) return s == null ? s : String(s);
  return String(s).replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : whole;
  });
}

// ---- parsing ----------------------------------------------------------------

function parseAttrs(s) {
  const attrs = {};
  const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[3] !== undefined ? m[3] : m[4];
    attrs[m[1]] = decodeEntities(raw);
  }
  return attrs;
}

// Parse XML text into a { tag:'#root', children:[...] } tree.
function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<([!?/]?)([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)\s*(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    // character data between the previous match and this one belongs to the
    // element currently on top of the stack.
    if (m.index > last) appendText(stack[stack.length - 1], decodeEntities(text.slice(last, m.index)));
    last = re.lastIndex;

    const token = m[0];
    if (token.charCodeAt(1) === 33 /* '!' */) {
      if (token.startsWith('<![CDATA[')) appendText(stack[stack.length - 1], token.slice(9, -3));
      continue;                                          // comment / CDATA / doctype
    }
    const marker = m[1];
    if (marker === '?') continue;                        // processing instruction / <?xml?>
    const tag = m[2];
    if (!tag) continue;                                  // defensive
    if (marker === '/') {                                // closing tag -> pop to match (by local name)
      const ln = localName(tag);
      for (let k = stack.length - 1; k >= 1; k--) {
        if (localName(stack[k].tag) === ln) { stack.length = k; break; }
      }
      continue;
    }
    const node = { tag, attrs: parseAttrs(m[3] || ''), children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (m[4] !== '/') stack.push(node);                  // not self-closing
  }
  return root;
}

function appendText(node, s) { if (s) node.text += s; }

// ---- navigation (namespace-tolerant: match on local name) -------------------

function localName(tag) {
  const i = String(tag).indexOf(':');
  return i < 0 ? tag : tag.slice(i + 1);
}

// first child element whose local name matches (mirrors R `$name` first-match)
function child(node, tag) {
  if (!node) return undefined;
  for (const c of node.children) if (localName(c.tag) === tag) return c;
  return undefined;
}

// all child elements with the given local name, in document order
function childrenOf(node, tag) {
  const out = [];
  if (node) for (const c of node.children) if (localName(c.tag) === tag) out.push(c);
  return out;
}

// trimmed text content of an element (empty string if none / node absent)
function text(node) { return node && node.text != null ? node.text.trim() : ''; }

// trimmed text of the first matching child, or undefined if the child is absent
function childText(node, tag) { const c = child(node, tag); return c ? text(c) : undefined; }

// ---- building + serialization (for the TRiDaS writer) -----------------------

function el(tag, attrs, children) {
  return { tag, attrs: attrs || {}, children: children || [], text: '' };
}
// leaf element carrying text content, e.g. elText('title', 'Oak 1')
function elText(tag, value, attrs) {
  const n = el(tag, attrs);
  n.text = value == null ? '' : String(value);
  return n;
}

function encodeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function encodeAttr(s) { return encodeText(s).replace(/"/g, '&quot;'); }

function serializeNode(node, indent, out) {
  const pad = '  '.repeat(indent);
  const attrs = Object.keys(node.attrs || {})
    .map(k => ' ' + k + '="' + encodeAttr(node.attrs[k]) + '"').join('');
  const kids = node.children || [];
  const hasText = node.text != null && node.text !== '';
  if (!kids.length && !hasText) { out.push(pad + '<' + node.tag + attrs + '/>'); return; }
  if (!kids.length) { out.push(pad + '<' + node.tag + attrs + '>' + encodeText(node.text) + '</' + node.tag + '>'); return; }
  out.push(pad + '<' + node.tag + attrs + '>');
  for (const c of kids) serializeNode(c, indent + 1, out);
  out.push(pad + '</' + node.tag + '>');
}

// serialize a node tree to an XML string. opts.declaration=false omits <?xml?>.
function serializeXml(node, opts) {
  const out = [];
  if (!opts || opts.declaration !== false) out.push('<?xml version="1.0" encoding="UTF-8"?>');
  serializeNode(node, 0, out);
  return out.join('\n') + '\n';
}

module.exports = {
  parseXml, parseAttrs, decodeEntities,
  child, childrenOf, text, childText, localName,
  el, elText, serializeXml, encodeText, encodeAttr,
};
