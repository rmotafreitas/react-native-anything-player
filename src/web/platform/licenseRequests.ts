// The app's `drm.getLicense`, reached from the web driver: a license request
// goes up as a `licenseRequest` event (like a native one), the Player calls
// the app, and its answer comes back as the `license` video command.

import { fromBase64, toBase64, type LicenseRequestEvent } from '../../core/drm';
import { engineError } from '../engine/types';
import { browser } from './dom';

/** How long the app has to answer. */
const ANSWER_MS = 30_000;

const pending = new Map<
  number,
  {
    resolve(license: Uint8Array): void;
    reject(error: Error): void;
    timer: number;
  }
>();
let next = 1;

/** Asks the app for a license (`emit` sends the event); the license it returns. */
export function requestLicense(
  emit: (event: LicenseRequestEvent) => void,
  request: Omit<LicenseRequestEvent, 'requestId' | 'challenge'> & {
    challenge: Uint8Array;
  }
): Promise<Uint8Array> {
  const requestId = next;
  next += 1;
  return new Promise((resolve, reject) => {
    const timer = browser().setTimeout(() => {
      if (!pending.delete(requestId)) return;
      reject(
        engineError(
          'DRM_LICENSE_FAILED',
          "The app's getLicense did not answer within 30 s.",
          false
        )
      );
    }, ANSWER_MS);
    pending.set(requestId, { resolve, reject, timer });
    emit({ ...request, requestId, challenge: toBase64(request.challenge) });
  });
}

/** The `license` video command: the app's answer to a request. */
export function answerLicense(command: Record<string, unknown>): void {
  const id = command.requestId as number;
  const waiting = pending.get(id);
  if (!waiting) return;
  pending.delete(id);
  browser().clearTimeout(waiting.timer);
  if (typeof command.license === 'string') {
    waiting.resolve(fromBase64(command.license));
    return;
  }
  waiting.reject(
    engineError(
      'DRM_LICENSE_FAILED',
      `The app's getLicense failed: ${typeof command.error === 'string' ? command.error : 'no license'}.`,
      false
    )
  );
}
