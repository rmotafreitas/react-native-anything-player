/// <reference types="node" />
// Browser DRM through Encrypted Media Extensions: WebDrm's key system
// search, its sessions and the license exchange (server, the app's
// getLicense, Clear Key), how it fails and closes; `protect`, which sets it
// up before a source plays; and the app's answer timing out (licenseRequests).

import { PlayerError } from '../../errors';
import type { LicenseRequestEvent } from '../../core/drm';
import type { DrmDescriptor, OpenRequest } from '../engine/types';
import type { DriverObserver } from '../platform/driverObserver';
import { answerLicense, requestLicense } from '../platform/licenseRequests';
import { protect } from '../platform/protectedSource';
import {
  KEY_SYSTEMS,
  WebDrm,
  type DrmListener,
  type KeySystemName,
} from '../platform/WebDrm';
import { install, uninstall, type FakeWorld } from './FakeBrowser';
import { FakeEme, FakeEncryptedVideo, FakeLicenseServer } from './FakeEme';

const KID = 'a7e61c373e219033c21091fa607bf3b8';
const KEY = '76a6c65c5ea762046bd749a2e632ccbb';
const kidB64Url = Buffer.from(KID, 'hex').toString('base64url');
const keyB64Url = Buffer.from(KEY, 'hex').toString('base64url');

const PSSH = new Uint8Array([1, 2, 3, 4]);
const CHALLENGE = new Uint8Array([9, 8, 7]);
const LICENSE = new Uint8Array([5, 6]);

const WIDEVINE = {
  licenseUrl: 'https://lic.example/wv',
  headers: { 'X-Token': 'abc' },
};
const FAIRPLAY = {
  licenseUrl: 'https://lic.example/fps',
  headers: { 'X-Fps': '1' },
  certificateUrl: 'https://lic.example/cert',
  contentId: null,
};

const drmOf = (parts: Partial<DrmDescriptor>): DrmDescriptor => ({
  hook: false,
  ...parts,
});

let world: FakeWorld;
let eme: FakeEme;
let server: FakeLicenseServer;
let video: FakeEncryptedVideo;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}

function recorder() {
  const failures: PlayerError[] = [];
  const notes: Array<{ event: string; details: Record<string, string> }> = [];
  const requestLicenseHook = jest.fn(async (_request: unknown) => LICENSE);
  const listener: DrmListener = {
    requestLicense: requestLicenseHook,
    onFailure: (error) => failures.push(error),
    onNote: (event, details) => notes.push({ event, details }),
  };
  return { failures, notes, requestLicenseHook, listener };
}

/** A WebDrm on a fresh video, started: what it granted is in `eme`. */
async function startDrm(
  drm: DrmDescriptor,
  listener: DrmListener
): Promise<{ webDrm: WebDrm; started: boolean }> {
  const webDrm = new WebDrm(video, drm, listener);
  const starting = webDrm.start();
  await flush();
  return { webDrm, started: await starting };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  world = install();
  eme = new FakeEme();
  server = new FakeLicenseServer();
  Object.assign(world.navigator, {
    requestMediaKeySystemAccess: eme.requestMediaKeySystemAccess,
  });
  (globalThis as Record<string, unknown>).fetch = server.fetch;
  video = new FakeEncryptedVideo();
});

afterEach(() => {
  uninstall();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('finding a key system', () => {
  test('a browser without EME reports DRM_UNSUPPORTED', async () => {
    delete (world.navigator as { requestMediaKeySystemAccess?: unknown })
      .requestMediaKeySystemAccess;
    const { failures, listener } = recorder();
    const { started } = await startDrm(drmOf({ widevine: WIDEVINE }), listener);
    expect(started).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      code: 'DRM_UNSUPPORTED',
      recoverable: false,
    });
  });

  test('an element that cannot take keys reports DRM_UNSUPPORTED', async () => {
    eme.grant('com.widevine.alpha');
    const plain = new FakeEncryptedVideo();
    (plain as { setMediaKeys?: unknown }).setMediaKeys = undefined;
    const { failures, listener } = recorder();
    const webDrm = new WebDrm(plain, drmOf({ widevine: WIDEVINE }), listener);
    expect(await webDrm.start()).toBe(false);
    expect(failures[0]).toMatchObject({ code: 'DRM_UNSUPPORTED' });
    expect(eme.asked).toEqual([]);
  });

  test('none of the key systems granted reports which ones were tried', async () => {
    const { failures, listener } = recorder();
    const { started } = await startDrm(
      drmOf({ widevine: WIDEVINE, clearkey: { keys: null, ...WIDEVINE } }),
      listener
    );
    expect(started).toBe(false);
    expect(failures[0]).toMatchObject({
      code: 'DRM_UNSUPPORTED',
      recoverable: false,
      message: expect.stringContaining('widevine, clearkey'),
    });
    expect(eme.asked).toEqual(['com.widevine.alpha', 'org.w3.clearkey']);
  });

  test('a system the browser refuses falls back to the next, PlayReady by its names', async () => {
    eme.grant('com.microsoft.playready');
    const { failures, notes, listener } = recorder();
    const { webDrm, started } = await startDrm(
      drmOf({ widevine: WIDEVINE, playready: WIDEVINE }),
      listener
    );
    expect(started).toBe(true);
    expect(eme.asked).toEqual([
      'com.widevine.alpha',
      'com.microsoft.playready.recommendation',
      'com.microsoft.playready',
    ]);
    expect(webDrm.system).toBe('playready');
    expect(notes).toEqual([
      { event: 'drm', details: { keySystem: 'com.microsoft.playready' } },
    ]);
    expect(failures).toEqual([]);
  });

  test('it asks for MP4 video and sound over every init data type', async () => {
    eme.grant('com.widevine.alpha');
    const { listener } = recorder();
    await startDrm(drmOf({ widevine: WIDEVINE }), listener);
    expect(eme.configurations[0]).toEqual([
      expect.objectContaining({
        initDataTypes: ['cenc', 'keyids', 'sinf', 'skd'],
        sessionTypes: ['temporary'],
        videoCapabilities: expect.arrayContaining([
          { contentType: 'video/mp4; codecs="avc1.42E01E"' },
        ]),
        audioCapabilities: expect.arrayContaining([
          { contentType: 'audio/mp4; codecs="mp4a.40.2"' },
        ]),
      }),
    ]);
  });

  test('Chrome tries Widevine before FairPlay, Safari the other way round', async () => {
    eme.grant('com.apple.fps');
    server.respond({});
    const drm = drmOf({ widevine: WIDEVINE, fairplay: FAIRPLAY });
    await startDrm(drm, recorder().listener);
    expect(eme.asked).toEqual(['com.widevine.alpha', 'com.apple.fps']);

    eme.asked = [];
    server.respond({});
    Object.assign(world.navigator, {
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    });
    await startDrm(drm, recorder().listener);
    expect(eme.asked).toEqual(['com.apple.fps']);
  });

  test('the key system names are the EME ones', () => {
    expect(KEY_SYSTEMS.widevine).toEqual(['com.widevine.alpha']);
    expect(KEY_SYSTEMS.clearkey).toEqual(['org.w3.clearkey']);
  });

  test('keys that cannot be created report DRM_LICENSE_FAILED', async () => {
    eme.grant('com.widevine.alpha').createError = new Error('no CDM');
    const { failures, listener } = recorder();
    const { started } = await startDrm(drmOf({ widevine: WIDEVINE }), listener);
    expect(started).toBe(false);
    expect(failures[0]).toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      recoverable: false,
      message: 'The DRM keys could not be set up.',
    });
    expect(video.listenerCount('encrypted')).toBe(0);
  });

  test('an element that refuses the keys reports DRM_LICENSE_FAILED', async () => {
    eme.grant('com.widevine.alpha');
    video.setKeysError = new Error('refused');
    const { failures, listener } = recorder();
    const { started } = await startDrm(drmOf({ widevine: WIDEVINE }), listener);
    expect(started).toBe(false);
    expect(failures[0]).toMatchObject({ code: 'DRM_LICENSE_FAILED' });
  });

  test('closing while the browser is still choosing ends quietly', async () => {
    eme.grant('com.widevine.alpha');
    const { failures, listener } = recorder();
    const webDrm = new WebDrm(video, drmOf({ widevine: WIDEVINE }), listener);
    const starting = webDrm.start();
    webDrm.close();
    await flush();
    expect(await starting).toBe(false);
    expect(failures).toEqual([]);
    expect(video.setKeysCalls).toEqual([]);
  });
});

describe('sessions and licenses from a server', () => {
  test('an encrypted event opens a session, and the license answers its challenge', async () => {
    const access = eme.grant('com.widevine.alpha');
    const { failures, listener } = recorder();
    const { started } = await startDrm(drmOf({ widevine: WIDEVINE }), listener);
    expect(started).toBe(true);
    expect(video.mediaKeys).toBe(access.keys);

    video.encrypted(PSSH);
    const [session] = access.keys.sessions;
    expect(access.keys.sessionTypes).toEqual(['temporary']);
    expect(session!.requests).toEqual([{ type: 'cenc', initData: PSSH }]);

    server.respond({ body: LICENSE });
    session!.message(CHALLENGE);
    await flush();
    expect(server.requests).toEqual([
      {
        url: 'https://lic.example/wv',
        method: 'POST',
        body: CHALLENGE,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Token': 'abc',
        },
      },
    ]);
    expect(session!.licenses).toEqual([LICENSE]);
    expect(failures).toEqual([]);
  });

  test("the source's headers can replace the content type", async () => {
    const access = eme.grant('com.widevine.alpha');
    const { listener } = recorder();
    await startDrm(
      drmOf({
        widevine: {
          licenseUrl: WIDEVINE.licenseUrl,
          headers: { 'Content-Type': 'application/x-custom' },
        },
      }),
      listener
    );
    video.encrypted(PSSH);
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(server.requests[0]!.headers).toEqual({
      'Content-Type': 'application/x-custom',
    });
  });

  test('the same init data opens one session, other init data another', async () => {
    const access = eme.grant('com.widevine.alpha');
    await startDrm(drmOf({ widevine: WIDEVINE }), recorder().listener);
    video.encrypted(PSSH);
    video.encrypted(PSSH);
    expect(access.keys.sessions).toHaveLength(1);
    video.encrypted(PSSH, 'keyids');
    video.encrypted(new Uint8Array([4, 3, 2, 1]));
    expect(access.keys.sessions).toHaveLength(3);
    expect(access.keys.sessions.map((s) => s.requests[0]!.type)).toEqual([
      'cenc',
      'keyids',
      'cenc',
    ]);
  });

  test('an encrypted event without init data opens nothing', async () => {
    const access = eme.grant('com.widevine.alpha');
    await startDrm(drmOf({ widevine: WIDEVINE }), recorder().listener);
    video.encrypted(null);
    expect(access.keys.sessions).toEqual([]);
  });

  test('PlayReady unwraps its XML envelope and sends the headers it names', async () => {
    const access = eme.grant('com.microsoft.playready.recommendation');
    const xml =
      '<PlayReadyKeyMessage type="LicenseAcquisition"><LicenseAcquisition Version="1">' +
      `<Challenge encoding="base64encoded">${Buffer.from('<soap/>').toString('base64')}</Challenge>` +
      '<HttpHeaders><HttpHeader><name>Content-Type</name><value>text/xml</value></HttpHeader>' +
      '<HttpHeader><name>SOAPAction</name><value>"Acquire"</value></HttpHeader>' +
      '</HttpHeaders></LicenseAcquisition></PlayReadyKeyMessage>';
    const { webDrm } = await startDrm(
      drmOf({
        playready: {
          licenseUrl: 'https://lic.example/pr',
          headers: { SOAPAction: '"Override"' },
        },
      }),
      recorder().listener
    );
    expect(webDrm.system).toBe('playready');
    video.encrypted(PSSH);
    access.keys.sessions[0]!.message(
      new Uint8Array(Buffer.from(xml, 'utf16le'))
    );
    await flush();
    const request = server.requests[0]!;
    expect(Buffer.from(request.body!).toString()).toBe('<soap/>');
    expect(request.headers).toEqual({
      'Content-Type': 'text/xml',
      'SOAPAction': '"Override"',
    });
    expect(access.keys.sessions[0]!.licenses).toHaveLength(1);
  });

  test('a challenge that is not an envelope goes to PlayReady as it is', async () => {
    const access = eme.grant('com.microsoft.playready');
    await startDrm(
      drmOf({
        playready: { licenseUrl: 'https://lic.example/pr', headers: {} },
      }),
      recorder().listener
    );
    video.encrypted(PSSH);
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(server.requests[0]!.body).toEqual(CHALLENGE);
  });

  test('FairPlay sets the server certificate and takes the content id from the init data', async () => {
    const access = eme.grant('com.apple.fps');
    Object.assign(world.navigator, {
      userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Safari/604.1',
    });
    server.respond({ body: new Uint8Array([7, 7]) });
    const { listener, requestLicenseHook } = recorder();
    const { webDrm } = await startDrm(
      drmOf({ fairplay: FAIRPLAY, hook: true }),
      listener
    );
    expect(webDrm.system).toBe('fairplay');
    expect(server.requests).toEqual([
      {
        url: 'https://lic.example/cert',
        method: 'GET',
        body: null,
        headers: { 'X-Fps': '1' },
      },
    ]);
    expect(access.keys.certificate).toEqual(new Uint8Array([7, 7]));

    video.encrypted(
      new Uint8Array(Buffer.from('skd://asset-12?x=1', 'utf16le')),
      'skd'
    );
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(requestLicenseHook).toHaveBeenCalledWith({
      keySystem: 'fairplay',
      challenge: CHALLENGE,
      contentId: 'asset-12',
      licenseUrl: FAIRPLAY.licenseUrl,
      headers: { 'X-Fps': '1' },
    });
  });

  test('the content id in the source wins over the init data', async () => {
    const access = eme.grant('com.apple.fps');
    Object.assign(world.navigator, {
      userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Safari/604.1',
    });
    const { listener, requestLicenseHook } = recorder();
    await startDrm(
      drmOf({ fairplay: { ...FAIRPLAY, contentId: 'mine' }, hook: true }),
      listener
    );
    video.encrypted(new Uint8Array(Buffer.from('skd://theirs')), 'skd');
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(requestLicenseHook).toHaveBeenCalledWith(
      expect.objectContaining({ contentId: 'mine' })
    );
  });

  test('a FairPlay certificate the server refuses ends the start', async () => {
    eme.grant('com.apple.fps');
    server.respond({ status: 404 });
    const { failures, listener } = recorder();
    const { started } = await startDrm(drmOf({ fairplay: FAIRPLAY }), listener);
    expect(started).toBe(false);
    expect(failures[0]).toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      recoverable: false,
      httpStatus: 404,
    });
  });

  test('a source with no license URL for its key system fails the license', async () => {
    const access = eme.grant('com.widevine.alpha');
    const { failures, listener } = recorder();
    await startDrm(
      drmOf({ widevine: { licenseUrl: '', headers: {} } }),
      listener
    );
    video.encrypted(PSSH);
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(server.requests).toEqual([]);
    expect(failures[0]).toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      recoverable: false,
      message: 'No licenseUrl for widevine.',
    });
  });
});

describe('license failures', () => {
  async function widevineSession(listener: DrmListener) {
    const access = eme.grant('com.widevine.alpha');
    await startDrm(drmOf({ widevine: WIDEVINE }), listener);
    video.encrypted(PSSH);
    return access.keys.sessions[0]!;
  }

  test.each([
    [500, true],
    [503, true],
    [429, true],
    [403, false],
    [404, false],
  ])('HTTP %i is recoverable: %s', async (status, recoverable) => {
    const { failures, listener } = recorder();
    const session = await widevineSession(listener);
    server.respond({ status });
    session.message(CHALLENGE);
    await flush();
    expect(session.licenses).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      recoverable,
      httpStatus: status,
      message: `The DRM server returned HTTP ${status}.`,
    });
  });

  test('a network failure is a fatal DRM_LICENSE_FAILED with its cause', async () => {
    const { failures, listener } = recorder();
    const session = await widevineSession(listener);
    server.respond(new Error('offline'));
    session.message(CHALLENGE);
    await flush();
    expect(failures[0]).toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      recoverable: false,
      message: 'The DRM license was refused.',
      nativeCause: 'Error: offline',
    });
  });

  test('a session that refuses the license fails it', async () => {
    const { failures, listener } = recorder();
    const session = await widevineSession(listener);
    session.updateError = new Error('bad license');
    session.message(CHALLENGE);
    await flush();
    expect(failures[0]).toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      message: 'The DRM license was refused.',
    });
  });

  test('a session that cannot generate its request fails', async () => {
    const access = eme.grant('com.widevine.alpha');
    access.keys.generateError = new Error('bad init data');
    const { failures, listener } = recorder();
    await startDrm(drmOf({ widevine: WIDEVINE }), listener);
    video.encrypted(PSSH);
    await flush();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      message: 'The DRM license request could not be made.',
    });
  });

  test('only the first of several failures is reported', async () => {
    const { failures, listener } = recorder();
    const session = await widevineSession(listener);
    server.respond({ status: 503 });
    server.respond({ status: 403 });
    session.message(CHALLENGE);
    session.message(CHALLENGE);
    await flush();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ httpStatus: 503, recoverable: true });
  });

  test('a license that arrives after the item closed is dropped', async () => {
    const { failures, listener } = recorder();
    const access = eme.grant('com.widevine.alpha');
    const { webDrm } = await startDrm(drmOf({ widevine: WIDEVINE }), listener);
    video.encrypted(PSSH);
    const session = access.keys.sessions[0]!;
    session.message(CHALLENGE);
    webDrm.close();
    await flush();
    expect(session.licenses).toEqual([]);
    expect(failures).toEqual([]);
  });

  test('a failure after the item closed is not reported', async () => {
    const { failures, listener } = recorder();
    const access = eme.grant('com.widevine.alpha');
    const { webDrm } = await startDrm(drmOf({ widevine: WIDEVINE }), listener);
    video.encrypted(PSSH);
    server.respond({ status: 500 });
    access.keys.sessions[0]!.message(CHALLENGE);
    webDrm.close();
    await flush();
    expect(failures).toEqual([]);
  });
});

describe("the app's getLicense and Clear Key", () => {
  test("the app's hook answers instead of a server", async () => {
    const access = eme.grant('com.widevine.alpha');
    const { failures, listener, requestLicenseHook } = recorder();
    await startDrm(drmOf({ widevine: WIDEVINE, hook: true }), listener);
    video.encrypted(PSSH);
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(server.requests).toEqual([]);
    expect(requestLicenseHook).toHaveBeenCalledWith({
      keySystem: 'widevine',
      challenge: CHALLENGE,
      contentId: null,
      licenseUrl: WIDEVINE.licenseUrl,
      headers: WIDEVINE.headers,
    });
    expect(access.keys.sessions[0]!.licenses).toEqual([LICENSE]);
    expect(failures).toEqual([]);
  });

  test('a hook with no server for the key system gets no URL and no headers', async () => {
    const access = eme.grant('org.w3.clearkey');
    const { listener, requestLicenseHook } = recorder();
    await startDrm(
      drmOf({
        clearkey: { keys: null, licenseUrl: null, headers: {} },
        hook: true,
      }),
      listener
    );
    video.encrypted(PSSH);
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(requestLicenseHook).toHaveBeenCalledWith({
      keySystem: 'clearkey',
      challenge: CHALLENGE,
      contentId: null,
      licenseUrl: null,
      headers: {},
    });
  });

  test('a hook that rejects fails the license with its error', async () => {
    const access = eme.grant('com.widevine.alpha');
    const { failures, listener, requestLicenseHook } = recorder();
    requestLicenseHook.mockRejectedValueOnce(
      new PlayerError({
        code: 'DRM_LICENSE_FAILED',
        message: 'token expired',
        recoverable: true,
      })
    );
    await startDrm(drmOf({ widevine: WIDEVINE, hook: true }), listener);
    video.encrypted(PSSH);
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(failures[0]).toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      recoverable: true,
      message: 'token expired',
    });
  });

  test('Clear Key with keys in the source starts a keyids session and answers it', async () => {
    const access = eme.grant('org.w3.clearkey');
    const { failures, listener } = recorder();
    const { webDrm } = await startDrm(
      drmOf({
        clearkey: { keys: { [KID]: KEY }, licenseUrl: null, headers: {} },
      }),
      listener
    );
    expect(webDrm.system).toBe('clearkey');
    const [session] = access.keys.sessions;
    expect(session!.requests[0]!.type).toBe('keyids');
    expect(
      JSON.parse(Buffer.from(session!.requests[0]!.initData).toString())
    ).toEqual({ kids: [kidB64Url] });

    session!.message(
      new Uint8Array(Buffer.from(JSON.stringify({ kids: [kidB64Url] })))
    );
    await flush();
    expect(server.requests).toEqual([]);
    expect(JSON.parse(Buffer.from(session!.licenses[0]!).toString())).toEqual({
      keys: [{ kty: 'oct', kid: kidB64Url, k: keyB64Url }],
      type: 'temporary',
    });
    expect(failures).toEqual([]);
  });

  test('a Clear Key request that is not JSON gets every key of the source', async () => {
    const access = eme.grant('org.w3.clearkey');
    await startDrm(
      drmOf({
        clearkey: { keys: { [KID]: KEY }, licenseUrl: null, headers: {} },
      }),
      recorder().listener
    );
    const [session] = access.keys.sessions;
    session!.message(CHALLENGE);
    await flush();
    expect(
      JSON.parse(Buffer.from(session!.licenses[0]!).toString()).keys
    ).toEqual([{ kty: 'oct', kid: kidB64Url, k: keyB64Url }]);
  });

  test('Clear Key without keys asks its license server for JSON', async () => {
    const access = eme.grant('org.w3.clearkey');
    await startDrm(
      drmOf({
        clearkey: {
          keys: null,
          licenseUrl: 'https://lic.example/ck',
          headers: {},
        },
      }),
      recorder().listener
    );
    expect(access.keys.sessions).toEqual([]);
    video.encrypted(PSSH);
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(server.requests[0]).toMatchObject({
      url: 'https://lic.example/ck',
      headers: { 'Content-Type': 'application/json' },
    });
  });
});

describe('closing', () => {
  test('it closes every session, detaches the keys and stops listening', async () => {
    const access = eme.grant('com.widevine.alpha');
    const { webDrm } = await startDrm(
      drmOf({ widevine: WIDEVINE }),
      recorder().listener
    );
    video.encrypted(PSSH);
    video.encrypted(new Uint8Array([4, 3, 2, 1]));
    webDrm.close();
    await flush();
    expect(access.keys.sessions.map((s) => s.closed)).toEqual([true, true]);
    expect(video.setKeysCalls).toEqual([access.keys, null]);
    expect(video.listenerCount('encrypted')).toBe(0);

    video.encrypted(new Uint8Array([8, 8]));
    expect(access.keys.sessions).toHaveLength(2);
  });

  test('closing twice does nothing more', async () => {
    eme.grant('com.widevine.alpha');
    const { webDrm } = await startDrm(
      drmOf({ widevine: WIDEVINE }),
      recorder().listener
    );
    webDrm.close();
    webDrm.close();
    expect(video.setKeysCalls).toHaveLength(2);
  });

  test('closing before any key system was granted detaches nothing', async () => {
    const webDrm = new WebDrm(
      video,
      drmOf({ widevine: WIDEVINE }),
      recorder().listener
    );
    webDrm.close();
    expect(video.setKeysCalls).toEqual([]);
  });

  test('a session that will not close, or keys that will not detach, are ignored', async () => {
    const access = eme.grant('com.widevine.alpha');
    const { failures, listener } = recorder();
    const { webDrm } = await startDrm(drmOf({ widevine: WIDEVINE }), listener);
    video.encrypted(PSSH);
    const session = access.keys.sessions[0]!;
    jest.spyOn(session, 'close').mockRejectedValue(new Error('gone'));
    video.setKeysError = new Error('detached');
    webDrm.close();
    await flush();
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
  });
});

describe('a protected source on the element (protect)', () => {
  const generation = 7;

  function request(drm: DrmDescriptor): OpenRequest {
    return {
      generation,
      source: {
        uri: 'https://cdn.example/a.mp4',
        headers: {},
        liveHint: null,
        drm,
      },
      startPosition: null,
      playWhenReady: true,
      allowReconnect: false,
    };
  }

  function observerOf() {
    const failed: Array<{ generation: number; error: PlayerError }> = [];
    const notes: Array<{ generation: number; event: string }> = [];
    const licenses: Array<{ generation: number; event: LicenseRequestEvent }> =
      [];
    const observer = {
      onFailed: (g: number, error: PlayerError) =>
        failed.push({ generation: g, error }),
      onNote: (g: number, event: string) =>
        notes.push({ generation: g, event }),
      onLicenseRequest: (g: number, event: LicenseRequestEvent) =>
        licenses.push({ generation: g, event }),
    };
    return {
      failed,
      notes,
      licenses,
      observer: observer as unknown as DriverObserver,
    };
  }

  test('the source plays once its keys are attached', async () => {
    const access = eme.grant('com.widevine.alpha');
    const { failed, notes, observer } = observerOf();
    const ready = jest.fn();
    protect(video, request(drmOf({ widevine: WIDEVINE })), observer, ready);
    expect(ready).not.toHaveBeenCalled();
    await flush();
    expect(ready).toHaveBeenCalledTimes(1);
    expect(video.mediaKeys).toBe(access.keys);
    expect(notes).toEqual([{ generation, event: 'drm' }]);
    expect(failed).toEqual([]);
  });

  test('a license goes to the app as an event and its answer reaches the session', async () => {
    const access = eme.grant('com.widevine.alpha');
    const { licenses, observer } = observerOf();
    protect(
      video,
      request(drmOf({ widevine: WIDEVINE, hook: true })),
      observer,
      jest.fn()
    );
    await flush();
    video.encrypted(PSSH);
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(licenses).toHaveLength(1);
    expect(licenses[0]).toMatchObject({
      generation,
      event: {
        keySystem: 'widevine',
        challenge: Buffer.from(CHALLENGE).toString('base64'),
        licenseUrl: WIDEVINE.licenseUrl,
      },
    });
    answerLicense({
      op: 'license',
      requestId: licenses[0]!.event.requestId,
      license: Buffer.from(LICENSE).toString('base64'),
    });
    await flush();
    expect(access.keys.sessions[0]!.licenses).toEqual([LICENSE]);
  });

  test('a browser that cannot play it fails the item and never calls ready', async () => {
    const { failed, observer } = observerOf();
    const ready = jest.fn();
    protect(video, request(drmOf({ widevine: WIDEVINE })), observer, ready);
    await flush();
    expect(ready).not.toHaveBeenCalled();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      generation,
      error: { code: 'DRM_UNSUPPORTED' },
    });
  });

  test('a license failure later fails the item', async () => {
    const access = eme.grant('com.widevine.alpha');
    const { failed, observer } = observerOf();
    protect(video, request(drmOf({ widevine: WIDEVINE })), observer, jest.fn());
    await flush();
    video.encrypted(PSSH);
    server.respond({ status: 503 });
    access.keys.sessions[0]!.message(CHALLENGE);
    await flush();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      generation,
      error: { code: 'DRM_LICENSE_FAILED', recoverable: true },
    });
  });

  test('closing before the DRM code loaded keeps the source from starting', async () => {
    eme.grant('com.widevine.alpha');
    const { failed, notes, observer } = observerOf();
    const ready = jest.fn();
    const item = protect(
      video,
      request(drmOf({ widevine: WIDEVINE })),
      observer,
      ready
    );
    item.close();
    await flush();
    expect(ready).not.toHaveBeenCalled();
    expect(failed).toEqual([]);
    expect(notes).toEqual([]);
    expect(video.setKeysCalls).toEqual([]);
  });

  test('closing after it started frees the sessions and the keys', async () => {
    const access = eme.grant('com.widevine.alpha');
    const { observer } = observerOf();
    const item = protect(
      video,
      request(drmOf({ widevine: WIDEVINE })),
      observer,
      jest.fn()
    );
    await flush();
    video.encrypted(PSSH);
    item.close();
    await flush();
    expect(access.keys.sessions[0]!.closed).toBe(true);
    expect(video.setKeysCalls).toEqual([access.keys, null]);
  });

  test('a failure that comes after closing is not reported', async () => {
    const access = eme.grant('com.widevine.alpha');
    access.keys.generateError = new Error('bad init data');
    const { failed, observer } = observerOf();
    const item = protect(
      video,
      request(drmOf({ widevine: WIDEVINE })),
      observer,
      jest.fn()
    );
    await flush();
    video.encrypted(PSSH);
    item.close();
    await flush();
    expect(failed).toEqual([]);
  });

  test('DRM code that does not load is a recoverable failure', async () => {
    let isolated!: { protect: typeof protect };
    jest.isolateModules(() => {
      jest.doMock('../platform/sourceParts', () => ({
        loadDrmParts: () => Promise.resolve(null),
      }));
      isolated = require('../platform/protectedSource');
    });
    jest.dontMock('../platform/sourceParts');
    const { failed, observer } = observerOf();
    const ready = jest.fn();
    isolated.protect(
      video,
      request(drmOf({ widevine: WIDEVINE })),
      observer,
      ready
    );
    await flush();
    expect(ready).not.toHaveBeenCalled();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      generation,
      error: { code: 'DRM_LICENSE_FAILED', recoverable: true },
    });
  });
});

describe("the app's answer in time (licenseRequests)", () => {
  const challengeRequest = {
    keySystem: 'widevine' as KeySystemName,
    challenge: CHALLENGE,
    contentId: null,
    licenseUrl: null,
    headers: {},
  };

  test('an app that does not answer within 30 s fails the license', async () => {
    const events: LicenseRequestEvent[] = [];
    const pending = requestLicense((e) => events.push(e), challengeRequest);
    const outcome = pending.then(
      () => null,
      (error: PlayerError) => error
    );
    await jest.advanceTimersByTimeAsync(29_999);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      recoverable: false,
      message: "The app's getLicense did not answer within 30 s.",
    });
    expect(jest.getTimerCount()).toBe(0);

    // A late answer finds nothing waiting.
    answerLicense({
      op: 'license',
      requestId: events[0]!.requestId,
      license: 'AQI=',
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('an answer stops the timer', async () => {
    const events: LicenseRequestEvent[] = [];
    const pending = requestLicense((e) => events.push(e), challengeRequest);
    answerLicense({
      op: 'license',
      requestId: events[0]!.requestId,
      license: 'AQI=',
    });
    expect(Array.from(await pending)).toEqual([1, 2]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('an answer without a license fails with the reason, or says there was none', async () => {
    const events: LicenseRequestEvent[] = [];
    const withReason = requestLicense((e) => events.push(e), challengeRequest);
    answerLicense({
      op: 'license',
      requestId: events[0]!.requestId,
      error: 'no entitlement',
    });
    await expect(withReason).rejects.toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      message: "The app's getLicense failed: no entitlement.",
    });

    const withoutReason = requestLicense(
      (e) => events.push(e),
      challengeRequest
    );
    answerLicense({ op: 'license', requestId: events[1]!.requestId });
    await expect(withoutReason).rejects.toMatchObject({
      message: "The app's getLicense failed: no license.",
    });
  });

  test('an answer to a request nobody made is ignored', () => {
    expect(() =>
      answerLicense({ op: 'license', requestId: 99_999, license: 'AQI=' })
    ).not.toThrow();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('each request has its own id', () => {
    const events: LicenseRequestEvent[] = [];
    requestLicense((e) => events.push(e), challengeRequest).catch(
      () => undefined
    );
    requestLicense((e) => events.push(e), challengeRequest).catch(
      () => undefined
    );
    expect(events[1]!.requestId).toBe(events[0]!.requestId + 1);
  });
});
