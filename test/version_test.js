'use strict';
// Version-consistency guard: package.json is the single source of truth; this
// fails the suite whenever any stamped copy drifts (src/version.js, the browser
// bundle's RD.VERSION, the index.html badge, or the cache-busting ?v= query
// strings). Fix drift with `npm run stamp` + rebuild.
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const { VERSION } = require('../src/version.js');
const { RD } = require('../web/ringdater.bundle.js');
const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

let fails = 0;
function ok(name, cond, extra) {
  if (!cond) fails++;
  console.log('  ' + (cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  (' + extra + ')' : ''));
}

ok('src/version.js matches package.json', VERSION === pkg.version, VERSION + ' vs ' + pkg.version);
ok('bundle RD.VERSION matches package.json', RD.VERSION === pkg.version, RD.VERSION + ' vs ' + pkg.version);
ok('index.html badge matches package.json', html.indexOf('<span class="ver">v' + pkg.version + '</span>') >= 0);

// every local asset URL must carry the current cache-busting version
const assets = html.match(/(?:href|src)="\.\/[A-Za-z0-9_.-]+(?:\?v=[^"]*)?"/g) || [];
const stale = assets.filter(a => a.indexOf('?v=' + pkg.version + '"') < 0);
ok('all local asset URLs carry ?v=' + pkg.version, assets.length > 0 && stale.length === 0,
  stale.length ? 'stale: ' + stale.join(' ') : assets.length + ' assets');

// the changelog documents the current version
const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
ok('CHANGELOG.md has an entry for ' + pkg.version, changelog.indexOf('## [' + pkg.version + ']') >= 0);

console.log('');
if (fails) { console.log('VERSION: ' + fails + ' FAIL'); process.exit(1); }
console.log('PASS: version consistency (package.json <-> library <-> bundle <-> app).');
