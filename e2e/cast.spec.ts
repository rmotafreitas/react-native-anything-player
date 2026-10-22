import { expect, test, type Page } from '@playwright/test';
import { RADIO, events, radio, state } from './helpers';

// Outputs, Google Cast and the search box, in real browsers. Real Chromecast
// hardware and Safari's AirPlay receivers cannot be had in CI, so the Cast
// sender SDK is replaced by a fake injected before the page loads. The fake
// receiver does what a receiver does: it fetches the stream itself (no ICY
// metadata), straight from the test radio, so the radio's own connection
// counts (/stats) are real. The library under test is the real one.

interface Fake {
  loads: Array<{ contentId: string; streamType: string; title?: string }>;
  bytes: number;
  connected: boolean;
}

declare global {
  interface Window {
    __fakeCast: Fake;
    __audios: Array<EventTarget & { picked?: number }>;
  }
}

/** A Cast sender SDK with a receiver behind it (runs in the page, before it loads). */
function installFakeCast(): void {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  const fire = (type: string, event: unknown) =>
    (listeners[type] ?? []).forEach((listener) => listener(event));
  const controllers: Array<() => void> = [];
  const rx = {
    loads: [] as Fake['loads'],
    bytes: 0,
    connected: false,
    castState: 'NOT_CONNECTED',
    playerState: 'IDLE',
    idleReason: null as string | null,
    isMediaLoaded: false,
    isPaused: false,
    currentTime: 0,
    abort: null as AbortController | null,
    clock: 0 as unknown as ReturnType<typeof setInterval>,
  };
  const device = { friendlyName: 'Living Room', deviceId: 'tv1' };
  const change = () => controllers.forEach((notify) => notify());
  const setPlayer = (next: string, reason: string | null = null) => {
    rx.playerState = next;
    rx.idleReason = reason;
    rx.isPaused = next === 'PAUSED';
    change();
  };
  const stopReceiving = () => {
    rx.abort?.abort();
    rx.abort = null;
    clearInterval(rx.clock);
  };
  async function receive(url: string, autoplay: boolean) {
    stopReceiving();
    const abort = new AbortController();
    rx.abort = abort;
    const response = await fetch(url, {
      signal: abort.signal,
      cache: 'no-store',
    });
    if (!response.ok || !response.body) throw new Error('refused');
    const reader = response.body.getReader();
    (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rx.bytes += value.length;
      }
    })().catch(() => undefined);
    rx.isMediaLoaded = true;
    rx.currentTime = 0;
    rx.clock = setInterval(() => {
      rx.currentTime += 0.25;
      change();
    }, 250);
    setPlayer(autoplay ? 'PLAYING' : 'PAUSED');
  }
  const session = {
    getCastDevice: () => device,
    getMediaSession: () => ({
      idleReason: rx.idleReason,
      supportsCommand: () => true,
      setVolume: () => undefined,
    }),
    loadMedia(request: {
      media: {
        contentId: string;
        streamType: string;
        metadata?: { title?: string };
      };
      autoplay: boolean;
    }) {
      rx.loads.push({
        contentId: request.media.contentId,
        streamType: request.media.streamType,
        title: request.media.metadata?.title,
      });
      return receive(request.media.contentId, request.autoplay).then(
        () => undefined,
        () => 'load_media_failed'
      );
    },
  };
  const end = () => {
    stopReceiving();
    rx.connected = false;
    rx.isMediaLoaded = false;
    rx.castState = 'NOT_CONNECTED';
    fire('sessionstatechanged', { sessionState: 'SESSION_ENDED' });
    fire('caststatechanged', { castState: rx.castState });
  };
  const context = {
    setOptions: () => undefined,
    getCastState: () => rx.castState,
    getCurrentSession: () => (rx.connected ? session : null),
    addEventListener(type: string, listener: (event: unknown) => void) {
      (listeners[type] ??= []).push(listener);
    },
    // The dialog: pick the receiver, or (connected) "stop casting".
    requestSession() {
      if (rx.connected) {
        end();
        return Promise.resolve(undefined);
      }
      rx.castState = 'CONNECTING';
      fire('caststatechanged', { castState: rx.castState });
      return new Promise<undefined>((resolve) =>
        setTimeout(() => {
          rx.connected = true;
          rx.castState = 'CONNECTED';
          fire('sessionstatechanged', { sessionState: 'SESSION_STARTED' });
          fire('caststatechanged', { castState: rx.castState });
          resolve(undefined);
        }, 100)
      );
    },
    endCurrentSession: end,
  };
  class RemotePlayer {
    get isConnected() {
      return rx.connected;
    }
    get isMediaLoaded() {
      return rx.isMediaLoaded;
    }
    get isPaused() {
      return rx.isPaused;
    }
    get canSeek() {
      return false;
    }
    get playerState() {
      return rx.playerState;
    }
    get duration() {
      return 0;
    }
    get currentTime() {
      return rx.currentTime;
    }
    set currentTime(value: number) {
      rx.currentTime = value;
    }
  }
  class RemotePlayerController {
    constructor(_player: RemotePlayer) {}
    addEventListener(_type: string, listener: () => void) {
      controllers.push(listener);
    }
    removeEventListener() {}
    playOrPause() {
      setPlayer(rx.isPaused ? 'PLAYING' : 'PAUSED');
    }
    stop() {
      stopReceiving();
      rx.isMediaLoaded = false;
      setPlayer('IDLE', 'CANCELLED');
    }
    seek() {}
  }
  const w = window as unknown as Record<string, unknown>;
  w.__fakeCast = rx;
  w.cast = {
    framework: {
      CastContext: { getInstance: () => context },
      CastContextEventType: {
        CAST_STATE_CHANGED: 'caststatechanged',
        SESSION_STATE_CHANGED: 'sessionstatechanged',
      },
      SessionState: {
        SESSION_STARTED: 'SESSION_STARTED',
        SESSION_RESUMED: 'SESSION_RESUMED',
        SESSION_ENDED: 'SESSION_ENDED',
      },
      RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
      RemotePlayer,
      RemotePlayerController,
    },
  };
  w.chrome = {
    cast: {
      AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
      Image: class {
        constructor(readonly url: string) {}
      },
      Volume: class {
        constructor(readonly level: number) {}
      },
      media: {
        DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
        StreamType: { LIVE: 'LIVE', BUFFERED: 'BUFFERED' },
        MediaCommand: { STREAM_VOLUME: 'STREAM_VOLUME' },
        MediaInfo: class {
          streamType = 'BUFFERED';
          metadata: unknown = null;
          constructor(
            readonly contentId: string,
            readonly contentType: string
          ) {}
        },
        MusicTrackMediaMetadata: class {},
        LoadRequest: class {
          autoplay = true;
          constructor(readonly media: unknown) {}
        },
        VolumeRequest: class {
          constructor(readonly volume: unknown) {}
        },
      },
    },
  };
  // A receiver is around: the Cast button shows.
  rx.castState = 'NOT_CONNECTED';
}

const radioOpens = async (since: number) =>
  (
    (await radio('/stats')).events as Array<{
      t: number;
      kind: string;
      meta?: boolean;
    }>
  ).filter((e) => e.kind === 'open' && e.t >= since);

const route = (page: Page) =>
  page.evaluate(() => window.rnap.player.status.route);

test.beforeEach(async () => {
  await radio('/control?down=0&stall=0&delay=0');
});

test.describe('Google Cast (a fake receiver)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(installFakeCast);
    await page.goto('/');
  });

  test('offers the Cast button once there are receivers', async ({ page }) => {
    await expect(
      page.getByRole('button', { name: 'Cast', exact: true })
    ).toBeVisible();
    await expect(page.locator('#cast-state')).toHaveText('notConnected');
  });

  test('hands the playing radio to the receiver, keeps the titles flowing, and takes it back', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Test radio (ICY)' }).click();
    await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
    const before = Date.now();

    await page.getByRole('button', { name: 'Cast', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Casting to Living Room' })
    ).toBeVisible();
    await expect
      .poll(() => route(page), { timeout: 15_000 })
      .toEqual({
        kind: 'cast',
        name: 'Living Room',
      });
    await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
    await expect(page.locator('#output')).toHaveText('cast (Living Room)');

    // The receiver was handed the stream, with what the lock screen shows.
    const fake = await page.evaluate(() => window.__fakeCast.loads);
    expect(fake).toEqual([
      expect.objectContaining({
        contentId: `${RADIO}/live.mp3?titleEvery=4`,
        streamType: 'LIVE',
        title: 'RNAP Test Radio',
      }),
    ]);
    await expect
      .poll(() => page.evaluate(() => window.__fakeCast.bytes))
      .toBeGreaterThan(0);

    // The radio sees the receiver (no ICY) and the page's titles-only
    // connection (ICY): two listeners, and this device's own playback is gone.
    await expect.poll(async () => (await radio('/stats')).active).toBe(2);
    const opens = await radioOpens(before);
    expect(opens.filter((e) => e.meta === false)).toHaveLength(1);
    expect(opens.filter((e) => e.meta === true).length).toBeGreaterThanOrEqual(
      1
    );

    // Titles keep arriving from the page's connection while the receiver plays.
    const castAt = Date.now();
    await expect
      .poll(
        async () =>
          new Set(
            (await events(page, 'metadata'))
              .filter((e) => (e.at as number) >= castAt)
              .map((e) => (e.metadata as { title: string | null }).title)
              .filter(Boolean)
          ).size,
        { timeout: 20_000 }
      )
      .toBeGreaterThanOrEqual(2);
    const shown = await page.evaluate(() => ({
      title: window.rnap.player.metadata?.title,
      session: navigator.mediaSession.metadata?.title,
    }));
    expect(shown.session).toBe(shown.title);

    // Stop casting: the player comes back paused, on this device.
    await page.getByRole('button', { name: 'Casting to Living Room' }).click();
    await expect
      .poll(() => route(page), { timeout: 15_000 })
      .toEqual({
        kind: 'unknown',
        name: null,
      });
    await expect.poll(() => state(page), { timeout: 15_000 }).toBe('paused');
    expect(await page.evaluate(() => window.rnap.player.playWhenReady)).toBe(
      false
    );
    await expect
      .poll(async () => (await radio('/stats')).active, { timeout: 20_000 })
      .toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => window.__fakeCast.connected)).toBe(false);
    await expect(
      page.getByRole('button', { name: 'Cast', exact: true })
    ).toBeVisible();
  });

  test('keeps a source the receiver cannot reach on this device', async ({
    page,
  }) => {
    await page.getByRole('button', { name: 'Test radio (ICY)' }).click();
    await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
    await page.getByRole('button', { name: 'Cast', exact: true }).click();
    await expect
      .poll(() => route(page), { timeout: 15_000 })
      .toMatchObject({ kind: 'cast' });

    await page.evaluate(() =>
      window.rnap.player.load('file:///music/a.mp3').catch(() => undefined)
    );
    await expect
      .poll(() => route(page), { timeout: 15_000 })
      .toMatchObject({ kind: 'unknown' });
    const errors = await events(page, 'error');
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'CAST_UNSUPPORTED_SOURCE', fatal: false })
    );
    // The session itself stays: casting again works with a source it can reach.
    expect(await page.evaluate(() => window.__fakeCast.connected)).toBe(true);
    await page.getByRole('button', { name: 'Test radio (ICY)' }).click();
    await expect
      .poll(() => route(page), { timeout: 15_000 })
      .toMatchObject({ kind: 'cast' });
    await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
    expect(await page.evaluate(() => window.__fakeCast.loads.length)).toBe(2);
  });

  test('stopCasting() returns the player to this device', async ({ page }) => {
    await page.getByRole('button', { name: 'Test radio (ICY)' }).click();
    await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
    await page.getByRole('button', { name: 'Cast', exact: true }).click();
    await expect
      .poll(() => route(page), { timeout: 15_000 })
      .toMatchObject({ kind: 'cast' });
    await page.evaluate(() => window.rnap.stopCasting());
    expect(await route(page)).toEqual({ kind: 'unknown', name: null });
    await expect.poll(() => state(page), { timeout: 15_000 }).toBe('paused');
  });
});

test.describe('the browser’s output picker', () => {
  test('shows the button only while the browser offers a picker', async ({
    page,
  }) => {
    // Safari’s API, scripted: the page's audio element gets the picker and the availability events.
    await page.addInitScript(() => {
      const audios: EventTarget[] = [];
      const create = document.createElement.bind(document);
      document.createElement = ((
        tag: string,
        options?: ElementCreationOptions
      ) => {
        const element = create(tag, options);
        if (tag === 'audio') {
          audios.push(element);
          Object.assign(element, {
            picked: 0,
            webkitShowPlaybackTargetPicker() {
              (this as { picked: number }).picked += 1;
            },
          });
        }
        return element;
      }) as typeof document.createElement;
      (window as unknown as { __audios: EventTarget[] }).__audios = audios;
    });
    await page.goto('/');
    const button = page.getByRole('button', { name: 'Output…' });
    await expect(button).toBeHidden();
    const announce = (availability: string) =>
      page.evaluate((value) => {
        const event = new Event('webkitplaybacktargetavailabilitychanged');
        Object.assign(event, { availability: value });
        window.__audios.forEach((audio) => audio.dispatchEvent(event));
      }, availability);

    await announce('available');
    await expect(button).toBeVisible();
    await button.click();
    expect(await page.evaluate(() => window.__audios[0]!.picked)).toBe(1);
    expect(await events(page, 'routePickerAvailability')).toEqual([
      expect.objectContaining({ available: true }),
    ]);

    await announce('not-available');
    await expect(button).toBeHidden();
  });
});

test.describe('the search box', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('plays what is asked for, as a voice request would', async ({
    page,
  }) => {
    await page.getByLabel('Search the catalog').fill('play the test radio');
    await page.getByLabel('Search the catalog').press('Enter');
    await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
    await expect(page.locator('#search-result')).toContainText('→ Test radio');
    expect(await events(page, 'searchPlay')).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ id: 'radio' }),
      }),
    ]);
    const source = await page.evaluate(() => window.rnap.player.status.isLive);
    expect(source).toBe(true);

    // Another search replaces it: a file this time.
    await page.getByLabel('Search the catalog').fill('a tone');
    await page.locator('#search-go').click();
    await expect(page.locator('#search-result')).toContainText('→ Remote tone');
    await expect
      .poll(() => page.evaluate(() => window.rnap.player.status.isLive), {
        timeout: 15_000,
      })
      .toBe(false);
    await expect.poll(() => state(page), { timeout: 15_000 }).toBe('playing');
  });

  test('says when nothing matches and leaves the player alone', async ({
    page,
  }) => {
    await page.getByLabel('Search the catalog').fill('polka marathon');
    await page.getByLabel('Search the catalog').press('Enter');
    await expect(page.locator('#search-result')).toContainText('nothing found');
    expect(await state(page)).toBe('idle');
  });

  test('listens through the Web Speech API where there is one', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      class Recognition {
        lang = '';
        onresult: ((event: unknown) => void) | null = null;
        onerror: ((event: unknown) => void) | null = null;
        start() {
          setTimeout(
            () => this.onresult?.({ results: [[{ transcript: 'test tone' }]] }),
            50
          );
        }
      }
      Object.assign(window, {
        SpeechRecognition: Recognition,
        webkitSpeechRecognition: Recognition,
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Speak' }).click();
    await expect(page.locator('#search-result')).toContainText('→ Remote tone');
    await expect(page.getByLabel('Search the catalog')).toHaveValue(
      'test tone'
    );
  });
});
