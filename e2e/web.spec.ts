import { expect, test } from '@playwright/test';
import {
  NO_MSE,
  diagnostics,
  events,
  mseAac,
  mseMp3,
  radio,
  state,
} from './helpers';

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
  const notes = await diagnostics(page);
  expect(notes).not.toContain('plain playback');
  // Firefox takes MP3 only inside MP4: RNAP remuxes it there, and nowhere else.
  const raw = await page.evaluate(() =>
    MediaSource.isTypeSupported('audio/mpeg')
  );
  expect(notes.includes('remux')).toBe(!raw);

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

const NO_AAC_PROGRAM =
  'The test radio has no AAC program: run scripts/stream-server/generate-media.sh';
const hasAacProgram = async () =>
  Boolean((await radio('/stats')).capabilities?.aac);

const NO_AAC =
  'This browser cannot play AAC through MSE, raw or inside MP4: RNAP plays the stream on <audio>, without ICY metadata or splices';

test('plays an AAC radio through MSE, with titles timed to the audio', async ({
  page,
  browserName,
}) => {
  test.skip(!(await mseAac(page)), NO_AAC);
  test.skip(!(await hasAacProgram()), NO_AAC_PROGRAM);
  // Playwright's WebKit build says it takes `audio/aac` but fails the very
  // first append of ADTS (InvalidStateError, even frame-aligned): the browser,
  // not RNAP. The MP4 form of AAC is covered for WebKit by the test below.
  test.skip(
    browserName === 'webkit',
    'Playwright WebKit cannot append raw ADTS AAC to a source buffer'
  );
  await page.getByRole('button', { name: 'Test radio (AAC, ICY)' }).click();
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  await expect
    .poll(
      async () =>
        new Set(
          (await events(page, 'metadata'))
            .map((e) => (e.metadata as { title: string | null }).title)
            .filter(Boolean)
        ).size,
      { timeout: 15_000 }
    )
    .toBeGreaterThanOrEqual(2);
  const notes = await diagnostics(page);
  expect(notes).not.toContain('plain playback');
  const raw = await page.evaluate(() =>
    MediaSource.isTypeSupported('audio/aac')
  );
  expect(notes.includes('remux')).toBe(!raw);
  expect(
    await page.evaluate(() => window.rnap.player.getProgress().liveOffset)
  ).toBeGreaterThan(0);
});

// Chromium and WebKit take MP3 and AAC raw, so RNAP never remuxes there. To
// test the muxer in every browser, the page is told that raw MP3 and AAC are
// not supported (as in Firefox) before it loads: RNAP then takes the MP4 form
// wherever the browser has one.
test('remuxes to fragmented MP4 where the browser takes only that form', async ({
  page,
}) => {
  const mp4 = await page.evaluate(() => ({
    aac:
      typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'),
    mp3:
      typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported('audio/mp4; codecs="mp3"'),
  }));
  test.skip(
    !mp4.aac && !mp4.mp3,
    'This browser takes neither MP3 nor AAC inside MP4'
  );
  // AAC where the browser takes it in MP4 (and the radio has it), else MP3.
  const aac = mp4.aac && (await hasAacProgram());
  test.skip(!aac && !mp4.mp3, NO_AAC_PROGRAM);
  await page.addInitScript(() => {
    for (const name of ['MediaSource', 'ManagedMediaSource'] as const) {
      const ctor = (window as unknown as Record<string, typeof MediaSource>)[
        name
      ];
      if (!ctor) continue;
      const original = ctor.isTypeSupported.bind(ctor);
      ctor.isTypeSupported = (type: string) =>
        !/^audio\/(mpeg|aac)$/.test(type) && original(type);
    }
  });
  await page.goto('/');
  await page
    .getByRole('button', {
      name: aac ? 'Test radio (AAC, ICY)' : 'Test radio (ICY)',
    })
    .click();
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  expect(await diagnostics(page)).toEqual(expect.arrayContaining(['remux']));
  expect(await diagnostics(page)).not.toContain('plain playback');
  await expect
    .poll(
      async () =>
        new Set(
          (await events(page, 'metadata'))
            .map((e) => (e.metadata as { title: string | null }).title)
            .filter(Boolean)
        ).size,
      { timeout: 15_000 }
    )
    .toBeGreaterThanOrEqual(2);

  // A dropped connection is spliced in: a fresh init segment, the same timeline.
  await page.waitForTimeout(3_000);
  await radio('/control?drop=1');
  await expect
    .poll(async () => (await events(page, 'discontinuity')).length, {
      timeout: 20_000,
    })
    .toBe(1);
  await expect.poll(() => state(page)).toBe('playing');
  const before = await page.evaluate(
    () => window.rnap.player.getProgress().position
  );
  await expect
    .poll(() => page.evaluate(() => window.rnap.player.getProgress().position))
    .toBeGreaterThan(before + 1);
});

test('the sleep timer fades out and pauses; fades never change the volume', async ({
  page,
}) => {
  // Record every volume the engine gives the <audio> element.
  await page.addInitScript(() => {
    const volume = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'volume'
    )!;
    const seen: number[] = [];
    (window as unknown as { volumes: number[] }).volumes = seen;
    Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
      ...volume,
      set(this: HTMLMediaElement, value: number) {
        seen.push(value);
        volume.set!.call(this, value);
      },
    });
  });
  await page.reload();
  const volumes = () =>
    page.evaluate(() => (window as unknown as { volumes: number[] }).volumes);
  await page.getByRole('button', { name: 'Remote file' }).click();
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  await page.evaluate(() => {
    window.rnap.player.on('sleep', (event) =>
      window.rnap.events.push({ type: 'sleep', ...event })
    );
  });

  await page.evaluate(() => window.rnap.player.sleep({ after: 2, fadeOut: 1 }));
  expect(
    await page.evaluate(() => window.rnap.player.status.sleepAt)
  ).not.toBeNull();
  await expect.poll(() => state(page), { timeout: 10_000 }).toBe('paused');
  expect(await events(page, 'sleep')).toHaveLength(1);
  expect(await page.evaluate(() => window.rnap.player.status)).toMatchObject({
    sleepAt: null,
    volume: 1,
  });
  const faded = await volumes();
  expect(faded.some((v) => v > 0.05 && v < 0.95)).toBe(true);
  expect(faded.at(-1)).toBeLessThan(0.1);

  // A fade-out on pause: the intent is off at once, the audio stops after it.
  await page.evaluate(() => window.rnap.player.setFade({ in: 0.3, out: 1 }));
  await page.evaluate(() => window.rnap.player.play());
  await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  await expect.poll(async () => (await volumes()).at(-1)).toBe(1);
  await page.evaluate(() => window.rnap.player.pause());
  expect(
    await page.evaluate(() => [
      window.rnap.player.playWhenReady,
      window.rnap.player.state,
    ])
  ).toEqual([false, 'playing']);
  await expect.poll(() => state(page), { timeout: 5_000 }).toBe('paused');
  expect(await diagnostics(page)).toContain('fade-out');
});
