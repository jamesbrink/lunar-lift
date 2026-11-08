#!/usr/bin/env node
/* LUNAR LIFT dev server — zero dependencies, no-cache, hot reload.
   Watches index.html, css/ and js/; every edit pushes a `reload` event down
   an EventSource that the injected client below turns into location.reload(). */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2]) || 8078;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const clients = new Set();
function broadcast() {
  for (const res of clients) res.write('event: reload\ndata: "changed"\n\n');
}

let pending = null;
function scheduleReload() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    console.log('[reload] files changed');
    broadcast();
  }, 150);
}

function watchTree(dir) {
  if (!fs.existsSync(dir)) return;
  fs.watch(dir, { recursive: true }, (event, file) => {
    if (!file) return;
    const ext = path.extname(file).toLowerCase();
    if (ext === '.js' || ext === '.css' || ext === '.html') scheduleReload();
  });
}
watchTree(path.join(ROOT, 'js'));
watchTree(path.join(ROOT, 'css'));
fs.watch(path.join(ROOT, 'index.html'), scheduleReload);

const RELOAD_CLIENT = `<script>(function(){try{const s=new EventSource('/__reload');s.addEventListener('reload',()=>location.reload());}catch(e){}})();</script>`;

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (url === '/__reload') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write('event: ready\ndata: ok\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 not found'); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    });
    if (ext === '.html') res.write(buf.toString().replace('</body>', RELOAD_CLIENT + '</body>'));
    else res.write(buf);
    res.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LUNAR LIFT on http://127.0.0.1:${PORT}/index.html  (hot reload active)`);
});
