import { expect, test } from '@playwright/test';
import { events, state } from './helpers';

// The autoplay policy browsers ship (audible playback needs a user gesture),
// enforced in automation: a Chromium switch, Firefox preferences. WebKit has
// no switch for it.
test.use({
  launchOptions: async ({ browserName }, provide) => {
    const options = {
      chromium: { args: ['--autoplay-policy=user-gesture-required'] },
      firefox: {
        firefoxUserPrefs: {
          'media.autoplay.default': 1,
          'media.autoplay.blocking_policy': 1,
        },
      },
      webkit: {},
    };
    await provide(options[browserName]);
  },
});

test('refuses playback without a tap, then plays from one', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit',
    'WebKit cannot enforce the autoplay policy in automation'
  );
  // Chromium treats a browser-started navigation as a gesture for ~5 s, and
  // so is every page.evaluate(): the page starts the radio after 6 s, and the
  // test does not touch the page until then.
  await page.goto('/?autoplay=6000');
  await page.waitForTimeout(8_000);
  expect((await events(page, 'autoplay'))[0]?.outcome).toBe('AUTOPLAY_BLOCKED');
  expect(await page.evaluate(() => window.rnap.player.status)).toMatchObject({
    playWhenReady: false,
    interruption: { reason: 'autoplay-blocked' },
  });

  await page.getByRole('button', { name: 'Play' }).click();
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  expect(
    await page.evaluate(() => window.rnap.player.status.interruption)
  ).toBeNull();
});
