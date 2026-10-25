// Protected content in the browser, through Encrypted Media Extensions: for
// what plays on the element (a file, the browser's own HLS, hls.js's and the
// remuxer's Media Source). DASH's are Shaka's (DashStream).
//
// The key system is the first the browser grants among those the source is
// packaged for (Safari: FairPlay first; elsewhere Widevine, PlayReady,
// FairPlay, then Clear Key). The keys are attached before the element gets
// its source, so every `encrypted` event finds them; each new init data
// opens a session whose challenge goes to the license server (POSTed as is;
// PlayReady's unwrapped from its XML envelope), to the app's `getLicense`,
// or, for Clear Key with the keys in the source, is answered here.
//
// Loaded on first use, with a dynamic `import`: a page that never plays
// protected content does not carry it.

import { fromBase64, toBase64 } from '../../core/drm';
import type { PlayerError } from '../../errors';
import { engineError, type DrmDescriptor } from '../engine/types';
import {
  browser,
  type AudioElementLike,
  type MediaKeySessionLike,
  type MediaKeySystemAccessLike,
  type MediaKeysLike,
} from './dom';

export type KeySystemName = 'fairplay' | 'widevine' | 'playready' | 'clearkey';

export interface DrmListener {
  /** The app's `getLicense`. */
  requestLicense(request: {
    keySystem: KeySystemName;
    challenge: Uint8Array;
    contentId: string | null;
    licenseUrl: string | null;
    headers: Record<string, string>;
  }): Promise<Uint8Array>;
  onFailure(error: PlayerError): void;
  onNote(event: string, details: Record<string, string>): void;
}

/** The EME names of each key system, in the order they are asked for. */
export const KEY_SYSTEMS: Record<KeySystemName, string[]> = {
  fairplay: ['com.apple.fps', 'com.apple.fps.1_0'],
  widevine: ['com.widevine.alpha'],
  playready: [
    'com.microsoft.playready.recommendation',
    'com.microsoft.playready',
  ],
  clearkey: ['org.w3.clearkey'],
};

/** The source's key systems in the order this browser should try them. */
export function keySystemOrder(
  drm: DrmDescriptor,
  safari: boolean
): KeySystemName[] {
  const order: KeySystemName[] = safari
    ? ['fairplay', 'widevine', 'playready', 'clearkey']
    : ['widevine', 'playready', 'fairplay', 'clearkey'];
  return order.filter((name) => drm[name] != null);
}

/** What the browser has to promise: MP4 video and sound (others are allowed too). */
const CONFIGURATIONS = [
  {
    initDataTypes: ['cenc', 'keyids', 'sinf', 'skd'],
    videoCapabilities: [
      'avc1.42E01E',
      'avc1.640028',
      'hvc1.1.6.L93.B0',
      'vp09.00.10.08',
      'av01.0.04M.08',
    ].map((codec) => ({ contentType: `video/mp4; codecs="${codec}"` })),
    audioCapabilities: ['mp4a.40.2', 'ec-3', 'opus'].map((codec) => ({
      contentType: `audio/mp4; codecs="${codec}"`,
    })),
    distinctiveIdentifier: 'optional',
    persistentState: 'optional',
    sessionTypes: ['temporary'],
  },
];

type TextCodec = { decode(bytes: Uint8Array): string };

function decodeText(bytes: Uint8Array, label = 'utf-8'): string {
  const Decoder = (
    globalThis as unknown as { TextDecoder: new (label: string) => TextCodec }
  ).TextDecoder;
  return new Decoder(label).decode(bytes);
}

function encodeText(text: string): Uint8Array {
  const Encoder = (
    globalThis as unknown as {
      TextEncoder: new () => { encode(text: string): Uint8Array };
    }
  ).TextEncoder;
  return new Encoder().encode(text);
}

function base64Url(bytes: Uint8Array): string {
  let text = toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_');
  while (text.endsWith('=')) text = text.slice(0, -1);
  return text;
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  return fromBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

const hexBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

const bytesHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * A Clear Key license (a JWK set) for a session's request (`{"kids": […]}`),
 * from the source's keys; all of them when the request names none of ours.
 */
export function clearKeyLicense(
  message: Uint8Array,
  keys: Record<string, string>
): Uint8Array {
  let wanted: string[] = [];
  try {
    const request = JSON.parse(decodeText(message)) as { kids?: string[] };
    wanted = (request.kids ?? []).map((kid) => bytesHex(fromBase64Url(kid)));
  } catch {
    wanted = [];
  }
  const known = wanted.filter((kid) => keys[kid] != null);
  const ids = known.length > 0 ? known : Object.keys(keys);
  const license = {
    keys: ids.map((kid) => ({
      kty: 'oct',
      kid: base64Url(hexBytes(kid)),
      k: base64Url(hexBytes(keys[kid]!)),
    })),
    type: 'temporary',
  };
  return encodeText(JSON.stringify(license));
}

/** The `keyids` init data for Clear Key keys known up front (no `pssh` needed). */
export function keyIdsInitData(keys: Record<string, string>): Uint8Array {
  const kids = Object.keys(keys).map((kid) => base64Url(hexBytes(kid)));
  return encodeText(JSON.stringify({ kids }));
}

/**
 * PlayReady's EME message: a UTF-16 XML envelope holding the challenge (base64)
 * and the HTTP headers to send it with. Anything else is sent as it is.
 */
export function playReadyChallenge(message: Uint8Array): {
  body: Uint8Array;
  headers: Record<string, string>;
} {
  const xml = decodeText(message, 'utf-16le');
  if (!xml.includes('<PlayReadyKeyMessage'))
    return { body: message, headers: {} };
  const challenge = /<Challenge[^>]*>([^<]*)<\/Challenge>/.exec(xml)?.[1] ?? '';
  const headers: Record<string, string> = {};
  for (const m of xml.matchAll(
    /<HttpHeader>\s*<name>([^<]*)<\/name>\s*<value>([^<]*)<\/value>\s*<\/HttpHeader>/g
  ))
    headers[m[1]!] = m[2]!;
  return { body: fromBase64(challenge.trim()), headers };
}

/** FairPlay's content id: the `skd://` URI's host (its init data, in UTF-16 or UTF-8). */
export function fairPlayContentId(initData: Uint8Array): string | null {
  for (const label of ['utf-16le', 'utf-8']) {
    const text = decodeText(initData, label)
      .split(String.fromCodePoint(0))
      .join('');
    const uri = /skd:\/\/([^\s?/]+)/.exec(text);
    if (uri) return uri[1]!;
  }
  return null;
}

/** Whether this browser is Safari (FairPlay first). */
function isSafari(): boolean {
  const agent = browser().navigator?.userAgent ?? '';
  return /Safari\//.test(agent) && !/Chrome|Chromium|Android/.test(agent);
}

export class WebDrm {
  /** The key system in use, once granted. */
  system: KeySystemName | null = null;
  private keys: MediaKeysLike | null = null;
  private closed = false;
  private failed = false;
  private readonly sessions: MediaKeySessionLike[] = [];
  private readonly seen = new Set<string>();
  private readonly onEncrypted = (event: {
    initDataType: string;
    initData: ArrayBuffer | null;
  }) => this.encrypted(event.initDataType, event.initData);

  constructor(
    private readonly element: AudioElementLike,
    private readonly drm: DrmDescriptor,
    private readonly listener: DrmListener
  ) {}

  /** Finds a key system and attaches its keys; `false` when it cannot (reported). */
  async start(): Promise<boolean> {
    const navigator = browser().navigator;
    if (!navigator?.requestMediaKeySystemAccess || !this.element.setMediaKeys) {
      this.fail(
        engineError(
          'DRM_UNSUPPORTED',
          'This browser has no Encrypted Media Extensions: it cannot play protected content.',
          false
        )
      );
      return false;
    }
    const order = keySystemOrder(this.drm, isSafari());
    const granted = await this.access(order);
    if (this.closed) return false;
    if (!granted) {
      this.fail(
        engineError(
          'DRM_UNSUPPORTED',
          `This browser has none of the key systems the source is packaged for (${order.join(', ')}).`,
          false
        )
      );
      return false;
    }
    try {
      await this.attach(granted.name, granted.access);
    } catch (error) {
      if (!this.closed)
        this.fail(licenseError(error, 'The DRM keys could not be set up'));
      return false;
    }
    return !this.closed;
  }

  private async access(
    order: KeySystemName[]
  ): Promise<{ name: KeySystemName; access: MediaKeySystemAccessLike } | null> {
    const navigator = browser().navigator!;
    for (const name of order) {
      for (const id of KEY_SYSTEMS[name]) {
        try {
          const access = await navigator.requestMediaKeySystemAccess!(
            id,
            CONFIGURATIONS
          );
          return { name, access };
        } catch {
          // Not this one: the next.
        }
      }
    }
    return null;
  }

  private async attach(
    name: KeySystemName,
    access: MediaKeySystemAccessLike
  ): Promise<void> {
    const keys = await access.createMediaKeys();
    const fairplay = this.drm.fairplay;
    if (name === 'fairplay' && fairplay) {
      const certificate = await this.fetch(
        fairplay.certificateUrl,
        'GET',
        null,
        fairplay.headers
      );
      await keys.setServerCertificate(certificate);
    }
    if (this.closed) return;
    this.system = name;
    this.keys = keys;
    this.element.addEventListener('encrypted', this.onEncrypted);
    await this.element.setMediaKeys!(keys);
    this.listener.onNote('drm', { keySystem: access.keySystem });
    // Clear Key with its keys in the source: no `pssh` needed to start.
    const clearKeys = this.drm.clearkey?.keys;
    if (name === 'clearkey' && clearKeys)
      this.open('keyids', keyIdsInitData(clearKeys));
  }

  /** Frees the sessions and detaches the keys (the item is gone). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.element.removeEventListener('encrypted', this.onEncrypted);
    for (const session of this.sessions) session.close().catch(() => undefined);
    this.sessions.length = 0;
    if (this.keys) this.element.setMediaKeys?.(null).catch(() => undefined);
    this.keys = null;
  }

  private fail(error: PlayerError): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.listener.onFailure(error);
  }

  private encrypted(type: string, data: ArrayBuffer | null): void {
    if (this.closed || !this.keys || data == null) return;
    const bytes = new Uint8Array(data);
    const key = `${type}:${toBase64(bytes)}`;
    // Every init segment repeats the same `pssh`: one session per key set.
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.open(type, bytes);
  }

  private open(type: string, initData: Uint8Array): void {
    const session = this.keys!.createSession('temporary');
    this.sessions.push(session);
    const contentId =
      this.system === 'fairplay'
        ? (this.drm.fairplay?.contentId ?? fairPlayContentId(initData))
        : null;
    session.addEventListener('message', (event: { message: ArrayBuffer }) => {
      this.exchange(session, new Uint8Array(event.message), contentId).catch(
        () => undefined
      );
    });
    session.generateRequest(type, initData).catch((error: unknown) => {
      this.fail(
        licenseError(error, 'The DRM license request could not be made')
      );
    });
  }

  private async exchange(
    session: MediaKeySessionLike,
    challenge: Uint8Array,
    contentId: string | null
  ): Promise<void> {
    try {
      const license = await this.license(challenge, contentId);
      if (this.closed) return;
      await session.update(license);
    } catch (error) {
      if (!this.closed)
        this.fail(licenseError(error, 'The DRM license was refused'));
    }
  }

  private async license(
    challenge: Uint8Array,
    contentId: string | null
  ): Promise<Uint8Array> {
    const name = this.system!;
    const clearKeys = this.drm.clearkey?.keys;
    if (name === 'clearkey' && clearKeys)
      return clearKeyLicense(challenge, clearKeys);
    const server = this.drm[name] as
      | { licenseUrl: string | null; headers: Record<string, string> }
      | undefined;
    if (this.drm.hook) {
      return this.listener.requestLicense({
        keySystem: name,
        challenge,
        contentId,
        licenseUrl: server?.licenseUrl ?? null,
        headers: server?.headers ?? {},
      });
    }
    if (!server?.licenseUrl)
      throw engineError(
        'DRM_LICENSE_FAILED',
        `No licenseUrl for ${name}.`,
        false
      );
    if (name === 'playready') {
      const { body, headers } = playReadyChallenge(challenge);
      return this.fetch(server.licenseUrl, 'POST', body, {
        ...headers,
        ...server.headers,
      });
    }
    const type =
      name === 'clearkey' ? 'application/json' : 'application/octet-stream';
    return this.fetch(server.licenseUrl, 'POST', challenge, {
      'Content-Type': type,
      ...server.headers,
    });
  }

  private async fetch(
    url: string,
    method: 'GET' | 'POST',
    body: Uint8Array | null,
    headers: Record<string, string>
  ): Promise<Uint8Array> {
    const fetchLike = browser().fetch as unknown as (
      url: string,
      init: object
    ) => Promise<{
      ok: boolean;
      status: number;
      arrayBuffer(): Promise<ArrayBuffer>;
    }>;
    const response = await fetchLike(url, {
      method,
      body,
      headers,
      cache: 'no-store',
      mode: 'cors',
    });
    if (!response.ok) {
      const status = response.status;
      throw engineError(
        'DRM_LICENSE_FAILED',
        `The DRM server returned HTTP ${status}.`,
        status >= 500 || status === 429,
        { httpStatus: status }
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}

/** A failure as DRM_LICENSE_FAILED (kept when it already is one). */
function licenseError(error: unknown, what: string): PlayerError {
  const known = error as Partial<PlayerError> | null;
  if (known?.code === 'DRM_LICENSE_FAILED' || known?.code === 'DRM_UNSUPPORTED')
    return error as PlayerError;
  return engineError('DRM_LICENSE_FAILED', `${what}.`, false, {
    cause: String(error),
  });
}
