#!/usr/bin/env node
// RNAP test stream server — a controllable ICY/Icecast-style radio plus a
// static file host, used by the example app and the network torture tests.
// No dependencies. Run: `node scripts/stream-server/server.mjs [port]`.
//
// Live stream:  GET /live.mp3   (MP3 128 kbps, paced in real time, shared
//               "on air" timeline so every connection joins at the live point)
//               GET /live.aac   (ADTS AAC 64 kbps, the same program; only
//               when media/program.aac was generated)
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
//   ?noCors=1           omit CORS headers (browsers must fall back to <audio>)
// HLS:          GET /hls/vod.m3u8   the program as 4.5 s packed-MP3 segments,
//                                   with an ID3 title at the start of each
//               GET /hls/live.m3u8  the same as a live sliding window
//               GET /hls/stream     the live playlist without the extension
//                                   (found by its Content-Type)
//               GET /hls/seg-N.mp3  one segment (N counts on, looping)
// Files:        GET /file.mp3, /program.mp3, /artwork.png, /artwork2.png,
//               /video-360.mp4, /video-720.mp4, /video-audio.m4a, /subs.srt,
//               /subs.vtt (the video ones when generated)
// Video HLS:    GET /video-hls/master.m3u8  360p + 720p, audio in English and
//               Spanish, WebVTT subtitles in English and Portuguese
// Video DASH:   GET /video-dash/manifest.mpd  the same as CMAF DASH (360p, 720p)
//               (Range supported; `?delay=MS` slows the response)
// Remux:        GET /remux/movie.mkv (two audio languages, SubRip and ASS),
//               /remux/movie.ts, /remux/movie.webm (Range supported)
//               GET /live.ts   a live MPEG-TS channel (paced, looping)
// Control:      GET /control?down=1|0     refuse every new stream connection
//               GET /control?stall=1|0    freeze every open stream
//               GET /control?drop=1       destroy every open stream now
//               GET /control?delay=MS     answer every new stream connection
//                                         MS late (a slow reconnect)
// Stats:        GET /stats → { active, total, byPath, events[], capabilities }
// CORS:         every response allows any origin and exposes the ICY headers,
//               as Icecast does, so browsers can read streams with fetch().
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const media = (name) => readFileSync(join(here, 'media', name));
const PROGRAM = media('program.mp3');
/** Optional (generate-media.sh): the same program as AAC, for /live.aac. */
const PROGRAM_AAC = existsSync(join(here, 'media', 'program.aac'))
  ? media('program.aac')
  : null;
const FILES = {
  '/file.mp3': { body: media('file.mp3'), type: 'audio/mpeg' },
  '/program.mp3': { body: PROGRAM, type: 'audio/mpeg' },
  '/artwork.png': { body: media('artwork.png'), type: 'image/png' },
  '/artwork2.png': { body: media('artwork2.png'), type: 'image/png' },
};
/** Optional (generate-media.sh): the video fixtures. */
const VIDEO_FILES = {
  '/video-360.mp4': 'video/mp4',
  '/video-720.mp4': 'video/mp4',
  '/video-audio.m4a': 'audio/mp4',
  '/subs.srt': 'application/x-subrip; charset=utf-8',
  '/subs.vtt': 'text/vtt; charset=utf-8',
};
for (const [path, type] of Object.entries(VIDEO_FILES)) {
  if (existsSync(join(here, 'media', path.slice(1))))
    FILES[path] = { body: media(path.slice(1)), type };
}
/** Optional (generate-media.sh): the video as HLS with its own tracks, at /video-hls/. */
const HLS_VIDEO_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.vtt': 'text/vtt; charset=utf-8',
};
if (existsSync(join(here, 'media', 'hls-video'))) {
  for (const name of readdirSync(join(here, 'media', 'hls-video'))) {
    const type = HLS_VIDEO_TYPES[extname(name)];
    if (type)
      FILES[`/video-hls/${name}`] = { body: media(`hls-video/${name}`), type };
  }
}
/** Optional (generate-media.sh): the video as CMAF DASH, at /video-dash/. */
const DASH_VIDEO_TYPES = {
  '.mpd': 'application/dash+xml',
  '.m4s': 'video/iso.segment',
};
if (existsSync(join(here, 'media', 'dash-video'))) {
  for (const name of readdirSync(join(here, 'media', 'dash-video'))) {
    const type = DASH_VIDEO_TYPES[extname(name)];
    if (type)
      FILES[`/video-dash/${name}`] = { body: media(`dash-video/${name}`), type };
  }
}
/** Optional (generate-media.sh): Matroska, MPEG-TS and WebM, at /remux/. */
const REMUX_TYPES = {
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.webm': 'video/webm',
};
/** A minute of MPEG-TS sent as a live channel (/live.ts), looping. */
let LIVE_TS = null;
if (existsSync(join(here, 'media', 'remux'))) {
  for (const name of readdirSync(join(here, 'media', 'remux'))) {
    const type = REMUX_TYPES[extname(name)];
    if (type && name !== 'live.ts')
      FILES[`/remux/${name}`] = { body: media(`remux/${name}`), type };
  }
  if (existsSync(join(here, 'media', 'remux', 'live.ts')))
    LIVE_TS = media('remux/live.ts');
}
const BYTES_PER_SECOND = 128_000 / 8;
const LIVE_STREAMS = {
  '/live.mp3': { body: PROGRAM, type: 'audio/mpeg', rate: BYTES_PER_SECOND },
  '/live': { body: PROGRAM, type: 'audio/mpeg', rate: BYTES_PER_SECOND },
  ...(PROGRAM_AAC
    ? {
        '/live.aac': { body: PROGRAM_AAC, type: 'audio/aac', rate: 8_000 },
      }
    : {}),
  ...(LIVE_TS
    ? {
        '/live.ts': {
          body: LIVE_TS,
          type: 'video/mp2t',
          rate: Math.ceil(LIVE_TS.length / 60),
        },
      }
    : {}),
};
const TICK_MS = 100;
const MAX_DELAY_MS = 60_000;
const STARTED_AT = Date.now();
const port = Number(process.argv[2] ?? process.env.PORT ?? 8765);

const TITLES = [
  ['RNAP Test', 'Signal One'],
  ['Björk', 'Jóga'],
  ["Guns N' Roses", "Sweet Child O' Mine"],
  ['YOASOBI', 'アイドル'],
  ['Café del Mar', 'Olé; Sí'],
  ['RNAP Test', 'Signal Six'],
];

const state = { down: false, stall: false, delay: 0 };
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
    charset === 'latin1' ? 'latin1' : 'utf8'
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
  const { body: program, type: contentType, rate: bitrate } =
    LIVE_STREAMS[url.pathname];
  const status = Number(q.get('status') ?? 200);
  const delay = Number(q.get('delay') ?? state.delay);
  if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_MS) {
    res.writeHead(400);
    res.end('delay must be between 0 and 60000 ms');
    return;
  }
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
  const rate = q.has('slow') ? Number(q.get('slow')) : bitrate;
  if (
    !Number.isInteger(status) ||
    status < 100 ||
    status > 599 ||
    !Number.isSafeInteger(metaint) ||
    metaint < 1 ||
    !Number.isFinite(titleEvery) ||
    titleEvery <= 0 ||
    !Number.isFinite(rate) ||
    rate <= 0 ||
    rate > bitrate
  ) {
    res.writeHead(400);
    res.end('invalid stream controls');
    return;
  }

  const start = () => {
    if (status !== 200) {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(`status ${status}`);
      record({ kind: 'status', status, path: url.pathname });
      return;
    }
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'close',
      'icy-name': 'RNAP Test Radio',
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
    record({
      kind: 'open',
      id: conn.id,
      meta: wantsMeta,
      ua: req.headers['user-agent'] ?? '',
    });

    // Join the shared on-air timeline at the live point.
    const onAirSeconds = (Date.now() - STARTED_AT) / 1000;
    let offset = Math.floor(onAirSeconds * bitrate) % program.length;
    let untilMeta = metaint;
    let blockIndex = 0;
    let lastTitle = null;
    const openedAt = Date.now();
    // Prefill ~2 s like real servers do (fast start), then real time.
    let budget = bitrate * 2;

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
      const stalledByParam =
        stallAfter != null &&
        elapsed >= stallAfter &&
        elapsed < stallAfter + stallFor;
      if (state.stall || stalledByParam) return;
      budget += (rate * TICK_MS) / 1000;
      let chunk = Math.floor(budget);
      if (chunk <= 0) return;
      budget -= chunk;
      const parts = [];
      while (chunk > 0) {
        const take = Math.min(
          chunk,
          wantsMeta ? untilMeta : chunk,
          program.length - offset
        );
        parts.push(program.subarray(offset, offset + take));
        offset = (offset + take) % program.length;
        chunk -= take;
        conn.sent += take;
        if (wantsMeta) {
          untilMeta -= take;
          if (untilMeta === 0) {
            const title = titleAt((Date.now() - STARTED_AT) / 1000, titleEvery);
            if (title !== lastTitle) {
              lastTitle = title;
              blockIndex += 1;
              parts.push(
                metadataBlock(
                  title,
                  charset,
                  malformed && blockIndex % 2 === 0,
                  req.headers.host ?? `localhost:${port}`
                )
              );
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

// ── HLS ──
// The program cut into packed-MP3 segments of whole frames (an HLS audio
// stream needs no container for MP3; hls.js and Safari read it as it is), each
// opened by an ID3 tag with the title that plays in it, as a station would tag
// its segments.

const SEGMENT_FRAMES = 172; // 172 × 1152 / 44100 ≈ 4.493 s
const SEGMENT_SECONDS = (SEGMENT_FRAMES * 1152) / 44100;
const MPEG1_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG1_RATES = [44100, 48000, 32000];

/** Frame offsets of an MPEG-1 Layer III file without tags (what generate-media.sh makes). */
function mp3Frames(buffer) {
  const frames = [];
  for (let at = 0; at + 4 <= buffer.length; ) {
    const bitrate = MPEG1_BITRATES[buffer[at + 2] >> 4] * 1000;
    const rate = MPEG1_RATES[(buffer[at + 2] >> 2) & 3];
    if (buffer[at] !== 0xff || !bitrate || !rate) {
      at += 1;
      continue;
    }
    const length = Math.floor((144 * bitrate) / rate) + ((buffer[at + 2] >> 1) & 1);
    frames.push([at, length]);
    at += length;
  }
  return frames;
}

const SEGMENTS = (() => {
  const frames = mp3Frames(PROGRAM);
  const out = [];
  for (let i = 0; i + SEGMENT_FRAMES <= frames.length; i += SEGMENT_FRAMES) {
    const [start] = frames[i];
    const [last, lastLength] = frames[i + SEGMENT_FRAMES - 1];
    out.push(PROGRAM.subarray(start, last + lastLength));
  }
  return out;
})();

const syncsafe = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);

/** An ID3v2.4 tag with UTF-8 TIT2 and TPE1 frames. */
function id3Tag(title, artist) {
  const frame = (id, text) => {
    const body = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    return Buffer.concat([Buffer.from(id), syncsafe(body.length), Buffer.from([0, 0]), body]);
  };
  const frames = Buffer.concat([frame('TIT2', title), frame('TPE1', artist)]);
  return Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0]), syncsafe(frames.length), frames]);
}

function segment(n) {
  const [artist, title] = TITLES[n % TITLES.length];
  return Buffer.concat([id3Tag(`${title} (#${n})`, artist), SEGMENTS[n % SEGMENTS.length]]);
}

/** A playlist for segments `first`…`last`; `ended` for on-demand. */
function playlist(first, last, ended) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(SEGMENT_SECONDS)}`,
    `#EXT-X-MEDIA-SEQUENCE:${first}`,
  ];
  for (let n = first; n <= last; n++)
    lines.push(`#EXTINF:${SEGMENT_SECONDS.toFixed(3)},`, `seg-${n}.mp3`);
  if (ended) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/** The newest finished segment of the live window (it began 10 minutes ago, so there are always enough). */
const liveEdge = () =>
  Math.floor((Date.now() - STARTED_AT + 600_000) / 1000 / SEGMENT_SECONDS) - 1;

function hls(req, res, url) {
  if (state.down) {
    record({ kind: 'refused', path: url.pathname });
    req.socket.destroy();
    return;
  }
  const name = url.pathname.slice('/hls/'.length);
  const m3u8 = 'application/vnd.apple.mpegurl';
  let type = m3u8;
  let body;
  const numbered = /^seg-(\d+)\.mp3$/.exec(name);
  if (name === 'vod.m3u8') body = playlist(0, SEGMENTS.length - 1, true);
  else if (name === 'live.m3u8' || name === 'stream')
    body = playlist(liveEdge() - 3, liveEdge(), false);
  else if (numbered) {
    type = 'audio/mpeg';
    body = segment(Number(numbered[1]));
  } else {
    res.writeHead(404);
    return res.end('not found');
  }
  stats.byPath[url.pathname] = (stats.byPath[url.pathname] ?? 0) + 1;
  record({ kind: 'hls', path: url.pathname });
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function staticFile(req, res, url) {
  const file = FILES[url.pathname];
  const delay = Number(url.searchParams.get('delay') ?? 0);
  if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_MS) {
    res.writeHead(400);
    res.end('delay must be between 0 and 60000 ms');
    return;
  }
  const send = () => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (req.headers.range && !range) {
      res.writeHead(416, { 'Content-Range': `bytes */${file.body.length}` });
      return res.end();
    }
    if (range) {
      const startByte = Number(range[1]);
      const requestedEnd = range[2] ? Number(range[2]) : file.body.length - 1;
      if (
        !Number.isSafeInteger(startByte) ||
        !Number.isSafeInteger(requestedEnd) ||
        startByte >= file.body.length ||
        requestedEnd < startByte
      ) {
        res.writeHead(416, { 'Content-Range': `bytes */${file.body.length}` });
        return res.end();
      }
      const endByte = Math.min(requestedEnd, file.body.length - 1);
      res.writeHead(206, {
        'Content-Type': file.type,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${startByte}-${endByte}/${file.body.length}`,
        'Content-Length': endByte - startByte + 1,
      });
      res.end(file.body.subarray(startByte, endByte + 1));
    } else {
      res.writeHead(200, {
        'Content-Type': file.type,
        'Accept-Ranges': 'bytes',
        'Content-Length': file.body.length,
      });
      res.end(file.body);
    }
    record({
      kind: 'file',
      path: url.pathname,
      range: req.headers.range ?? null,
    });
  };
  if (delay > 0) {
    const timer = setTimeout(send, delay);
    req.on('close', () => clearTimeout(timer));
  } else send();
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Icy-MetaData, Range, User-Agent, Authorization',
  'Access-Control-Expose-Headers':
    'icy-metaint, icy-name, icy-genre, icy-br, icy-url, Content-Range, Accept-Ranges',
};

const server = createServer((req, res) => {
  // The Host header is unrelated to route selection and can be malformed.
  const url = new URL(req.url, 'http://localhost');
  if (!url.searchParams.has('noCors')) {
    for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  if (LIVE_STREAMS[url.pathname]) return liveStream(req, res, url);
  if (url.pathname.startsWith('/hls/')) return hls(req, res, url);
  if (FILES[url.pathname]) return staticFile(req, res, url);
  if (url.pathname === '/control') {
    const q = url.searchParams;
    const delay = Number(q.get('delay') ?? state.delay);
    if (!Number.isFinite(delay) || delay < 0 || delay > MAX_DELAY_MS) {
      res.writeHead(400);
      return res.end('delay must be between 0 and 60000 ms');
    }
    if (q.has('down')) state.down = q.get('down') === '1';
    if (q.has('stall')) state.stall = q.get('stall') === '1';
    if (q.has('delay')) state.delay = delay;
    if (q.get('drop') === '1') [...active].forEach((c) => c.finish?.(true));
    record({ kind: 'control', ...Object.fromEntries(q) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(state));
  }
  if (url.pathname === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(
      JSON.stringify(
        {
          ...stats,
          active: active.size,
          activeIds: [...active].map((c) => c.id),
          state,
          // Optional media this checkout has (see generate-media.sh).
          capabilities: { aac: PROGRAM_AAC != null },
        },
        null,
        2
      )
    );
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(port, '0.0.0.0', () => {
  const boundPort = server.address().port;
  console.log(
    `anythingplayer test stream server on http://0.0.0.0:${boundPort} (Android emulator: http://10.0.2.2:${boundPort})`
  );
});
