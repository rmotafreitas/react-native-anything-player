// A scripted Encrypted Media Extensions: `navigator.requestMediaKeySystemAccess`
// with the key systems a test grants, MediaKeys and sessions that record what
// WebDrm asks of them, a video element that takes keys, and a license server
// behind `fetch` that answers with bytes (FakeBrowser's FakeFetch streams its
// bodies, which a license is not).

import type { MediaKeySystemAccessLike } from '../platform/dom';
import { FakeAudio, FakeEvents } from './FakeBrowser';

export class FakeMediaKeySession extends FakeEvents {
  requests: Array<{ type: string; initData: Uint8Array }> = [];
  licenses: Uint8Array[] = [];
  closed = false;
  /** Rejects `generateRequest` / `update` with this. */
  generateError: unknown = null;
  updateError: unknown = null;

  generateRequest(
    type: string,
    initData: Uint8Array | ArrayBuffer
  ): Promise<void> {
    this.requests.push({ type, initData: new Uint8Array(initData) });
    return this.generateError
      ? Promise.reject(this.generateError)
      : Promise.resolve();
  }

  update(license: Uint8Array): Promise<void> {
    if (this.updateError) return Promise.reject(this.updateError);
    this.licenses.push(license);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** The CDM's `message` event: a challenge. */
  message(bytes: Uint8Array): void {
    this.dispatch('message', { message: bytes.slice().buffer });
  }
}

export class FakeMediaKeys {
  sessions: FakeMediaKeySession[] = [];
  sessionTypes: Array<string | undefined> = [];
  certificate: Uint8Array | null = null;
  certificateError: unknown = null;
  /** What the sessions it creates reject `generateRequest` with. */
  generateError: unknown = null;

  createSession(type?: string): FakeMediaKeySession {
    const session = new FakeMediaKeySession();
    session.generateError = this.generateError;
    this.sessions.push(session);
    this.sessionTypes.push(type);
    return session;
  }

  setServerCertificate(certificate: Uint8Array): Promise<boolean> {
    if (this.certificateError) return Promise.reject(this.certificateError);
    this.certificate = certificate;
    return Promise.resolve(true);
  }
}

export class FakeMediaKeySystemAccess implements MediaKeySystemAccessLike {
  readonly keys = new FakeMediaKeys();
  createError: unknown = null;

  constructor(readonly keySystem: string) {}

  createMediaKeys(): Promise<FakeMediaKeys> {
    return this.createError
      ? Promise.reject(this.createError)
      : Promise.resolve(this.keys);
  }
}

/** A video element that takes keys and fires `encrypted`. */
export class FakeEncryptedVideo extends FakeAudio {
  mediaKeys: unknown = null;
  setKeysCalls: unknown[] = [];
  setKeysError: unknown = null;

  setMediaKeys(keys: unknown): Promise<void> {
    this.setKeysCalls.push(keys);
    if (this.setKeysError) return Promise.reject(this.setKeysError);
    this.mediaKeys = keys;
    return Promise.resolve();
  }

  /** The init data (a `pssh`) the stream carries. */
  encrypted(initData: Uint8Array | null, initDataType = 'cenc'): void {
    this.dispatch('encrypted', {
      initDataType,
      initData: initData ? initData.slice().buffer : null,
    });
  }
}

/** `navigator.requestMediaKeySystemAccess` over the key systems granted. */
export class FakeEme {
  /** Every key system asked for, in order. */
  asked: string[] = [];
  configurations: object[][] = [];
  readonly granted = new Map<string, FakeMediaKeySystemAccess>();

  /** Grants `keySystem` (the browser supports it). */
  grant(keySystem: string): FakeMediaKeySystemAccess {
    const access = new FakeMediaKeySystemAccess(keySystem);
    this.granted.set(keySystem, access);
    return access;
  }

  requestMediaKeySystemAccess = (
    keySystem: string,
    configurations: object[]
  ): Promise<MediaKeySystemAccessLike> => {
    this.asked.push(keySystem);
    this.configurations.push(configurations);
    const access = this.granted.get(keySystem);
    return access
      ? Promise.resolve(access)
      : Promise.reject(new Error('NotSupportedError'));
  };
}

export interface LicenseRequestSeen {
  url: string;
  method: string;
  body: Uint8Array | null;
  headers: Record<string, string>;
}

type LicenseAnswer = { status?: number; body?: Uint8Array } | Error;

/** A license server: `fetch` answering each request with the next queued answer. */
export class FakeLicenseServer {
  requests: LicenseRequestSeen[] = [];
  private readonly answers: LicenseAnswer[] = [];

  respond(answer: LicenseAnswer): void {
    this.answers.push(answer);
  }

  fetch = (
    url: string,
    init: {
      method: string;
      body: Uint8Array | null;
      headers: Record<string, string>;
    }
  ) => {
    this.requests.push({
      url,
      method: init.method,
      body: init.body,
      headers: init.headers,
    });
    const answer = this.answers.shift() ?? { body: new Uint8Array([0xaa]) };
    if (answer instanceof Error) return Promise.reject(answer);
    const status = answer.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: () =>
        Promise.resolve((answer.body ?? new Uint8Array()).slice().buffer),
    });
  };
}
