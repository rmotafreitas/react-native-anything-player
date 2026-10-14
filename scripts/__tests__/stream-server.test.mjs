import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('test-server delays are bounded, validated before control changes, and remain usable', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anythingplayer-server-'));
  const media = path.join(dir, 'media');
  fs.mkdirSync(media);
  // HTTP fault controls need payload bytes, rather than codec-generated media.
  for (const file of ['program.mp3', 'file.mp3', 'artwork.png', 'artwork2.png']) fs.writeFileSync(path.join(media, file), Buffer.alloc(64));
  fs.copyFileSync(new URL('../stream-server/server.mjs', import.meta.url), path.join(dir, 'server.mjs'));
  const child = spawn(process.execPath, [path.join(dir, 'server.mjs'), '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test stream server did not start')), 5000);
    child.stdout.on('data', (chunk) => {
      const match = /http:\/\/0\.0\.0\.0:(\d+)/.exec(chunk.toString());
      if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
    });
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited (${code})`)); });
  });
  const get = (suffix) => fetch(`http://127.0.0.1:${port}${suffix}`, { signal: AbortSignal.timeout(5000) });
  for (const endpoint of ['/live.mp3', '/file.mp3', '/control']) {
    for (const value of ['-1', '60001', 'Infinity', 'NaN', 'invalid']) {
      const response = await get(`${endpoint}?delay=${value}${endpoint === '/control' ? '&down=1' : ''}`);
      assert.equal(response.status, 400, `${endpoint} rejects ${value}`);
      await response.text();
    }
  }
  assert.equal((await (await get('/stats')).json()).state.down, false);
  assert.equal((await get('/control?delay=60000')).status, 200);
  const immediate = await get('/live.mp3?delay=0&endAfter=0');
  assert.equal(immediate.status, 200, 'explicit zero overrides a slow global control');
  await immediate.arrayBuffer();
  await get('/control?delay=0');
  const file = await get('/file.mp3?delay=1');
  assert.equal(file.status, 200);
  assert.equal((await file.arrayBuffer()).byteLength, 64);
  for (const query of ['metaint=0', 'metaint=NaN', 'titleEvery=0', 'slow=-1', 'slow=1e12', 'status=0']) {
    const response = await get('/live.mp3?' + query);
    assert.equal(response.status, 400, query);
    await response.text();
  }
  for (const range of ['bytes=100-200', 'bytes=30-10', 'bytes=999999999999999999-', 'invalid']) {
    const response = await fetch(`http://127.0.0.1:${port}/file.mp3`, { headers: { Range: range }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 416, range);
    await response.arrayBuffer();
  }
  const partial = await fetch(`http://127.0.0.1:${port}/file.mp3`, { headers: { Range: 'bytes=60-100' }, signal: AbortSignal.timeout(5000) });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 60-63/64');
  assert.equal((await partial.arrayBuffer()).byteLength, 4);
});
