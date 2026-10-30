// Pure edits behind the Expo config plugin (app.plugin.js): each takes the
// plain data a mod hands over (Info.plist, entitlements, manifest, source
// text) and returns it changed. No Expo import, so the tooling tests run them
// without an Expo project (scripts/__tests__/expo-plugin.test.mjs).

const DEFAULT_RECEIVER_ID = 'CC1AD845';
const PLAY_FROM_SEARCH = 'android.media.action.MEDIA_PLAY_FROM_SEARCH';
const HANDLE_INTENT = 'AnythingPlayer.handleIntent(this, intent)';
const DEV_LAUNCHER_TEXT = /Expo Dev Launcher/;
const CARPLAY_ROLE = 'CPTemplateApplicationSceneSessionRoleApplication';
const WINDOW_ROLE = 'UIWindowSceneSessionRoleApplication';
const CARPLAY_SCENE = {
  UISceneClassName: 'CPTemplateApplicationScene',
  UISceneConfigurationName: 'RNAP CarPlay',
  UISceneDelegateClassName: 'RNAPCarPlaySceneDelegate',
};

/** Normalizes the plugin's options (see app.plugin.js). */
function resolveOptions(options = {}) {
  const cast = options.cast;
  const castOptions = cast && typeof cast === 'object' ? cast : {};
  const siri = options.siri;
  const siriOptions = siri && typeof siri === 'object' ? siri : {};
  return {
    backgroundAudio: options.backgroundAudio !== false,
    cast: cast
      ? {
          receiverApplicationId:
            castOptions.receiverApplicationId || DEFAULT_RECEIVER_ID,
          customReceiver: Boolean(castOptions.receiverApplicationId),
          localNetworkUsageDescription:
            castOptions.localNetworkUsageDescription ||
            'Finds Cast devices on your network to play audio on them.',
        }
      : null,
    siri: siri
      ? {
          usageDescription:
            siriOptions.usageDescription ||
            'Lets you ask Siri to play stations and episodes.',
          appIntents: siriOptions.appIntents !== false,
        }
      : null,
    sound: options.sound === true,
    assistant: options.assistant !== false,
    car: Boolean(options.car),
    video: options.video
      ? {
          pictureInPicture:
            typeof options.video !== 'object' ||
            options.video.pictureInPicture !== false,
        }
      : null,
    videoDecoders: options.videoDecoders === true,
  };
}

function union(list, values) {
  const out = Array.isArray(list) ? [...list] : [];
  const present = new Set(out);
  for (const value of values) if (!present.has(value)) out.push(value);
  return out;
}

/** iOS `Info.plist`: background audio, Cast discovery, Siri. */
function applyInfoPlist(plist, resolved) {
  const out = { ...plist };
  const modes = new Set(out.UIBackgroundModes ?? []);
  // Picture in Picture needs the `audio` mode too.
  if (resolved.backgroundAudio || resolved.video?.pictureInPicture)
    modes.add('audio');
  else modes.delete('audio');
  out.UIBackgroundModes = [...modes];
  if (resolved.cast) {
    const id = resolved.cast.receiverApplicationId;
    // Expo Dev Launcher's own text is stripped from release builds (with
    // `_expo._tcp`), which would leave Cast discovery without one.
    const current = out.NSLocalNetworkUsageDescription;
    if (!current || DEV_LAUNCHER_TEXT.test(current))
      out.NSLocalNetworkUsageDescription =
        resolved.cast.localNetworkUsageDescription;
    out.NSBonjourServices = union(out.NSBonjourServices, [
      '_googlecast._tcp',
      `_${id}._googlecast._tcp`,
    ]);
    if (resolved.cast.customReceiver) out.RNAPCastReceiverId = id;
  }
  if (resolved.siri) {
    out.NSSiriUsageDescription ??= resolved.siri.usageDescription;
    out.NSUserActivityTypes = union(out.NSUserActivityTypes, [
      'INPlayMediaIntent',
    ]);
  }
  if (resolved.car) out.UIApplicationSceneManifest = addCarPlayScene(out);
  return out;
}

/**
 * The scene manifest with CarPlay's scene (a `CPTemplateApplicationScene`
 * handled by RNAP's delegate) added, and multiple scenes allowed. Everything
 * else in the manifest (the phone's window scene) is kept.
 */
function addCarPlayScene(plist) {
  const manifest = plist.UIApplicationSceneManifest ?? {};
  const configurations = manifest.UISceneConfigurations ?? {};
  const others = (configurations[CARPLAY_ROLE] ?? []).filter(
    (c) => c.UISceneConfigurationName !== CARPLAY_SCENE.UISceneConfigurationName
  );
  return {
    ...manifest,
    UIApplicationSupportsMultipleScenes: true,
    UISceneConfigurations: {
      ...configurations,
      [CARPLAY_ROLE]: [...others, CARPLAY_SCENE],
    },
  };
}

/**
 * Whether the phone has a window scene in the manifest. Without one, adding
 * CarPlay's scene would make the app scene-based with no scene for the phone's
 * window; the app must adopt the scene life cycle first (iOS 27 requires it).
 */
function hasWindowScene(plist) {
  const configurations =
    plist.UIApplicationSceneManifest?.UISceneConfigurations ?? {};
  return (configurations[WINDOW_ROLE] ?? []).length > 0;
}

/** iOS entitlements: the Siri capability, the CarPlay audio capability. */
function applyEntitlements(entitlements, resolved) {
  const out = { ...entitlements };
  if (resolved.siri) out['com.apple.developer.siri'] = true;
  if (resolved.car) out['com.apple.developer.carplay-audio'] = true;
  return out;
}

/** `ios/Podfile.properties.json`: read by AnythingPlayer.podspec. */
function applyPodfileProperties(properties, resolved) {
  const out = { ...properties };
  if (resolved.cast) out['rnap.cast'] = 'true';
  else delete out['rnap.cast'];
  if (resolved.sound) out['rnap.sound'] = 'true';
  else delete out['rnap.sound'];
  if (resolved.car) out['rnap.car'] = 'true';
  else delete out['rnap.car'];
  if (resolved.video) out['rnap.video'] = 'true';
  else delete out['rnap.video'];
  return out;
}

/** `android/gradle.properties` entries: read by android/build.gradle. */
function applyGradleProperties(entries, resolved) {
  const out = entries.filter(
    (e) =>
      !(
        e.type === 'property' &&
        [
          'rnapCast',
          'rnapSound',
          'rnapCar',
          'rnapVideo',
          'rnapVideoDecoders',
        ].includes(e.key)
      )
  );
  if (resolved.cast)
    out.push({ type: 'property', key: 'rnapCast', value: 'true' });
  if (resolved.sound)
    out.push({ type: 'property', key: 'rnapSound', value: 'true' });
  if (resolved.car)
    out.push({ type: 'property', key: 'rnapCar', value: 'true' });
  if (resolved.video)
    out.push({ type: 'property', key: 'rnapVideo', value: 'true' });
  if (resolved.videoDecoders)
    out.push({ type: 'property', key: 'rnapVideoDecoders', value: 'true' });
  return out;
}

/** What Picture in Picture resizes: the activity keeps running through it. */
const PIP_CONFIG_CHANGES = [
  'screenSize',
  'smallestScreenSize',
  'screenLayout',
  'orientation',
];

/**
 * The main activity in Picture in Picture: `supportsPictureInPicture`, and
 * the size and orientation changes it handles itself (no restart when the
 * window shrinks).
 */
function applyPictureInPicture(activity) {
  const attributes = { ...(activity.$ ?? {}) };
  attributes['android:supportsPictureInPicture'] = 'true';
  const current = (attributes['android:configChanges'] ?? '')
    .split('|')
    .filter(Boolean);
  attributes['android:configChanges'] = union(current, PIP_CONFIG_CHANGES).join(
    '|'
  );
  return { ...activity, $: attributes };
}

/** The main activity's `MEDIA_PLAY_FROM_SEARCH` intent filter (Google Assistant, Gemini). */
function addPlayFromSearchFilter(activity) {
  const filters = activity['intent-filter'] ?? [];
  const present = filters.some((f) =>
    (f.action ?? []).some((a) => a.$?.['android:name'] === PLAY_FROM_SEARCH)
  );
  if (present) return activity;
  return {
    ...activity,
    'intent-filter': [
      ...filters,
      {
        action: [{ $: { 'android:name': PLAY_FROM_SEARCH } }],
        category: [
          { $: { 'android:name': 'android.intent.category.DEFAULT' } },
        ],
      },
    ],
  };
}

function addImport(source, line) {
  if (source.includes(line)) return source;
  return source.replace(/^(package [^\n]+\n)/, `$1\n${line}`);
}

/**
 * Hands the main activity's intents to RNAP (Kotlin `MainActivity`): after
 * `super.onCreate(…)`, and in an `onNewIntent` (added when missing).
 */
function injectHandleIntent(source) {
  if (source.includes(HANDLE_INTENT)) return source;
  let out = addImport(source, 'import com.anythingplayer.AnythingPlayer');
  out = addImport(out, 'import android.content.Intent');
  const onCreate = /(\n([ \t]*)super\.onCreate\([^)]*\)\n)/;
  if (!onCreate.test(out))
    throw new Error(
      'react-native-anything-player: MainActivity has no super.onCreate(…); add AnythingPlayer.handleIntent by hand (see docs/voice.md).'
    );
  out = out.replace(onCreate, `$1$2${HANDLE_INTENT}\n`);
  const onNewIntent = /(\n([ \t]*)super\.onNewIntent\(intent\)\n)/;
  if (onNewIntent.test(out)) {
    out = out.replace(onNewIntent, `$1$2${HANDLE_INTENT}\n`);
  } else {
    const end = out.lastIndexOf('}');
    out = `${out.slice(0, end).replace(/\s*$/, '\n')}
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    ${HANDLE_INTENT}
  }
}
`;
  }
  return out;
}

module.exports = {
  DEFAULT_RECEIVER_ID,
  addCarPlayScene,
  addPlayFromSearchFilter,
  applyEntitlements,
  applyGradleProperties,
  applyInfoPlist,
  applyPictureInPicture,
  applyPodfileProperties,
  hasWindowScene,
  injectHandleIntent,
  resolveOptions,
};
