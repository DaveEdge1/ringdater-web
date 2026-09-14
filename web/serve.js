'use strict';
// Tiny static file server for local testing of the RingdateR web frontend.
// The app also works by simply opening web/index.html directly (the bundle,
// example data, appCore and app.js are all local, no CDN/network) — this server
// is only a convenience for browsers that restrict file:// module loading.
//
//   node web/serve.js [port]   ->  http://localhost:8080/
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.map': 'application/json', '.txt': 'text/plain'
};

const server = http.createServer(function (req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  // resolve inside ROOT only (no path traversal)
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, function (err, buf) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found: ' + urlPath); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream',
      // Never cache: this server exists to look at the files as they are NOW.
      // index.html asks for the bundle as `ringdater.bundle.js?v=<version>`, so
      // between releases a rebuilt bundle keeps the same URL — and a browser
      // holding the old one will happily go on running code that was fixed
      // hours ago, which is a very expensive way to lose an afternoon.
      'Cache-Control': 'no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(buf);
  });
});

server.listen(PORT, function () {
  console.log('RingdateR web frontend at http://localhost:' + PORT + '/  (Ctrl+C to stop)');
});
