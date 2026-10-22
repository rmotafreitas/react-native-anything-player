import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {
  bareNoCleartext,
  expoHttpLocal,
  read,
  runCliAsync,
  write,
} from './cli-fixtures.mjs';
import { isPrivateHost, probeStream } from '../../bin/cli/stream.mjs';

const ICY = {
  'content-type': 'audio/mpeg',
  'icy-metaint': '16000',
  'icy-name': 'Test Radio',
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'icy-metaint, icy-name, icy-genre',
};

function startServer(t) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/stream.mp3') {
      response.writeHead(200, ICY);
      response.end(Buffer.alloc(8192, 1));
      return;
    }
    if (url.pathname === '/no-cors') {
      const { 'access-control-allow-origin': _ignored, ...headers } = ICY;
      response.writeHead(200, headers);
      response.end(Buffer.alloc(4096, 1));
      return;
    }
    if (url.pathname === '/no-expose') {
      const { 'access-control-expose-headers': _ignored, ...headers } = ICY;
      response.writeHead(200, headers);
      response.end(Buffer.alloc(4096, 1));
      return;
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: '/stream.mp3' });
      response.end();
      return;
    }
    if (url.pathname === '/aac') {
      response.writeHead(200, { ...ICY, 'content-type': 'audio/aac' });
      response.end(Buffer.alloc(2048, 1));
      return;
    }
    if (url.pathname === '/other') {
      response.writeHead(200, { ...ICY, 'content-type': 'audio/ogg' });
      response.end(Buffer.alloc(2048, 1));
      return;
    }
    if (url.pathname === '/endless') {
      response.writeHead(200, ICY);
      // Stays open: the probe must close it after a few KB.
      const timer = setInterval(() => response.write(Buffer.alloc(1024, 1)), 5);
      response.on('close', () => clearInterval(timer));
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      resolve(server.address().port);
    });
  });
}

async function doctor(root, urls) {
  const args = ['doctor', '--json', '--cwd', root];
  for (const url of urls) args.push('--url', url);
  return runCliAsync(args, { cwd: root });
}

function ids(report) {
  return report.findings.map((finding) => finding.id);
}

test('a healthy stream passes every URL check', async (t) => {
  const port = await startServer(t);
  const root = expoHttpLocal(t);
  const url = `http://127.0.0.1:${port}/stream.mp3`;
  const result = await doctor(root, [url]);

  assert.equal(result.status, 0, JSON.stringify(result.json.findings));
  const [probe] = result.json.urls;
  assert.equal(probe.status, 200);
  assert.equal(probe.codec, 'mp3');
  assert.equal(probe.icyMetaInt, '16000');
  assert.equal(probe.headers['access-control-allow-origin'], '*');
  assert.equal(probe.finalUrl, url);
  assert.ok(probe.bytesRead <= 8192);
  assert.deepEqual(probe.redirects, []);
  assert.ok(!ids(result.json).includes('url-cors'));
  assert.ok(!ids(result.json).includes('url-ios-ats'));
});

test('missing CORS headers are a web warning', async (t) => {
  const port = await startServer(t);
  const root = expoHttpLocal(t);
  const result = await doctor(root, [`http://127.0.0.1:${port}/no-cors`]);
  const cors = result.json.findings.filter((item) => item.id === 'url-cors');
  assert.equal(cors.length, 1);
  assert.equal(cors[0].severity, 'warning');
  assert.match(cors[0].message, /Access-Control-Allow-Origin/);
  assert.equal(result.status, 0); // warnings do not fail
});

test('an unexposed icy-metaint loses titles on the web', async (t) => {
  const port = await startServer(t);
  const root = expoHttpLocal(t);
  const result = await doctor(root, [`http://127.0.0.1:${port}/no-expose`]);
  const cors = result.json.findings.filter((item) => item.id === 'url-cors');
  assert.equal(cors.length, 1);
  assert.match(cors[0].message, /Expose-Headers|expose/i);
});

test('redirects are reported and followed', async (t) => {
  const port = await startServer(t);
  const root = expoHttpLocal(t);
  const result = await doctor(root, [`http://127.0.0.1:${port}/redirect`]);
  const [probe] = result.json.urls;
  assert.equal(probe.redirects.length, 1);
  assert.equal(probe.redirects[0].status, 302);
  assert.match(probe.finalUrl, /\/stream\.mp3$/);
  assert.equal(probe.status, 200);
  const redirect = result.json.findings.find(
    (item) => item.id === 'url-redirect'
  );
  assert.equal(redirect.severity, 'info');
});

test('a 404 is an error and exits 1', async (t) => {
  const port = await startServer(t);
  const root = expoHttpLocal(t);
  const result = await doctor(root, [`http://127.0.0.1:${port}/missing`]);
  assert.equal(result.status, 1);
  const failed = result.json.findings.find((item) => item.id === 'url-request');
  assert.equal(failed.severity, 'error');
  assert.match(failed.message, /HTTP 404/);
});

test('AAC passes the Cast check, other codecs warn', async (t) => {
  const port = await startServer(t);
  const root = expoHttpLocal(t);
  const aac = await doctor(root, [`http://127.0.0.1:${port}/aac`]);
  assert.equal(aac.json.urls[0].codec, 'aac');
  assert.ok(!ids(aac.json).includes('url-cast'));

  const other = await doctor(root, [`http://127.0.0.1:${port}/other`]);
  assert.equal(other.json.urls[0].codec, 'other');
  const cast = other.json.findings.find((item) => item.id === 'url-cast');
  assert.equal(cast.severity, 'warning');
});

test('cleartext is checked against the project policy', async (t) => {
  const port = await startServer(t);
  const root = bareNoCleartext(t);
  const result = await doctor(root, [`http://127.0.0.1:${port}/stream.mp3`]);
  assert.equal(result.status, 1);
  const ats = result.json.findings.find((item) => item.id === 'url-ios-ats');
  const cleartext = result.json.findings.find(
    (item) => item.id === 'url-android-cleartext'
  );
  assert.equal(ats.severity, 'error');
  assert.equal(cleartext.severity, 'error');
  assert.match(ats.message, /127\.0\.0\.1/);
  assert.match(cleartext.fix.change, /network security config/);
});

test('the https scheme skips the cleartext checks', async (t) => {
  const port = await startServer(t);
  const root = expoHttpLocal(t);
  const result = await doctor(root, [`https://127.0.0.1:${port}/stream.mp3`]);
  assert.ok(!ids(result.json).includes('url-ios-ats'));
  assert.ok(!ids(result.json).includes('url-android-cleartext'));
  // Nothing speaks TLS on that port: the probe reports the failure instead.
  assert.equal(result.status, 1);
  assert.ok(ids(result.json).includes('url-request'));
});

test('package.json rnap.urls is probed only with --package-urls', async (t) => {
  const port = await startServer(t);
  const root = expoHttpLocal(t);
  const config = JSON.parse(read(root, 'package.json'));
  config.rnap = { urls: [`http://127.0.0.1:${port}/stream.mp3`] };
  write(root, 'package.json', `${JSON.stringify(config, null, 2)}\n`);

  const quiet = await doctor(root, []);
  assert.equal(quiet.json.urls.length, 0);
  const result = await runCliAsync(
    ['doctor', '--json', '--cwd', root, '--package-urls'],
    { cwd: root }
  );
  assert.equal(result.json.urls.length, 1);
  assert.equal(result.json.urls[0].status, 200);
});

test('redirects leave neither http(s) nor a public host for a private one', async () => {
  const redirectTo = (location) => async () =>
    new Response(null, { status: 302, headers: { location } });
  const toFile = await probeStream('https://radio.example/live', {
    fetchImpl: redirectTo('file:///etc/passwd'),
  });
  assert.match(toFile.error, /file: URL refused/);
  const toMetadata = await probeStream('https://radio.example/live', {
    fetchImpl: redirectTo('http://169.254.169.254/latest/meta-data'),
  });
  assert.match(toMetadata.error, /private address 169\.254\.169\.254 refused/);
});

test('private hosts as written in a URL', () => {
  for (const host of [
    'localhost',
    'a.localhost',
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '[::1]',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
  ])
    assert.equal(isPrivateHost(host), true, host);
  for (const host of [
    'radio.example',
    '8.8.8.8',
    '172.32.0.1',
    '192.169.0.1',
    '2001:db8::1',
    'fcdn.example',
  ])
    assert.equal(isPrivateHost(host), false, host);
});

test('the probe closes an endless stream after a few KB', async (t) => {
  const port = await startServer(t);
  const root = expoHttpLocal(t);
  const started = Date.now();
  const result = await doctor(root, [`http://127.0.0.1:${port}/endless`]);
  const elapsed = Date.now() - started;
  assert.equal(result.status, 0);
  assert.equal(result.json.urls[0].status, 200);
  assert.ok(elapsed < 8000, `probe took ${elapsed} ms`);
});

test('an invalid URL is an error, not a crash', async (t) => {
  const root = expoHttpLocal(t);
  const result = await doctor(root, ['not-a-url']);
  assert.equal(result.status, 1);
  assert.ok(ids(result.json).includes('url-invalid'));
});

test('several URLs are probed in order', async (t) => {
  const port = await startServer(t);
  const root = expoHttpLocal(t);
  const result = await doctor(root, [
    `http://127.0.0.1:${port}/stream.mp3`,
    `http://127.0.0.1:${port}/missing`,
  ]);
  assert.equal(result.json.urls.length, 2);
  assert.equal(result.json.urls[0].status, 200);
  assert.equal(result.json.urls[1].status, 404);
  assert.equal(result.status, 1);
  assert.ok(path.isAbsolute(result.json.cwd));
});
