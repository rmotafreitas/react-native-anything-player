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
    rnap: { player: Player; events: Recorded[] };
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

/** Whether this browser plays MP3 through MSE (needed for ICY metadata and splices). */
export const mseMp3 = (page: Page) =>
  page.evaluate(
    () =>
      typeof MediaSource !== 'undefined' &&
      MediaSource.isTypeSupported('audio/mpeg')
  );

export const NO_MSE =
  'This browser cannot play MP3 through MSE: RNAP plays the stream on <audio>, without ICY metadata or splices';
