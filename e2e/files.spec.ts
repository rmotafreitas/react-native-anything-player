import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { events, radio, state } from './helpers';

// Local files on the web: a picked or dropped File is played from an object
// URL RNAP makes and revokes. The page records every Blob URL created and
// revoked, to see that nothing leaks in a real browser.

const FILE = join(
  __dirname,
  '..',
  'scripts',
  'stream-server',
  'media',
  'file.mp3'
);

declare global {
  interface Window {
    __blobs: { created: string[]; revoked: string[] };
  }
}

test.beforeEach(async ({ page }) => {
  await radio('/control?down=0&stall=0&delay=0');
  await page.addInitScript(() => {
    const blobs = { created: [] as string[], revoked: [] as string[] };
    window.__blobs = blobs;
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = create(object);
      // MediaSource URLs are RNAP's stream plumbing; these are about files.
      if (object instanceof Blob) blobs.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      blobs.revoked.push(url);
      revoke(url);
    };
  });
  await page.goto('/');
});

const title = (page: Page) =>
  page.evaluate(() => navigator.mediaSession.metadata?.title);

test('plays a picked file, and revokes its URL when the item is replaced', async ({
  page,
}) => {
  await page.setInputFiles('#file', FILE);
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  expect(await page.evaluate(() => window.rnap.player.status)).toMatchObject({
    isLive: false,
    seekable: true,
  });
  expect(
    await page.evaluate(() => window.rnap.player.getProgress().duration)
  ).toBeCloseTo(30, 0);
  expect(await title(page)).toBe('file');

  await page.evaluate(() => window.rnap.player.seekTo(20));
  await expect
    .poll(() => page.evaluate(() => window.rnap.player.getProgress().position))
    .toBeGreaterThanOrEqual(20);

  const [url] = await page.evaluate(() => window.__blobs.created);
  expect(url).toMatch(/^blob:/);
  expect(await page.evaluate(() => window.__blobs.revoked)).toEqual([]);
  // The URL is real while the item is: the browser can read it.
  expect(await page.evaluate((u) => fetch(u).then((r) => r.ok), url!)).toBe(
    true
  );

  await page.getByRole('button', { name: 'Remote file' }).click();
  await expect
    .poll(() => page.evaluate(() => window.__blobs.revoked))
    .toEqual([url]);
  // …and gone once it is revoked.
  expect(
    await page.evaluate(
      (u) =>
        fetch(u).then(
          () => true,
          () => false
        ),
      url!
    )
  ).toBe(false);
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
});

test('plays a dropped file', async ({ page }) => {
  const bytes = readFileSync(FILE).toString('base64');
  await page.evaluate((base64) => {
    const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([data], 'Dropped tone.mp3', { type: 'audio/mpeg' })
    );
    document.getElementById('drop')!.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: transfer,
        bubbles: true,
        cancelable: true,
      })
    );
  }, bytes);
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  expect(await title(page)).toBe('Dropped tone');
});

test('feeds the visualizer from a local file', async ({ page }) => {
  await page.getByRole('button', { name: 'Visualizer' }).click();
  await page.setInputFiles('#file', FILE);
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  await expect
    .poll(
      async () =>
        Math.max(
          0,
          ...(await events(page, 'audioSample')).map((e) => e.level as number)
        ),
      { timeout: 15_000 }
    )
    .toBeGreaterThan(0.01);
});

test('plays a data: URL given as a string', async ({ page }) => {
  const url = `data:audio/mpeg;base64,${readFileSync(FILE).toString('base64')}`;
  await page.evaluate(
    (u) => window.rnap.player.load(u, { autoplay: true }),
    url
  );
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  // RNAP made no object URL for it, so it has nothing to revoke.
  expect(await page.evaluate(() => window.__blobs.created)).toEqual([]);
});

test('refuses a blob: URL it was not given the bytes of, as a failed load', async ({
  page,
}) => {
  const error = await page.evaluate(() =>
    window.rnap.player
      .load('blob:http://localhost:4300/00000000-0000-0000-0000-000000000000', {
        autoplay: true,
      })
      .then(
        () => null,
        (e: { code: string }) => e.code
      )
  );
  // It passes validation (it is a web URL); the browser cannot open it.
  expect(error).toBe('UNSUPPORTED_FORMAT');
});
