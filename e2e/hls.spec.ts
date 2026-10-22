import { expect, test, type Page } from '@playwright/test';
import { RADIO, diagnostics, events, radio, state } from './helpers';

// HLS in real browsers: Safari plays it natively; everywhere else RNAP gives
// the <audio> element to hls.js (the copy in node_modules, loaded by the
// example page and registered with `configureHls`). The test radio serves the
// program as packed-MP3 segments with an ID3 title at the start of each.

test.beforeEach(async ({ page }) => {
  await radio('/control?down=0&stall=0&delay=0');
  await page.goto('/');
});

/**
 * Whether hls.js plays this page's playlist: it does wherever the browser has
 * no HLS of its own, and in Chromium, whose native HLS cannot open the test
 * radio's packed-MP3 playlists (RNAP then tries hls.js). Safari's own HLS
 * plays them, and does not hand its ID3 titles to the page.
 */
const usesHlsJs = async (page: Page) =>
  (await diagnostics(page)).includes('hls.js');

const titles = async (page: Page) =>
  (await events(page, 'metadata'))
    .map((e) => (e.metadata as { title: string | null }).title)
    .filter((title): title is string => !!title);

test('plays an on-demand playlist, seeks it, and reads its ID3 titles', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'HLS (on demand)' }).click();
  await expect.poll(() => state(page), { timeout: 20_000 }).toBe('playing');
  expect(await page.evaluate(() => window.rnap.player.status)).toMatchObject({
    isLive: false,
    seekable: true,
  });
  expect(
    await page.evaluate(() => window.rnap.player.getProgress().duration)
  ).toBeCloseTo(116.8, 0);

  await page.evaluate(() => window.rnap.player.seekTo(60));
  await expect
    .poll(
      () => page.evaluate(() => window.rnap.player.getProgress().position),
      {
        timeout: 15_000,
      }
    )
    .toBeGreaterThanOrEqual(60);
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');

  if (!(await usesHlsJs(page))) return; // Safari's own HLS does not hand its ID3 to the page
  expect(await diagnostics(page)).toContain('hls.js');
  expect((await radio('/stats')).byPath['/hls/vod.m3u8']).toBeGreaterThan(0);
  await expect
    .poll(async () => (await titles(page)).length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect((await titles(page))[0]).toMatch(/\(#\d+\)$/);
});

test('plays a live playlist as live, with titles that change', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'HLS (live)' }).click();
  await expect.poll(() => state(page), { timeout: 20_000 }).toBe('playing');
  expect(await page.evaluate(() => window.rnap.player.status)).toMatchObject({
    isLive: true,
    seekable: false,
  });
  const progress = await page.evaluate(() => window.rnap.player.getProgress());
  expect(progress.duration).toBeNull();
  if (!(await usesHlsJs(page))) return;

  // A segment is 4.5 s long and carries its own title.
  await expect
    .poll(async () => new Set(await titles(page)).size, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
});

test('finds a playlist served without .m3u8 by its content type', async ({
  page,
}) => {
  await page.evaluate(
    (url) => window.rnap.player.load(url, { autoplay: true }),
    `${RADIO}/hls/stream`
  );
  await expect.poll(() => state(page), { timeout: 20_000 }).toBe('playing');
  // Read through fetch() first, found to be a playlist by its Content-Type,
  // then handed to hls.js where the element cannot play it.
  if (await usesHlsJs(page))
    expect(await diagnostics(page)).toContain('plain playback');
});

test('says what to install where there is no hls.js', async ({ page }) => {
  await page.route('**/vendor/hls.min.js', (route) => route.abort());
  await page.goto('/');
  expect(await page.evaluate(() => 'Hls' in window)).toBe(false);
  await page.getByRole('button', { name: 'HLS (on demand)' }).click();
  await expect
    .poll(() => state(page), { timeout: 15_000 })
    .toMatch(/^(playing|error)$/);
  test.skip(
    (await state(page)) === 'playing',
    'This browser plays the playlist itself: nothing to install'
  );
  const error = await page.evaluate(() => window.rnap.player.status.error);
  expect(error).toMatchObject({
    code: 'UNSUPPORTED_FORMAT',
    recoverable: false,
  });
  expect(error?.message).toContain('configureHls');
});

test('recovers a live playlist from an outage under the engine’s backoff', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await page.getByRole('button', { name: 'HLS (live)' }).click();
  await expect.poll(() => state(page), { timeout: 20_000 }).toBe('playing');
  test.skip(
    !(await usesHlsJs(page)),
    'This browser plays the playlist itself: the platform recovers it'
  );
  await radio('/control?down=1');
  // hls.js retries its fragments, then reports a fatal error; the engine
  // takes over (it does not leave it to hls.js).
  await expect
    .poll(async () => (await events(page, 'error')).length, { timeout: 90_000 })
    .toBeGreaterThan(0);
  expect(['reconnecting', 'buffering']).toContain(await state(page));
  await radio('/control?down=0');
  await expect.poll(() => state(page), { timeout: 60_000 }).toBe('playing');
});
