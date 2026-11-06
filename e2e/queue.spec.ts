import { expect, test } from '@playwright/test';
import { RADIO, events, state } from './helpers';

// The queue and the media cache in real browsers: the next item takes over
// with no `ended` in between, and a downloaded file plays with the network off.

declare global {
  interface Window {
    rnap: Window['rnap'] & {
      Cache: typeof import('../src/web/index').Cache;
    };
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test('a queue plays its items in turn, with no ended until the last', async ({
  page,
}) => {
  await page.evaluate(
    (radio) =>
      window.rnap.player.queue.set(
        [
          {
            id: 'one',
            uri: `${radio}/file.mp3`,
            live: false,
            metadata: { title: 'One' },
          },
          {
            id: 'two',
            uri: `${radio}/program.mp3`,
            live: false,
            metadata: { title: 'Two' },
          },
        ],
        { autoplay: true }
      ),
    RADIO
  );
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  // Jump close to the end of the first item: the second takes over by itself.
  const duration = await page.evaluate(
    () => window.rnap.player.status.duration ?? 0
  );
  expect(duration).toBeGreaterThan(1);
  await page.evaluate(
    (d) => window.rnap.player.seekTo(Math.max(0, d - 3)),
    duration
  );
  await expect
    .poll(() => page.evaluate(() => window.rnap.player.queue.current?.id), {
      timeout: 20_000,
    })
    .toBe('two');
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  expect(await events(page, 'ended')).toHaveLength(0);
  expect(
    await page.evaluate(() => navigator.mediaSession.metadata?.title)
  ).toBe('Two');
  expect((await events(page, 'queue')).map((e) => e.current)).toContain('two');
});

test('a downloaded file plays with the network off', async ({
  page,
  context,
}) => {
  // Every source a media element is given, in order.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __srcs: string[] }).__srcs = seen;
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'src'
    )!;
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      ...descriptor,
      set(value: string) {
        seen.push(value);
        descriptor.set!.call(this, value);
      },
    });
  });
  await page.goto('/');
  const info = await page.evaluate(async (radio) => {
    const { Cache } = window.rnap;
    const done = new Promise<void>((resolve) => {
      const stop = Cache.addListener('download', (d) => {
        if (d.state === 'completed' || d.state === 'failed') {
          stop();
          resolve();
        }
      });
    });
    await Cache.download({ uri: `${radio}/file.mp3` }, { id: 'tone' });
    await done;
    return Cache.info(`${radio}/file.mp3`);
  }, RADIO);
  expect(info).toMatchObject({ state: 'complete', downloaded: true });

  await context.setOffline(true);
  await page.evaluate(
    (radio) =>
      window.rnap.player.load(
        { uri: `${radio}/file.mp3`, live: false },
        { autoplay: true }
      ),
    RADIO
  );
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  const srcs = await page.evaluate(
    () => (window as unknown as { __srcs: string[] }).__srcs
  );
  expect(srcs.at(-1)).toMatch(/^blob:/);
  await context.setOffline(false);
  await page.evaluate(() => window.rnap.Cache.removeDownload('tone'));
  expect(
    await page.evaluate(
      (radio) => window.rnap.Cache.info(`${radio}/file.mp3`),
      RADIO
    )
  ).toMatchObject({ state: 'none' });
});
