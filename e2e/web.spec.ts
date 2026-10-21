import { expect, test } from '@playwright/test';
import { NO_MSE, diagnostics, events, mseMp3, radio, state } from './helpers';

test.beforeEach(async ({ page }) => {
  await radio('/control?down=0&stall=0&delay=0');
  await page.goto('/');
});

test('plays an ICY radio through MSE, with titles timed to the audio', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Test radio (ICY)' }).click();
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  if (!(await mseMp3(page))) {
    // Graceful degradation: the stream plays on <audio>, without metadata.
    expect(await diagnostics(page)).toContain('plain playback');
    test.info().annotations.push({ type: 'degraded', description: NO_MSE });
    return;
  }

  // Titles change every 4 s on the test radio: at least two, decoded from the stream.
  await expect
    .poll(
      async () =>
        new Set(
          (await events(page, 'metadata'))
            .map((e) => (e.metadata as { title: string | null }).title)
            .filter(Boolean)
        ).size,
      {
        timeout: 15_000,
      }
    )
    .toBeGreaterThanOrEqual(2);
  const metadata = await page.evaluate(() => window.rnap.player.metadata);
  expect(metadata).toMatchObject({
    station: 'RNAP Test Radio',
    genre: 'Test Tones',
  });
  expect(metadata?.raw?.StreamTitle).toBeTruthy();
  expect(await diagnostics(page)).not.toContain('plain playback');

  const progress = await page.evaluate(() => window.rnap.player.getProgress());
  expect(progress.liveOffset).toBeGreaterThan(0);

  // The browser's media controls show what is heard.
  const session = await page.evaluate(() => ({
    title: navigator.mediaSession.metadata?.title,
    state: navigator.mediaSession.playbackState,
  }));
  expect(session).toEqual({ title: metadata?.title, state: 'playing' });
});

test('falls back to a plain <audio> element without CORS', async ({ page }) => {
  await page
    .getByRole('button', { name: 'Test radio without CORS (plain <audio>)' })
    .click();
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  expect(await diagnostics(page)).toContain('plain playback');
  expect(
    await page.evaluate(() => window.rnap.player.getProgress().liveOffset)
  ).toBeNull();
});

test('plays and seeks a file', async ({ page }) => {
  await page.getByRole('button', { name: 'Remote file' }).click();
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  expect(await page.evaluate(() => window.rnap.player.status)).toMatchObject({
    seekable: true,
    isLive: false,
  });
  await page.evaluate(() => window.rnap.player.seekTo(20));
  await expect
    .poll(() => page.evaluate(() => window.rnap.player.getProgress().position))
    .toBeGreaterThanOrEqual(20);
  expect(
    await page.evaluate(() => window.rnap.player.getProgress().duration)
  ).toBeCloseTo(30, 0);
});

test('splices a dropped connection without stopping', async ({ page }) => {
  test.skip(!(await mseMp3(page)), NO_MSE);
  await page.getByRole('button', { name: 'Test radio (ICY)' }).click();
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  await page.waitForTimeout(3_000); // productive: more than 32 KB received
  const before = (await events(page, 'stateChange')).length;
  const listeners = (await radio('/stats')).active;
  await radio('/control?drop=1');

  await expect
    .poll(async () => (await events(page, 'discontinuity')).length, {
      timeout: 20_000,
    })
    .toBe(1);
  expect(await events(page, 'stateChange')).toHaveLength(before);
  expect(await diagnostics(page)).toEqual(
    expect.arrayContaining(['connection dropped', 'connection spliced'])
  );
  // As many listeners as before: the dropped connection left nothing behind.
  expect((await radio('/stats')).active).toBe(listeners);
});

test('recovers from an outage on its own', async ({ page }) => {
  await page.getByRole('button', { name: 'Test radio (ICY)' }).click();
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  await radio('/control?down=1');
  await radio('/control?drop=1');
  await expect
    .poll(() => state(page), { timeout: 30_000 })
    .toBe('reconnecting');
  expect((await events(page, 'error')).pop()).toMatchObject({ fatal: false });

  await radio('/control?down=0');
  await expect.poll(() => state(page), { timeout: 30_000 }).toBe('playing');
  expect((await radio('/stats')).active).toBe(1);
});

test('feeds the visualizer from Web Audio', async ({ page }) => {
  test.skip(!(await mseMp3(page)), NO_MSE);
  await page.getByRole('button', { name: 'Test radio (ICY)' }).click();
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  await page.getByRole('button', { name: 'Visualizer' }).click();
  await expect
    .poll(
      async () =>
        Math.max(
          0,
          ...(await events(page, 'audioSample')).map((e) => e.level as number)
        ),
      {
        timeout: 15_000,
      }
    )
    .toBeGreaterThan(0.01);
  const [sample] = await events(page, 'audioSample');
  expect(sample).toMatchObject({ points: 256 });
});
