// A source's `drm`, as every platform takes it: validated, with the app's
// `getLicense` kept in JavaScript (the engine module only learns that there
// is one), and the license exchange's bytes as base64 across the bridge.

import { PlayerError } from '../errors';
import type { DrmConfig, LicenseRequest } from '../types';

function invalid(message: string): PlayerError {
  return new PlayerError({
    code: 'INVALID_ARGUMENT',
    message,
    recoverable: false,
  });
}

const HEX_ID = /^[0-9a-f]{32}$/i;

function url(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw invalid(`drm.${name} must be a non-empty URL.`);
  return value.trim();
}

function headers(name: string, value: unknown): Record<string, string> {
  if (value == null) return {};
  if (typeof value !== 'object')
    throw invalid(`drm.${name} must be an object.`);
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== 'string')
      throw invalid(`drm.${name}.${key} must be a string.`);
    out[key] = v;
  }
  return out;
}

function clearKeys(value: unknown): Record<string, string> | null {
  if (value == null) return null;
  if (typeof value !== 'object')
    throw invalid('drm.clearkey.keys must map key ids to keys (hex).');
  const out: Record<string, string> = {};
  for (const [kid, key] of Object.entries(value as Record<string, unknown>)) {
    // Key ids are often written as UUIDs: the dashes go.
    const id = kid.replace(/-/g, '');
    if (!HEX_ID.test(id) || typeof key !== 'string' || !HEX_ID.test(key))
      throw invalid(
        'drm.clearkey.keys must map 16-byte key ids to 16-byte keys, in hex.'
      );
    out[id.toLowerCase()] = key.toLowerCase();
  }
  if (Object.keys(out).length === 0)
    throw invalid('drm.clearkey.keys must hold at least one key.');
  return out;
}

function fairplay(f: NonNullable<DrmConfig['fairplay']>) {
  return {
    licenseUrl: url('fairplay.licenseUrl', f.licenseUrl),
    certificateUrl: url('fairplay.certificateUrl', f.certificateUrl),
    headers: headers('fairplay.headers', f.headers),
    contentId: typeof f.contentId === 'string' ? f.contentId : null,
  };
}

function clearkey(c: NonNullable<DrmConfig['clearkey']>, hook: boolean) {
  const keys = clearKeys(c.keys);
  const licenseUrl =
    c.licenseUrl == null ? null : url('clearkey.licenseUrl', c.licenseUrl);
  if (keys == null && licenseUrl == null && !hook)
    throw invalid('drm.clearkey needs `keys`, a `licenseUrl` or `getLicense`.');
  return { keys, licenseUrl, headers: headers('clearkey.headers', c.headers) };
}

/** The `drm` part of a source as the engine module takes it; throws INVALID_ARGUMENT for a malformed one. */
export function normalizeDrm(drm: DrmConfig): Record<string, unknown> {
  if (drm == null || typeof drm !== 'object')
    throw invalid('drm must be an object of key systems.');
  if (drm.getLicense != null && typeof drm.getLicense !== 'function')
    throw invalid('drm.getLicense must be a function.');
  const hook = typeof drm.getLicense === 'function';
  const out: Record<string, unknown> = {};
  if (drm.fairplay != null) out.fairplay = fairplay(drm.fairplay);
  for (const name of ['widevine', 'playready'] as const) {
    const system = drm[name];
    if (system == null) continue;
    out[name] = {
      licenseUrl: url(`${name}.licenseUrl`, system.licenseUrl),
      headers: headers(`${name}.headers`, system.headers),
    };
  }
  if (drm.clearkey != null) out.clearkey = clearkey(drm.clearkey, hook);
  if (Object.keys(out).length === 0)
    throw invalid(
      'drm needs a key system: fairplay, widevine, playready or clearkey.'
    );
  out.hook = hook;
  return out;
}

// ── Base64 (React Native has no Buffer; atob/btoa are in Hermes and browsers) ──

type Base64 = { btoa(text: string): string; atob(text: string): string };
const base64 = () => globalThis as unknown as Base64;

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return base64().btoa(binary);
}

export function fromBase64(text: string): Uint8Array {
  const binary = base64().atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** What the engine module asks for (the `licenseRequest` event): the challenge in base64. */
export interface LicenseRequestEvent {
  requestId: number;
  keySystem: LicenseRequest['keySystem'];
  challenge: string;
  contentId: string | null;
  licenseUrl: string | null;
  headers: Record<string, string>;
}

/** Runs the app's `getLicense` for a request; the license in base64, or the reason it failed. */
export async function answerLicense(
  getLicense: NonNullable<DrmConfig['getLicense']>,
  event: LicenseRequestEvent
): Promise<{ license: string } | { error: string }> {
  try {
    const result = await getLicense({
      keySystem: event.keySystem,
      challenge: fromBase64(event.challenge),
      contentId: event.contentId,
      licenseUrl: event.licenseUrl,
      headers: { ...event.headers },
    });
    const bytes =
      result instanceof Uint8Array ? result : new Uint8Array(result);
    return { license: toBase64(bytes) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
