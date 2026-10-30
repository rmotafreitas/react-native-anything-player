import { expect, test } from '@playwright/test';

// The React DOM example (example-react: react-dom + Vite, no React Native):
// `react-native-anything-player/react`'s hooks render the player's state.
const PAGE = 'http://localhost:4500/';

/** `?video` adds a video player next to the page's player. */
type VideoPage = { video?: import('../src/core/Player').Player };

test('plays the radio with hooks, pauses, and plays a search result', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(PAGE);
  await page.getByRole('button', { name: 'Test radio' }).click();
  await expect(page.getByTestId('state')).toHaveText('playing', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('title')).not.toHaveText('–', {
    timeout: 15_000,
  });
  await expect
    .poll(async () =>
      parseFloat(await page.getByTestId('position').innerText())
    )
    .toBeGreaterThan(1);

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByTestId('state')).toHaveText('paused');

  await page.getByLabel('Search').fill('tone');
  await page.getByRole('button', { name: 'Search' }).click();
  await expect(page.getByTestId('state')).toHaveText('playing', {
    timeout: 15_000,
  });
  expect(await page.evaluate(() => window.rnap?.player.status.isLive)).toBe(
    false
  );
  expect(errors).toEqual([]);
});

test('a video view that unmounts leaves the sound playing; a newer view keeps the picture (#51, #54)', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${PAGE}?video`);
  await page.getByRole('button', { name: 'Play video' }).click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window.rnap as unknown as VideoPage).video?.status.state
        ),
      {
        timeout: 15_000,
      }
    )
    .toBe('playing');
  const video = await page
    .locator('[data-testid="view-a"] video')
    .elementHandle();

  // B mounts and takes the picture; A unmounts: B keeps it (#54).
  await page.getByRole('button', { name: 'Show view b' }).click();
  await expect(page.locator('[data-testid="view-b"] video')).toHaveCount(1);
  await page.getByRole('button', { name: 'Hide view a' }).click();
  await page.waitForTimeout(500);
  await expect(page.locator('[data-testid="view-b"] video')).toHaveCount(1);

  // The last view unmounts: the element waits in the page and plays on (#51).
  await page.getByRole('button', { name: 'Hide view b' }).click();
  await page.waitForTimeout(1500);
  const before = await page.evaluate(
    () => (window.rnap as unknown as VideoPage).video!.getProgress().position
  );
  await page.waitForTimeout(1000);
  expect(await video!.evaluate((v) => v.isConnected)).toBe(true);
  expect(await video!.evaluate((v) => (v as HTMLVideoElement).paused)).toBe(
    false
  );
  expect(
    await page.evaluate(
      () => (window.rnap as unknown as VideoPage).video!.status.playWhenReady
    )
  ).toBe(true);
  expect(
    await page.evaluate(
      () => (window.rnap as unknown as VideoPage).video!.getProgress().position
    )
  ).toBeGreaterThan(before);

  // A view again: the same element, no reload.
  await page.getByRole('button', { name: 'Show view a' }).click();
  await expect(page.locator('[data-testid="view-a"] video')).toHaveCount(1);
  expect(
    await page
      .locator('[data-testid="view-a"] video')
      .evaluate((v, original) => v === original, video)
  ).toBe(true);
  expect(errors).toEqual([]);
});
