#!/usr/bin/env node
// Airwave test stream server — a controllable ICY/Icecast-style radio plus a
// static file host, used by the example app and the network torture tests.
// No dependencies. Run: `node scripts/stream-server/server.mjs [port]`.
//
// Live stream:  GET /live.mp3   (MP3 128 kbps, paced in real time, shared
//               "on air" timeline so every connection joins at the live point)
//   ?metaint=16000      ICY metadata interval (sent only if the client asks
//                       with `Icy-MetaData: 1`)
//   ?titleEvery=10      seconds between StreamTitle changes
//   ?charset=latin1     encode titles as ISO-8859-1 instead of UTF-8
//   ?malformed=1        corrupt every other metadata block
//   ?noMeta=1           never send metadata (no icy-metaint header)
//   ?stallAfter=S&stallFor=S   stop sending (socket stays open) after S s
//   ?dropAfter=S        destroy the socket after S s
//   ?endAfter=S         end the response cleanly after S s
//   ?slow=BYTES_PER_S   throttle below the bitrate (buffering forever)
//   ?status=503         answer with this HTTP status instead
//   ?delay=MS           wait before sending headers
// Files:        GET /file.mp3, /program.mp3, /artwork.png, /artwork2.png
//               (Range supported; `?delay=MS` slows the response)
// Control:      GET /control?down=1|0     refuse every new stream connection
//               GET /control?stall=1|0    freeze every open stream
//               GET /control?drop=1       destroy every open stream now
// Stats:        GET /stats → { active, total, byPath, events[] }
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const media = (name) => readFileSync(join(here, 'media', name));
const PROGRAM = media('program.mp3');
const FILES = {
  '/file.mp3': { body: media('file.mp3'), type: 'audio/mpeg' },
  '/program.mp3': { body: PROGRAM, type: 'audio/mpeg' },
  '/artwork.png': { body: media('artwork.png'), type: 'image/png' },
  '/artwork2.png': { body: media('artwork2.png'), type: 'image/png' },
};
const BYTES_PER_SECOND = 128_000 / 8;
const TICK_MS = 100;
const STARTED_AT = Date.now();
const port = Number(process.argv[2] ?? process.env.PORT ?? 8765);

const TITLES = [
  ['Airwave Test', 'Signal One'],
  ['Björk', 'Jóga'],
  ['Guns N\' Roses', 'Sweet Child O\' Mine'],
  ['YOASOBI', 'アイドル'],
  ['Café del Mar', 'Olé; Sí'],
  ['Airwave Test', 'Signal Six'],
];

const state = { down: false, stall: false };
const active = new Set();
const stats = { total: 0, byPath: {}, events: [] };
const record = (event) => {
  stats.events.push({ t: Date.now(), ...event });
  if (stats.events.length > 500) stats.events.shift();
};

function titleAt(seconds, every) {
  const index = Math.floor(seconds / every) % TITLES.length;
  const [artist, title] = TITLES[index];
  return `${artist} - ${title} (#${Math.floor(seconds / every)})`;
}

function metadataBlock(text, charset, malformed, host) {
  const payload = Buffer.from(
    `StreamTitle='${text}';StreamUrl='http://${host}/artwork.png';`,
    charset === 'latin1' ? 'latin1' : 'utf8',
  );
  const blocks = Math.ceil(payload.length / 16);
  const out = Buffer.alloc(1 + blocks * 16);
  out[0] = blocks;
  payload.copy(out, 1);
  if (malformed) {
    // Length byte that overstates the block: the parser must not crash.
    out.fill(0xff, 1, Math.min(out.length, 8));
  }
  return out;
}

function liveStream(req, res, url) {
  const q = url.searchParams;
  const status = Number(q.get('status') ?? 200);
  const delay = Number(q.get('delay') ?? 0);
  if (state.down) {
    record({ kind: 'refused', path: url.pathname });
    req.socket.destroy();
    return;
  }
  const wantsMeta = req.headers['icy-metadata'] === '1' && !q.has('noMeta');
  const metaint = Number(q.get('metaint') ?? 16000);
  const titleEvery = Number(q.get('titleEvery') ?? 10);
  const charset = q.get('charset') ?? 'utf8';
  const malformed = q.get('malformed') === '1';
  const stallAfter = q.has('stallAfter') ? Number(q.get('stallAfter')) : null;
  const stallFor = Number(q.get('stallFor') ?? 1e9);
  const dropAfter = q.has('dropAfter') ? Number(q.get('dropAfter')) : null;
  const endAfter = q.has('endAfter') ? Number(q.get('endAfter')) : null;
  const rate = q.has('slow') ? Number(q.get('slow')) : BYTES_PER_SECOND;

  const start = () => {
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(`status ${status}`);
      record({ kind: 'status', status, path: url.pathname });
      return;
    }
    const headers = {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'close',
      'icy-name': 'Airwave Test Radio',
      'icy-genre': 'Test Tones',
      'icy-br': '128',
      'icy-url': `http://localhost:${port}`,
    };
    if (wantsMeta) headers['icy-metaint'] = String(metaint);
    // Like Icecast: a raw body until the connection closes, no chunked framing.
    res.useChunkedEncodingByDefault = false;
    res.writeHead(200, headers);

    const conn = { req, res, id: ++stats.total, path: url.pathname, sent: 0 };
    active.add(conn);
    stats.byPath[url.pathname] = (stats.byPath[url.pathname] ?? 0) + 1;
    record({ kind: 'open', id: conn.id, meta: wantsMeta, ua: req.headers['user-agent'] ?? '' });

    // Join the shared on-air timeline at the live point.
    const onAirSeconds = (Date.now() - STARTED_AT) / 1000;
    let offset = Math.floor(onAirSeconds * BYTES_PER_SECOND) % PROGRAM.length;
    let untilMeta = metaint;
    let blockIndex = 0;
    let lastTitle = null;
    const openedAt = Date.now();
    // Prefill ~2 s like real servers do (fast start), then real time.
    let budget = BYTES_PER_SECOND * 2;

    const timer = setInterval(() => {
      const elapsed = (Date.now() - openedAt) / 1000;
      if (dropAfter != null && elapsed >= dropAfter) {
        record({ kind: 'drop', id: conn.id });
        return finish(true);
      }
      if (endAfter != null && elapsed >= endAfter) {
        record({ kind: 'end', id: conn.id });
        return finish(false);
      }
      const stalledByParam = stallAfter != null && elapsed >= stallAfter && elapsed < stallAfter + stallFor;
      if (state.stall || stalledByParam) return;
      budget += (rate * TICK_MS) / 1000;
      let chunk = Math.floor(budget);
      if (chunk <= 0) return;
      budget -= chunk;
      const parts = [];
      while (chunk > 0) {
        const take = Math.min(chunk, wantsMeta ? untilMeta : chunk, PROGRAM.length - offset);
        parts.push(PROGRAM.subarray(offset, offset + take));
        offset = (offset + take) % PROGRAM.length;
        chunk -= take;
        conn.sent += take;
        if (wantsMeta) {
          untilMeta -= take;
          if (untilMeta === 0) {
            const title = titleAt((Date.now() - STARTED_AT) / 1000, titleEvery);
            if (title !== lastTitle) {
              lastTitle = title;
              blockIndex += 1;
              parts.push(metadataBlock(title, charset, malformed && blockIndex % 2 === 0, req.headers.host ?? `localhost:${port}`));
            } else {
              parts.push(Buffer.from([0]));
            }
            untilMeta = metaint;
          }
        }
      }
      res.write(Buffer.concat(parts));
    }, TICK_MS);

    const finish = (destroy) => {
      clearInterval(timer);
      if (!active.has(conn)) return;
      active.delete(conn);
      record({ kind: 'close', id: conn.id, sent: conn.sent });
      if (destroy) req.socket.destroy();
      else res.end();
    };
    conn.finish = finish;
    req.on('close', () => finish(false));
  };
  if (delay > 0) {
    const timer = setTimeout(() => {
      // The client may have given up while we were "slow".
      if (!req.socket.destroyed) start();
    }, delay);
    req.on('close', () => clearTimeout(timer));
  } else {
    start();
  }
}

function staticFile(req, res, url) {
  const file = FILES[url.pathname];
  const delay = Number(url.searchParams.get('delay') ?? 0);
  const send = () => {
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const startByte = Number(range[1]);
      const endByte = range[2] ? Number(range[2]) : file.body.length - 1;
      res.writeHead(206, {
        'Content-Type': file.type,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${startByte}-${endByte}/${file.body.length}`,
        'Content-Length': endByte - startByte + 1,
      });
      res.end(file.body.subarray(startByte, endByte + 1));
    } else {
      res.writeHead(200, { 'Content-Type': file.type, 'Accept-Ranges': 'bytes', 'Content-Length': file.body.length });
      res.end(file.body);
    }
    record({ kind: 'file', path: url.pathname, range: req.headers.range ?? null });
  };
  if (delay > 0) setTimeout(send, delay);
  else send();
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/live.mp3' || url.pathname === '/live') return liveStream(req, res, url);
  if (FILES[url.pathname]) return staticFile(req, res, url);
  if (url.pathname === '/control') {
    const q = url.searchParams;
    if (q.has('down')) state.down = q.get('down') === '1';
    if (q.has('stall')) state.stall = q.get('stall') === '1';
    if (q.get('drop') === '1') [...active].forEach((c) => c.finish?.(true));
    record({ kind: 'control', ...Object.fromEntries(q) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state));
  }
  if (url.pathname === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify({ ...stats, active: active.size, activeIds: [...active].map((c) => c.id), state }, null, 2),
    );
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '0.0.0.0', () => {
  console.log(`airwave test stream server on http://0.0.0.0:${port} (Android emulator: http://10.0.2.2:${port})`);
});
