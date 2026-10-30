/// <reference types="node" />
// DRM's pure parts: the source's `drm` validated, the key system order,
// Clear Key licenses made from the source's keys, PlayReady's envelope,
// FairPlay's content id, Shaka's configuration, and the license round trip
// through the app's `getLicense`.

import { answerLicense as runHook, normalizeDrm } from '../../core/drm';
import { shakaDrm } from '../platform/DashStream';
import { answerLicense, requestLicense } from '../platform/licenseRequests';
import {
  clearKeyLicense,
  fairPlayContentId,
  keyIdsInitData,
  keySystemOrder,
  playReadyChallenge,
} from '../platform/WebDrm';
import type { DrmDescriptor } from '../engine/types';

const KID = 'a7e61c373e219033c21091fa607bf3b8';
const KEY = '76a6c65c5ea762046bd749a2e632ccbb';
const b64url = (hex: string) => Buffer.from(hex, 'hex').toString('base64url');

describe('drm in a source', () => {
  test('is validated and normalized, the hook kept in JavaScript', () => {
    const out = normalizeDrm({
      widevine: { licenseUrl: ' https://lic.example/wv ', headers: { A: 'b' } },
      clearkey: {
        keys: { 'A7E61C37-3E21-9033-C210-91FA607BF3B8': KEY.toUpperCase() },
      },
      getLicense: async () => new Uint8Array(),
    });
    expect(out).toEqual({
      widevine: { licenseUrl: 'https://lic.example/wv', headers: { A: 'b' } },
      clearkey: { keys: { [KID]: KEY }, licenseUrl: null, headers: {} },
      hook: true,
    });
  });

  test.each([
    [{}, 'needs a key system'],
    [{ widevine: { licenseUrl: '' } }, 'non-empty URL'],
    [{ clearkey: { keys: { [KID]: 'short' } } }, '16-byte'],
    [{ clearkey: {} }, 'needs `keys`'],
    [{ fairplay: { licenseUrl: 'https://l' } }, 'certificateUrl'],
    [
      { widevine: { licenseUrl: 'https://l', headers: { A: 1 } } },
      'must be a string',
    ],
  ])('%j is refused (%s)', (drm, message) => {
    expect(() => normalizeDrm(drm as never)).toThrow(message);
  });
});

describe('the browser side', () => {
  const drm = normalizeDrm({
    fairplay: { licenseUrl: 'https://l/fps', certificateUrl: 'https://l/cert' },
    widevine: { licenseUrl: 'https://l/wv' },
    clearkey: { keys: { [KID]: KEY } },
  }) as unknown as DrmDescriptor;

  test('key systems: FairPlay first on Safari, Widevine first elsewhere, Clear Key last', () => {
    expect(keySystemOrder(drm, true)).toEqual([
      'fairplay',
      'widevine',
      'clearkey',
    ]);
    expect(keySystemOrder(drm, false)).toEqual([
      'widevine',
      'fairplay',
      'clearkey',
    ]);
  });

  test("a Clear Key license is made from the source's keys", () => {
    const request = Buffer.from(
      JSON.stringify({ kids: [b64url(KID)], type: 'temporary' })
    );
    const license = JSON.parse(
      Buffer.from(
        clearKeyLicense(new Uint8Array(request), { [KID]: KEY })
      ).toString()
    );
    expect(license).toEqual({
      keys: [{ kty: 'oct', kid: b64url(KID), k: b64url(KEY) }],
      type: 'temporary',
    });
    // Without a pssh the session starts from the key ids.
    expect(
      JSON.parse(Buffer.from(keyIdsInitData({ [KID]: KEY })).toString())
    ).toEqual({
      kids: [b64url(KID)],
    });
  });

  test("PlayReady's envelope gives the challenge and its headers", () => {
    const xml =
      '<PlayReadyKeyMessage type="LicenseAcquisition"><LicenseAcquisition Version="1">' +
      `<Challenge encoding="base64encoded">${Buffer.from('<soap/>').toString('base64')}</Challenge>` +
      '<HttpHeaders><HttpHeader><name>Content-Type</name><value>text/xml; charset=utf-8</value></HttpHeader>' +
      '<HttpHeader><name>SOAPAction</name><value>"http://schemas.microsoft.com/DRM/2007/03/protocols/AcquireLicense"</value></HttpHeader>' +
      '</HttpHeaders></LicenseAcquisition></PlayReadyKeyMessage>';
    const out = playReadyChallenge(new Uint8Array(Buffer.from(xml, 'utf16le')));
    expect(Buffer.from(out.body).toString()).toBe('<soap/>');
    expect(out.headers['Content-Type']).toBe('text/xml; charset=utf-8');
    expect(out.headers.SOAPAction).toContain('AcquireLicense');
    // Not an envelope: sent as it is.
    const raw = new Uint8Array([1, 2, 3]);
    expect(playReadyChallenge(raw)).toEqual({ body: raw, headers: {} });
  });

  test("FairPlay's content id is the skd URI's host, in UTF-16 or UTF-8", () => {
    expect(
      fairPlayContentId(
        new Uint8Array(Buffer.from('skd://twelve?x=1', 'utf16le'))
      )
    ).toBe('twelve');
    expect(
      fairPlayContentId(new Uint8Array(Buffer.from('skd://abc/def')))
    ).toBe('abc');
    expect(fairPlayContentId(new Uint8Array([0, 1, 2]))).toBeNull();
  });

  test("Shaka's configuration", () => {
    expect(shakaDrm(drm, null)).toEqual({
      servers: {
        'com.widevine.alpha': 'https://l/wv',
        'com.apple.fps': 'https://l/fps',
      },
      clearKeys: { [KID]: KEY },
      advanced: { 'com.apple.fps': { serverCertificateUri: 'https://l/cert' } },
    });
    // The app answers: every server is RNAP's scheme.
    expect(shakaDrm(drm, 'rnap-license://7')).toMatchObject({
      servers: {
        'com.widevine.alpha': 'rnap-license://7/widevine',
        'com.apple.fps': 'rnap-license://7/fairplay',
        'org.w3.clearkey': 'rnap-license://7/clearkey',
      },
    });
  });
});

describe("the app's getLicense", () => {
  test('a request goes up as an event, the answer comes back as the license', async () => {
    const events: Array<Record<string, unknown>> = [];
    const pending = requestLicense((e) => events.push({ ...e }), {
      keySystem: 'widevine',
      challenge: new Uint8Array([9, 8, 7]),
      contentId: null,
      licenseUrl: 'https://l/wv',
      headers: { A: 'b' },
    });
    expect(events).toHaveLength(1);
    const event = events[0] as never as Parameters<typeof runHook>[1];
    expect(event).toMatchObject({
      keySystem: 'widevine',
      challenge: 'CQgH',
      headers: { A: 'b' },
    });
    // What the Player does with it.
    const answer = await runHook(async (r) => {
      expect(Array.from(r.challenge)).toEqual([9, 8, 7]);
      return new Uint8Array([1, 2]);
    }, event);
    answerLicense({ op: 'license', requestId: event.requestId, ...answer });
    expect(Array.from(await pending)).toEqual([1, 2]);
  });

  test('a hook that throws fails the license', async () => {
    const events: Array<Parameters<typeof runHook>[1]> = [];
    const pending = requestLicense((e) => events.push(e), {
      keySystem: 'clearkey',
      challenge: new Uint8Array(),
      contentId: null,
      licenseUrl: null,
      headers: {},
    });
    const answer = await runHook(async () => {
      throw new Error('token expired');
    }, events[0]!);
    answerLicense({
      op: 'license',
      requestId: events[0]!.requestId,
      ...answer,
    });
    await expect(pending).rejects.toMatchObject({
      code: 'DRM_LICENSE_FAILED',
      message: expect.stringContaining('token expired'),
    });
  });
});
