'use strict';
// Unit tests for src/io/xml.js — the generalized XML reader + serializer.
const X = require('../src/io/xml.js');
const { parseXml, child, childrenOf, text, childText, serializeXml, el, elText } = X;

let ok = true;
function check(name, cond, why) {
  if (!cond) ok = false;
  console.log(name.padEnd(44), cond ? 'PASS' : 'FAIL', cond ? '' : ' <- ' + (why || ''));
}

// --- text-node capture --------------------------------------------------------
const doc = parseXml(
  '<?xml version="1.0"?>\n' +
  '<!-- a comment -->\n' +
  '<root attr="a &amp; b">\n' +
  '  <title>Quercus robur</title>\n' +
  '  <count value="5"/>\n' +
  '  <nested><leaf>deep &lt;text&gt;</leaf></nested>\n' +
  '  <item>one</item>\n' +
  '  <item>two</item>\n' +
  '  <cd><![CDATA[raw <not> parsed]]></cd>\n' +
  '</root>');
const root = child(doc, 'root');
check('root found', !!root);
check('title text captured', childText(root, 'title') === 'Quercus robur', childText(root, 'title'));
check('attr entity decoded', root.attrs.attr === 'a & b', root.attrs.attr);
check('self-closing attr read', child(root, 'count').attrs.value === '5');
check('nested leaf entity-decoded text',
  text(child(child(root, 'nested'), 'leaf')) === 'deep <text>',
  text(child(child(root, 'nested'), 'leaf')));
check('childrenOf returns all matches', childrenOf(root, 'item').length === 2);
check('childrenOf order preserved',
  childrenOf(root, 'item').map(text).join(',') === 'one,two');
check('CDATA content captured raw', childText(root, 'cd') === 'raw <not> parsed', childText(root, 'cd'));

// --- namespace tolerance (default xmlns + prefixed) --------------------------
const ns = parseXml(
  '<tridas:tridas xmlns:tridas="http://www.tridas.org/1.2.2">' +
  '<tridas:project><tridas:title>P1</tridas:title></tridas:project></tridas:tridas>');
const proj = child(child(ns, 'tridas'), 'project');
check('prefixed tags navigate by local name', childText(proj, 'title') === 'P1', childText(proj, 'title'));

const dflt = parseXml('<x xmlns="http://ns"><y>v</y></x>');
check('default-namespaced doc navigates', childText(child(dflt, 'x'), 'y') === 'v');

// --- numeric char refs --------------------------------------------------------
check('decimal char ref', X.decodeEntities('A&#66;C') === 'ABC');
check('hex char ref', X.decodeEntities('&#x41;&#x42;') === 'AB');
check('unknown entity passes through', X.decodeEntities('a&bogus;b') === 'a&bogus;b');

// --- serialize + round-trip ---------------------------------------------------
const tree = el('root', { v: '1' }, [
  elText('title', 'Oak & Ash'),
  el('empty'),
  el('group', {}, [elText('n', '10'), elText('n', '20')]),
]);
const xml = serializeXml(tree);
check('serialize has declaration', xml.startsWith('<?xml'));
check('serialize encodes text entity', xml.indexOf('Oak &amp; Ash') >= 0);
check('serialize self-closes empty', xml.indexOf('<empty/>') >= 0);

const reparsed = child(parseXml(xml), 'root');
check('round-trip attr', reparsed.attrs.v === '1');
check('round-trip decoded text', childText(reparsed, 'title') === 'Oak & Ash', childText(reparsed, 'title'));
check('round-trip nested repeated', childrenOf(child(reparsed, 'group'), 'n').map(text).join(',') === '10,20');

console.log(ok ? '\nXML PASS' : '\nXML FAIL');
process.exit(ok ? 0 : 1);
