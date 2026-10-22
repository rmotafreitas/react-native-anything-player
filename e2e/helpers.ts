// Helpers shared by the web end-to-end specs.
import type { Page } from '@playwright/test';
import type { Player } from '../src/web/index';

// The plain-web example exposes its player as `window.rnap`.
export interface Recorded {
  type: string;
  [key: string]: unknown;
}
export {};
declare global {
  interface Window {
    rnap: {
      player: Player;
      events: Recorded[];
      stopCasting: () => Promise<void>;
    };
  }
}

export const RADIO = 'http://localhost:8765';

export const state = (page: Page) =>
  page.evaluate(() => window.rnap.player.state);
export const events = (page: Page, type: string) =>
  page.evaluate((t) => window.rnap.events.filter((e) => e.type === t), type);
export const diagnostics = (page: Page) =>
  page.evaluate(() => window.rnap.player.getDiagnostics().map((d) => d.event));
export const radio = (path: string) =>
  fetch(`${RADIO}${path}`).then((r) => r.json());

/**
 * Whether this browser plays MP3 through MSE: raw, or (Firefox) inside MP4,
 * where RNAP remuxes it. Needed for ICY metadata, splices and the visualizer.
 */
export const mseMp3 = (page: Page) =>
  page.evaluate(
    () =>
      typeof MediaSource !== 'undefined' &&
      (MediaSource.isTypeSupported('audio/mpeg') ||
        MediaSource.isTypeSupported('audio/mp4; codecs="mp3"'))
  );

/** Whether this browser takes ADTS AAC through MSE, raw or inside MP4. */
export const mseAac = (page: Page) =>
  page.evaluate(
    () =>
      typeof MediaSource !== 'undefined' &&
      (MediaSource.isTypeSupported('audio/aac') ||
        MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'))
  );

export const NO_MSE =
  'This browser cannot play MP3 through MSE, raw or inside MP4: RNAP plays the stream on <audio>, without ICY metadata or splices';
