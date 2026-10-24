import { expect, test, type Page } from '@playwright/test';
import type { Player } from '../src/core/Player';
import type { Source } from '../src/types';

// Video players in real browsers, on the plain-web example (example-web/
// video.html): the picture attached to a page element, renditions switched
// behind the picture, SubRip subtitles drawn over it, and the status the
// engine publishes. The media is the test radio's (scripts/stream-server/
// generate-media.sh): a test pattern at 360p and 720p, its sound alone, and
// subtitles.
declare global {
  interface Window {
    videoTest: {
      player: Player;
      MEDIA: string;
      cues: string[][];
      errors: string[];
      states: string[];
      source: () => Source;
    };
  }
}

async function open(page: Page): Promise<void> {
  await page.goto('/video.html');
  await page.waitForFunction(() => window.videoTest != null);
}

const status = (page: Page) =>
  page.evaluate(() => window.videoTest.player.status);

test('a video file plays in the element it is attached to, with its size and first frame', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.videoTest.player.load(`${window.videoTest.MEDIA}/video-360.mp4`, {
      autoplay: true,
    })
  );
  await expect
    .poll(async () => (await status(page)).state, { timeout: 15_000 })
    .toBe('playing');
  await expect
    .poll(async () => (await status(page)).video?.firstFrame)
    .toBe(true);
  const video = (await status(page)).video!;
  expect([video.width, video.height]).toEqual([640, 360]);
  // The picture is in the page element, inside RNAP's stage.
  await expect(page.locator('#stage video')).toHaveCount(1);
  expect(
    await page
      .locator('#stage video')
      .evaluate((v) => (v as HTMLVideoElement).paused)
  ).toBe(false);
});

test('SubRip subtitles are drawn over the picture, follow seeks and the delay', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.videoTest.player.load(
      {
        uri: `${window.videoTest.MEDIA}/video-360.mp4`,
        subtitles: [
          {
            uri: `${window.videoTest.MEDIA}/subs.srt`,
            language: 'en',
            default: true,
          },
        ],
      },
      { autoplay: true }
    )
  );
  await expect
    .poll(async () => (await status(page)).video?.textTrack)
    .toBe('sub:0');
  const overlay = page.locator('#stage');
  await expect(overlay).toContainText('First line', { timeout: 15_000 });
  await page.evaluate(() => window.videoTest.player.seekTo(9));
  await expect(overlay).toContainText('Third line, at the top');
  // Two seconds late: the second line again.
  await page.evaluate(async () => {
    await window.videoTest.player.setSubtitleDelay(3);
  });
  await expect(overlay).toContainText('Second line');
  await page.evaluate(() => window.videoTest.player.selectSubtitles(null));
  await expect(overlay).not.toContainText('line');
  const cues = await page.evaluate(() => window.videoTest.cues);
  expect(cues.flat()).toContain('First line');
});

test('a rendition switch happens behind the picture, without leaving playing', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.videoTest.player.load(window.videoTest.source(), { autoplay: true })
  );
  await expect
    .poll(async () => (await status(page)).state, { timeout: 15_000 })
    .toBe('playing');
  // The view is 1280×720: no 480p rendition, so automatic starts at 720p.
  expect((await status(page)).video?.quality).toBe('r1');
  await page.waitForTimeout(1500);
  const before = await page.evaluate(
    () => window.videoTest.player.getProgress().position
  );
  await page.evaluate(() => {
    window.videoTest.states = [];
  });
  await page.evaluate(() => window.videoTest.player.selectQuality('r0'));
  await expect
    .poll(async () => (await status(page)).video?.quality, { timeout: 15_000 })
    .toBe('r0');
  await expect.poll(async () => (await status(page)).video?.height).toBe(360);
  // No loading, no rebuffer: the second element took over in the playing state.
  expect(await page.evaluate(() => window.videoTest.states)).toEqual([]);
  const after = await page.evaluate(
    () => window.videoTest.player.getProgress().position
  );
  expect(after).toBeGreaterThan(before);
  expect(
    await page.evaluate(
      () => window.videoTest.player.getStats().qualitySwitches
    )
  ).toBe(1);
  expect(await page.evaluate(() => window.videoTest.errors)).toEqual([]);
});

test("an HLS source's own audio and subtitle groups are tracks: picked ones play, their cues on the overlay", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.videoTest.player.load(
      `${window.videoTest.MEDIA}/video-hls/master.m3u8`,
      { autoplay: true }
    )
  );
  await expect
    .poll(async () => (await status(page)).state, { timeout: 20_000 })
    .toBe('playing');
  const described = async () =>
    ((await status(page)).video?.tracks ?? []).map(
      (t) => `${t.kind}:${t.language}`
    );
  await expect
    .poll(described, { timeout: 15_000 })
    .toEqual(['audio:en', 'audio:es', 'subtitles:en', 'subtitles:pt']);
  // Two pictures to choose from.
  expect(
    (await status(page)).video?.qualities.filter((q) => !q.audioOnly)
  ).toHaveLength(2);
  const tracks = (await status(page)).video!.tracks;
  const pt = tracks.find((t) => t.language === 'pt')!.id;
  const es = tracks.find((t) => t.language === 'es')!.id;
  await page.evaluate((id) => window.videoTest.player.selectSubtitles(id), pt);
  const overlay = page.locator('#stage');
  await expect(overlay).toContainText('em português', { timeout: 15_000 });
  // The browser draws none of its own: the overlay is the only text.
  expect(
    await page
      .locator('#stage video')
      .evaluate(
        (v) =>
          Array.from((v as HTMLVideoElement).textTracks).filter(
            (t) => t.mode === 'showing'
          ).length
      )
  ).toBe(0);
  expect((await page.evaluate(() => window.videoTest.cues)).flat()).toEqual(
    expect.arrayContaining([expect.stringContaining('português')])
  );
  await page.evaluate((id) => window.videoTest.player.selectAudioTrack(id), es);
  await expect
    .poll(async () => (await status(page)).video?.audioTrack)
    .toBe(es);
  await page.evaluate(() => window.videoTest.player.selectSubtitles(null));
  await expect(overlay).not.toContainText('português');
  expect(await page.evaluate(() => window.videoTest.errors)).toEqual([]);
});

test("the browser's own controls: their play, pause and seek are the user's", async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() => {
    const t = window.videoTest;
    t.player.attachTo(document.getElementById('stage'), {
      nativeControls: true,
    });
    return t.player.load(`${t.MEDIA}/video-360.mp4`, { autoplay: true });
  });
  await expect
    .poll(async () => (await status(page)).state, { timeout: 15_000 })
    .toBe('playing');
  const video = page.locator('#stage video');
  expect(await video.evaluate((v) => (v as HTMLVideoElement).controls)).toBe(
    true
  );
  // What the pause button does: a pause the user asked for, not the system's.
  await video.evaluate((v) => (v as HTMLVideoElement).pause());
  await expect.poll(async () => (await status(page)).state).toBe('paused');
  expect(await status(page)).toMatchObject({
    playWhenReady: false,
    interruption: null,
  });
  await video.evaluate((v) => {
    (v as HTMLVideoElement).currentTime = 30;
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.videoTest.player.getProgress().position)
    )
    .toBeGreaterThanOrEqual(29.5);
  // The play button: its promise is not awaited (WebKitGTK resolves it
  // only with a `playing` event it may not send while data is still
  // arriving; RNAP takes the running playhead as playing).
  await video.evaluate((v) => {
    (v as HTMLVideoElement).play().catch(() => undefined);
  });
  await expect.poll(async () => (await status(page)).state).toBe('playing');
  expect((await status(page)).playWhenReady).toBe(true);
  // Turned off again: the element has none.
  await page.evaluate(() =>
    window.videoTest.player.attachTo(document.getElementById('stage'))
  );
  expect(await video.evaluate((v) => (v as HTMLVideoElement).controls)).toBe(
    false
  );
});

test('DASH plays through Shaka Player: its pictures are qualities, caps and pins apply', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.videoTest.player.load(
      `${window.videoTest.MEDIA}/video-dash/manifest.mpd`,
      { autoplay: true }
    )
  );
  await expect
    .poll(async () => (await status(page)).state, { timeout: 20_000 })
    .toBe('playing');
  await expect
    .poll(async () =>
      (await status(page)).video?.qualities.map((q) => q.height)
    )
    .toEqual([360, 720]);
  const qualities = (await status(page)).video!.qualities;
  expect((await status(page)).duration).toBeCloseTo(60, 0);
  // Pinning the 360p picture plays it.
  await page.evaluate(
    (id) => window.videoTest.player.selectQuality(id),
    qualities[0]!.id
  );
  await expect
    .poll(async () => (await status(page)).video?.quality, { timeout: 15_000 })
    .toBe(qualities[0]!.id);
  await expect
    .poll(async () => (await status(page)).video?.height, { timeout: 15_000 })
    .toBe(360);
  await page.evaluate(() => window.videoTest.player.seekTo(40));
  await expect
    .poll(() =>
      page.evaluate(() => window.videoTest.player.getProgress().position)
    )
    .toBeGreaterThanOrEqual(40);
  expect(await page.evaluate(() => window.videoTest.errors)).toEqual([]);
});

test('a Matroska file plays remuxed: its audio languages and subtitles are tracks, its Cues seek', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.videoTest.player.load(`${window.videoTest.MEDIA}/remux/movie.mkv`, {
      autoplay: true,
    })
  );
  await expect
    .poll(async () => (await status(page)).state, { timeout: 20_000 })
    .toBe('playing');
  const described = async () =>
    ((await status(page)).video?.tracks ?? []).map(
      (t) => `${t.kind}:${t.language}:${t.label}`
    );
  await expect
    .poll(described, { timeout: 15_000 })
    .toEqual([
      'audio:eng:English',
      'audio:por:Português',
      'subtitles:eng:null',
      'subtitles:por:ASS',
    ]);
  expect((await status(page)).duration).toBeCloseTo(30, 0);
  const video = (await status(page)).video!;
  expect([video.width, video.height]).toEqual([640, 360]);
  const tracks = video.tracks;
  const por = tracks.find(
    (t) => t.kind === 'audio' && t.language === 'por'
  )!.id;
  const srt = tracks.find(
    (t) => t.kind !== 'audio' && t.language === 'eng'
  )!.id;
  const ass = tracks.find(
    (t) => t.kind !== 'audio' && t.language === 'por'
  )!.id;
  // SubRip from the file, drawn by the overlay (the browser draws none).
  await page.evaluate((id) => window.videoTest.player.selectSubtitles(id), srt);
  const overlay = page.locator('#stage');
  await expect(overlay).toContainText('Matroska subtitles', {
    timeout: 15_000,
  });
  expect(
    await page
      .locator('#stage video')
      .evaluate(
        (v) =>
          Array.from((v as HTMLVideoElement).textTracks).filter(
            (t) => t.mode === 'showing'
          ).length
      )
  ).toBe(0);
  // Another audio language: muxed from where the picture is.
  const before = await page.evaluate(
    () => window.videoTest.player.getProgress().position
  );
  await page.evaluate(
    (id) => window.videoTest.player.selectAudioTrack(id),
    por
  );
  await expect
    .poll(async () => (await status(page)).video?.audioTrack)
    .toBe(por);
  await expect
    .poll(async () => (await status(page)).state, { timeout: 15_000 })
    .toBe('playing');
  expect(
    await page.evaluate(() => window.videoTest.player.getProgress().position)
  ).toBeGreaterThanOrEqual(before - 2.5);
  // A seek past what is buffered starts at the cluster the Cues name.
  await page.evaluate(() => window.videoTest.player.seekTo(20));
  await expect
    .poll(
      () => page.evaluate(() => window.videoTest.player.getProgress().position),
      { timeout: 15_000 }
    )
    .toBeGreaterThanOrEqual(20.5);
  await page.evaluate((id) => window.videoTest.player.selectSubtitles(id), ass);
  await expect(overlay).toContainText('Ainda em ASS', { timeout: 15_000 });
  expect(await page.evaluate(() => window.videoTest.errors)).toEqual([]);
});

test('an MPEG-TS file plays remuxed, with its duration, and seeks by its bitrate', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.videoTest.player.load(`${window.videoTest.MEDIA}/remux/movie.ts`, {
      autoplay: true,
    })
  );
  await expect
    .poll(async () => (await status(page)).state, { timeout: 20_000 })
    .toBe('playing');
  expect((await status(page)).duration).toBeCloseTo(30, 0);
  expect((await status(page)).isLive).toBe(false);
  await page.evaluate(() => window.videoTest.player.seekTo(22));
  await expect
    .poll(
      () => page.evaluate(() => window.videoTest.player.getProgress().position),
      { timeout: 15_000 }
    )
    .toBeGreaterThanOrEqual(22.5);
  await expect.poll(async () => (await status(page)).state).toBe('playing');
  expect(await page.evaluate(() => window.videoTest.errors)).toEqual([]);
});

test('a live MPEG-TS channel plays remuxed, as live', async ({ page }) => {
  await open(page);
  await page.evaluate(() =>
    window.videoTest.player.load(`${window.videoTest.MEDIA}/live.ts`, {
      autoplay: true,
    })
  );
  await expect
    .poll(async () => (await status(page)).state, { timeout: 20_000 })
    .toBe('playing');
  expect((await status(page)).isLive).toBe(true);
  const at = await page.evaluate(
    () => window.videoTest.player.getProgress().position
  );
  await expect
    .poll(
      () => page.evaluate(() => window.videoTest.player.getProgress().position),
      { timeout: 10_000 }
    )
    .toBeGreaterThan(at + 2);
  expect((await status(page)).video?.height).toBe(360);
  expect(await page.evaluate(() => window.videoTest.errors)).toEqual([]);
});

test('WebM plays: natively, or remuxed where the browser has no WebM', async ({
  page,
}) => {
  await open(page);
  await page.evaluate(() =>
    window.videoTest.player.load(`${window.videoTest.MEDIA}/remux/movie.webm`, {
      autoplay: true,
    })
  );
  await expect
    .poll(async () => (await status(page)).state, { timeout: 20_000 })
    .toBe('playing');
  const video = (await status(page)).video!;
  expect([video.width, video.height]).toEqual([640, 360]);
  expect(await page.evaluate(() => window.videoTest.errors)).toEqual([]);
});

test('an audio player has no picture to attach', async ({ page }) => {
  await open(page);
  const code = await page.evaluate(async () => {
    const { Player: AudioPlayer } = await import(
      'react-native-anything-player/web' as string
    );
    const audio = new AudioPlayer();
    try {
      audio.attachTo(document.body);
      return 'attached';
    } catch (error) {
      return (error as { code?: string }).code;
    } finally {
      await audio.release();
    }
  });
  expect(code).toBe('INVALID_ARGUMENT');
});
