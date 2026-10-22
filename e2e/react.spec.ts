import { expect, test } from '@playwright/test';

// The React DOM example (example-react: react-dom + Vite, no React Native):
// `react-native-anything-player/react`'s hooks render the player's state.
const PAGE = 'http://localhost:4500/';

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
