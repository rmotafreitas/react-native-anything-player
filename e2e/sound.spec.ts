import { expect, test, type Page } from '@playwright/test';
import type { Sound as SoundApi, SoundVoice } from '../src/sound/web';

// The Sound API in real browsers (Web Audio, the PulseAudio null sink in CI):
// the plain-web entry `react-native-anything-player/sound`, with the page's
// source nodes observed to see what the engine really starts and ends.
declare global {
  interface Window {
    soundTest: {
      Sound: typeof SoundApi;
      sameAsWeb: boolean;
      errors: string[];
      load: (
        seconds: number,
        options?: { voices?: number }
      ) => Promise<{ duration: number | null; unload: () => Promise<void> }>;
      play: (options?: Record<string, unknown>) => SoundVoice | null;
    };
    started: Array<{ rate: number; loop: boolean }>;
    ended: number;
  }
}

// Chromium enforces the autoplay policy with a switch (the context only runs
// after a gesture, here a click); the other engines have no equivalent. The
// AUTOPLAY_BLOCKED answer itself is covered with a fake context in
// src/web/__tests__/webSound.test.ts: a navigation started by the test counts
// as a gesture, so a real page is never blocked in automation (as in
// autoplay.spec.ts).
test.use({
  launchOptions: async ({ browserName }, provide) => {
    await provide(
      browserName === 'chromium'
        ? { args: ['--autoplay-policy=user-gesture-required'] }
        : {}
    );
  },
});

test.beforeEach(async ({ page }) => {
  // Records every source node the page starts and every one that ends.
  await page.addInitScript(() => {
    window.started = [];
    window.ended = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      // Not the one-frame buffer RNAP plays to wake a context on a gesture.
      if ((this.buffer?.length ?? 0) > 100) {
        window.started.push({ rate: this.playbackRate.value, loop: this.loop });
        this.addEventListener('ended', () => {
          window.ended += 1;
        });
      }
      return start.apply(this, args);
    };
  });
});

const unlock = async (page: Page) => {
  // A real click is the user gesture the autoplay policy wants.
  await page.getByRole('button', { name: 'Stop all' }).click();
  await page.evaluate(() => window.soundTest.Sound.unlock());
};

test('the same Sound from /sound and /web, decoding a Blob into memory', async ({
  page,
}) => {
  await page.goto('/sound.html');
  expect(await page.evaluate(() => window.soundTest.sameAsWeb)).toBe(true);
  expect(await page.evaluate(() => window.soundTest.Sound.isAvailable())).toBe(
    true
  );
  const duration = await page.evaluate(
    async () => (await window.soundTest.load(0.4)).duration
  );
  expect(duration).toBeCloseTo(0.4, 1);
});

test('plays copies at the same time, each ending by itself', async ({
  page,
}) => {
  await page.goto('/sound.html');
  await page.evaluate(() => window.soundTest.load(0.3, { voices: 3 }));
  await unlock(page);
  await page.evaluate(() => {
    window.soundTest.play();
    window.soundTest.play({ rate: 2, pan: -1, volume: 0.5 });
    window.soundTest.play({ loop: true });
  });
  expect(await page.evaluate(() => window.started)).toEqual([
    { rate: 1, loop: false },
    { rate: 2, loop: false },
    { rate: 1, loop: true },
  ]);
  // The two one-shots end; the loop keeps going until stopped.
  await expect.poll(() => page.evaluate(() => window.ended)).toBe(2);
  await page.evaluate(() => window.soundTest.Sound.stopAll());
  await expect.poll(() => page.evaluate(() => window.ended)).toBe(3);
});

test('steals the oldest voice when they are all busy', async ({ page }) => {
  await page.goto('/sound.html');
  await page.evaluate(() => window.soundTest.load(5, { voices: 2 }));
  await unlock(page);
  await page.evaluate(() => {
    window.soundTest.play();
    window.soundTest.play();
    window.soundTest.play();
  });
  expect(await page.evaluate(() => window.started.length)).toBe(3);
  // Three started, but only one was stopped (the first): the others last 5 s.
  await expect.poll(() => page.evaluate(() => window.ended)).toBe(1);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.ended)).toBe(1);
});

test('a voice handle stops its own voice, and setEnabled(false) silences play()', async ({
  page,
}) => {
  await page.goto('/sound.html');
  await page.evaluate(() => window.soundTest.load(5));
  await unlock(page);
  await page.evaluate(() => {
    const voice = window.soundTest.play();
    voice?.setVolume(0.2);
    voice?.setRate(1.5);
    voice?.stop();
  });
  await expect.poll(() => page.evaluate(() => window.ended)).toBe(1);
  await page.evaluate(() => {
    window.soundTest.Sound.setEnabled(false);
    window.soundTest.play();
  });
  expect(await page.evaluate(() => window.started.length)).toBe(1);
});
