// The Expo config plugin's edits (plugin/helpers.js, plugin/appIntents.js).
// The Xcode extension target (plugin/intentsExtension.js) is exercised by an
// `expo prebuild` of the Expo example, which CI does not run; see
// docs/testing.md.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const helpers = require('../../plugin/helpers.js');
const appIntents = require('../../plugin/appIntents.js');

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

test('Siri: App Intents unless turned off', () => {
  assert.deepEqual(helpers.resolveOptions({ siri: true }).siri, {
    usageDescription: 'Lets you ask Siri to play stations and episodes.',
    appIntents: true,
  });
  assert.equal(
    helpers.resolveOptions({ siri: { appIntents: false } }).siri.appIntents,
    false
  );
});

/** A parsed project as node-xcode holds it: an app target, its group. */
function xcodeProject(group) {
  let next = 0;
  return {
    generateUuid: () => `UUID${String(++next).padStart(20, '0')}`,
    hash: {
      project: {
        objects: {
          PBXNativeTarget: {
            T1: {
              isa: 'PBXNativeTarget',
              buildPhases: [
                { value: 'P0', comment: 'Frameworks' },
                { value: 'P1', comment: 'Sources' },
              ],
              name: 'RNAPIntents',
              productType: '"com.apple.product-type.app-extension"',
            },
            T1_comment: 'RNAPIntents',
            T2: {
              isa: 'PBXNativeTarget',
              buildPhases: [{ value: 'P2', comment: 'Sources' }],
              name: 'MyApp',
              productType: '"com.apple.product-type.application"',
            },
            T2_comment: 'MyApp',
          },
          PBXSourcesBuildPhase: {
            P1: { isa: 'PBXSourcesBuildPhase', files: [] },
            P2: {
              isa: 'PBXSourcesBuildPhase',
              files: [{ value: 'B1', comment: 'AppDelegate.swift in Sources' }],
            },
          },
          PBXFrameworksBuildPhase: { P0: { files: [] } },
          PBXBuildFile: { B1: { isa: 'PBXBuildFile', fileRef: 'F1' } },
          PBXFileReference: {
            F1: { isa: 'PBXFileReference', path: '"MyApp/AppDelegate.swift"' },
          },
          PBXGroup: {
            G0: { isa: 'PBXGroup', children: [], sourceTree: '"<group>"' },
            G1: {
              isa: 'PBXGroup',
              children: [{ value: 'F1', comment: 'AppDelegate.swift' }],
              sourceTree: '"<group>"',
              ...group,
            },
          },
        },
      },
    },
  };
}

test('App Intents: the template joins the app target, once', () => {
  const project = xcodeProject({ name: 'MyApp' });
  const objects = project.hash.project.objects;
  appIntents.addAppIntentsSource(project, { projectName: 'MyApp' });
  const [ref] = objects.PBXGroup.G1.children.slice(-1);
  assert.equal(ref.comment, 'RNAPAppIntents.swift');
  // A group with only a name sits at its parent's path.
  assert.deepEqual(objects.PBXFileReference[ref.value], {
    isa: 'PBXFileReference',
    lastKnownFileType: 'sourcecode.swift',
    name: 'RNAPAppIntents.swift',
    path: 'MyApp/RNAPAppIntents.swift',
    sourceTree: '"<group>"',
  });
  const files = objects.PBXSourcesBuildPhase.P2.files;
  assert.equal(files.length, 2);
  assert.equal(objects.PBXBuildFile[files[1].value].fileRef, ref.value);
  assert.equal(files[1].comment, 'RNAPAppIntents.swift in Sources');
  assert.equal(objects.PBXSourcesBuildPhase.P1.files.length, 0);

  appIntents.addAppIntentsSource(project, { projectName: 'MyApp' });
  assert.equal(objects.PBXGroup.G1.children.length, 2);
  assert.equal(files.length, 2);
});

test('App Intents: a folder group, a name to quote, a missing group', () => {
  const folder = xcodeProject({ path: '"My App"' });
  appIntents.addAppIntentsSource(folder, { projectName: 'My App' });
  const objects = folder.hash.project.objects;
  const [ref] = objects.PBXGroup.G1.children.slice(-1);
  assert.equal(
    objects.PBXFileReference[ref.value].path,
    'RNAPAppIntents.swift'
  );

  const named = xcodeProject({ name: '"my-app"' });
  appIntents.addAppIntentsSource(named, { projectName: 'my-app' });
  const refs = named.hash.project.objects.PBXFileReference;
  assert.ok(
    Object.values(refs).some((r) => r.path === '"my-app/RNAPAppIntents.swift"')
  );

  assert.throws(
    () =>
      appIntents.addAppIntentsSource(xcodeProject({ name: 'Other' }), {
        projectName: 'MyApp',
      }),
    /by hand/
  );
});
