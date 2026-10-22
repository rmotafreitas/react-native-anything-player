// The Expo config plugin's edits (plugin/helpers.js). The Xcode target
// (plugin/intentsExtension.js) is exercised by an `expo prebuild` of the Expo
// example, which CI does not run; see docs/testing.md.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const helpers = require('../../plugin/helpers.js');

const MAIN_ACTIVITY = `package com.example.app

import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

test('defaults: background audio and the assistant, no Cast, no Siri', () => {
  const r = helpers.resolveOptions();
  assert.deepEqual(r, {
    backgroundAudio: true,
    cast: null,
    siri: null,
    assistant: true,
  });
  assert.equal(
    helpers.resolveOptions({ backgroundAudio: false }).backgroundAudio,
    false
  );
  assert.equal(helpers.resolveOptions({ assistant: false }).assistant, false);
});

test('Cast: the default receiver, or a custom one', () => {
  const plain = helpers.resolveOptions({ cast: true }).cast;
  assert.equal(plain.receiverApplicationId, 'CC1AD845');
  assert.equal(plain.customReceiver, false);
  const custom = helpers.resolveOptions({
    cast: {
      receiverApplicationId: 'ABCD1234',
      localNetworkUsageDescription: 'Why',
    },
  }).cast;
  assert.equal(custom.receiverApplicationId, 'ABCD1234');
  assert.equal(custom.customReceiver, true);
  assert.equal(custom.localNetworkUsageDescription, 'Why');
});

test('Info.plist: audio mode, Cast discovery and Siri, keeping what the app set', () => {
  const plist = helpers.applyInfoPlist(
    {
      UIBackgroundModes: ['fetch'],
      NSBonjourServices: ['_http._tcp', '_googlecast._tcp'],
      NSSiriUsageDescription: 'Mine',
    },
    helpers.resolveOptions({
      cast: { receiverApplicationId: 'ABCD1234' },
      siri: true,
    })
  );
  assert.deepEqual(plist.UIBackgroundModes, ['fetch', 'audio']);
  assert.deepEqual(plist.NSBonjourServices, [
    '_http._tcp',
    '_googlecast._tcp',
    '_ABCD1234._googlecast._tcp',
  ]);
  assert.equal(plist.RNAPCastReceiverId, 'ABCD1234');
  assert.match(plist.NSLocalNetworkUsageDescription, /Cast/);
  assert.equal(plist.NSSiriUsageDescription, 'Mine');
  assert.deepEqual(plist.NSUserActivityTypes, ['INPlayMediaIntent']);

  const off = helpers.applyInfoPlist(
    { UIBackgroundModes: ['audio'] },
    helpers.resolveOptions({ backgroundAudio: false, cast: true })
  );
  assert.deepEqual(off.UIBackgroundModes, []);
  assert.match(off.NSLocalNetworkUsageDescription, /Cast/);

  const devLauncher = helpers.applyInfoPlist(
    {
      NSLocalNetworkUsageDescription:
        'Expo Dev Launcher uses the local network…',
    },
    helpers.resolveOptions({ cast: true })
  );
  assert.match(devLauncher.NSLocalNetworkUsageDescription, /Cast/);
  const own = helpers.applyInfoPlist(
    { NSLocalNetworkUsageDescription: 'My app finds speakers.' },
    helpers.resolveOptions({ cast: true })
  );
  assert.equal(own.NSLocalNetworkUsageDescription, 'My app finds speakers.');
  assert.equal(off.RNAPCastReceiverId, undefined);
  assert.equal(off.NSUserActivityTypes, undefined);
});

test('entitlements, Podfile and Gradle properties follow the options', () => {
  const on = helpers.resolveOptions({ cast: true, siri: true });
  const off = helpers.resolveOptions({});
  assert.deepEqual(helpers.applyEntitlements({}, on), {
    'com.apple.developer.siri': true,
  });
  assert.deepEqual(helpers.applyEntitlements({ a: 1 }, off), { a: 1 });
  assert.deepEqual(helpers.applyPodfileProperties({ x: '1' }, on), {
    'x': '1',
    'rnap.cast': 'true',
  });
  assert.deepEqual(
    helpers.applyPodfileProperties({ 'rnap.cast': 'true' }, off),
    {}
  );
  const gradle = [{ type: 'comment', value: 'hi' }];
  assert.deepEqual(helpers.applyGradleProperties(gradle, on), [
    { type: 'comment', value: 'hi' },
    { type: 'property', key: 'rnapCast', value: 'true' },
  ]);
  assert.deepEqual(
    helpers.applyGradleProperties(
      helpers.applyGradleProperties(gradle, on),
      off
    ),
    gradle
  );
});

test('the play-from-search intent filter is added once', () => {
  const activity = {
    '$': { 'android:name': '.MainActivity' },
    'intent-filter': [
      { action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }] },
    ],
  };
  const once = helpers.addPlayFromSearchFilter(activity);
  assert.equal(once['intent-filter'].length, 2);
  assert.deepEqual(once['intent-filter'][1], {
    action: [
      { $: { 'android:name': 'android.media.action.MEDIA_PLAY_FROM_SEARCH' } },
    ],
    category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
  });
  assert.equal(helpers.addPlayFromSearchFilter(once), once);
  assert.equal(helpers.addPlayFromSearchFilter({})['intent-filter'].length, 1);
});

test('MainActivity hands its intents to RNAP, once', () => {
  const out = helpers.injectHandleIntent(MAIN_ACTIVITY);
  assert.match(out, /import com\.anythingplayer\.AnythingPlayer/);
  assert.match(out, /import android\.content\.Intent/);
  assert.match(
    out,
    /super\.onCreate\(null\)\n {4}AnythingPlayer\.handleIntent\(this, intent\)\n/
  );
  assert.match(
    out,
    /override fun onNewIntent\(intent: Intent\) \{\n {4}super\.onNewIntent\(intent\)\n {4}AnythingPlayer\.handleIntent\(this, intent\)\n {2}\}\n\}\n$/
  );
  assert.equal(helpers.injectHandleIntent(out), out);

  const withNewIntent = MAIN_ACTIVITY.replace(
    '  override fun getMainComponentName',
    '  override fun onNewIntent(intent: Intent) {\n    super.onNewIntent(intent)\n  }\n\n  override fun getMainComponentName'
  );
  const merged = helpers.injectHandleIntent(withNewIntent);
  assert.equal(merged.match(/override fun onNewIntent/g).length, 1);
  assert.equal(merged.match(/AnythingPlayer\.handleIntent/g).length, 2);

  assert.throws(
    () => helpers.injectHandleIntent('package a\n\nclass MainActivity {}\n'),
    /by hand/
  );
});
