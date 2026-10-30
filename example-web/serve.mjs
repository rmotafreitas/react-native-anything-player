#!/usr/bin/env node
// Serves the plain-web example and the built library, with no dependencies:
//
//   yarn prepare                                  # build lib/
//   node scripts/stream-server/server.mjs         # the test radio, :8765
//   node example-web/serve.mjs [port]             # this page, :4300
//   node example-web/serve.mjs 4400 example-expo/dist-web   # another static
//                                                 # site (the Expo web export)
//
// The page is on its own origin, so the test radio is cross-origin, as a
// real station would be (CORS is exercised for real).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const port = Number(process.argv[2] ?? process.env.PORT ?? 4300);
/** Serve this directory instead (relative to the repository root). */
const site = process.argv[3] ? join(root, process.argv[3]) : null;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

/** hls.js, from node_modules: the example's HLS player outside Safari (an app would bundle it). */
const HLS_JS = join(root, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
/** Shaka Player, from node_modules: the example's DASH player (an app would bundle it). */
const SHAKA_JS = join(root, 'node_modules', 'shaka-player', 'dist', 'shaka-player.compiled.js');

/** `/lib/…` is the built library; everything else is this folder (or `site`). */
function resolve(pathname) {
  if (!site && pathname === '/vendor/hls.min.js') return HLS_JS;
  if (!site && pathname === '/vendor/shaka-player.compiled.js') return SHAKA_JS;
  if (site) {
    const file = normalize(join(site, decodeURIComponent(pathname.slice(1)) || 'index.html'));
    return file.startsWith(site + sep) ? file : null;
  }
  const inLib = pathname.startsWith('/lib/');
  const base = inLib ? join(root, 'lib') : here;
  const relative = inLib ? pathname.slice('/lib/'.length) : pathname.slice(1) || 'index.html';
  const file = normalize(join(base, decodeURIComponent(relative)));
  return file.startsWith(base + sep) ? file : null;
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/__health') {
    res.writeHead(200).end('ok');
    return;
  }
  const file = resolve(pathname);
  if (!file || file.endsWith('serve.mjs')) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    const headers = {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    };
    // Browsers seek a file with Range requests; without them a seek restarts it.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, body.length - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (start >= body.length || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${body.length}` });
      res.end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, () => console.log(`RNAP web example on http://localhost:${port}`));
