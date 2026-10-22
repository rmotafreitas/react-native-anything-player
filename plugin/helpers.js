// Pure edits behind the Expo config plugin (app.plugin.js): each takes the
// plain data a mod hands over (Info.plist, entitlements, manifest, source
// text) and returns it changed. No Expo import, so the tooling tests run them
// without an Expo project (scripts/__tests__/expo-plugin.test.mjs).

const DEFAULT_RECEIVER_ID = 'CC1AD845';
const PLAY_FROM_SEARCH = 'android.media.action.MEDIA_PLAY_FROM_SEARCH';
const HANDLE_INTENT = 'AnythingPlayer.handleIntent(this, intent)';
const DEV_LAUNCHER_TEXT = /Expo Dev Launcher/;

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
    assistant: options.assistant !== false,
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
  if (resolved.backgroundAudio) modes.add('audio');
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
  return out;
}

/** iOS entitlements: the Siri capability. */
function applyEntitlements(entitlements, resolved) {
  if (!resolved.siri) return entitlements;
  return { ...entitlements, 'com.apple.developer.siri': true };
}

/** `ios/Podfile.properties.json`: read by AnythingPlayer.podspec. */
function applyPodfileProperties(properties, resolved) {
  const out = { ...properties };
  if (resolved.cast) out['rnap.cast'] = 'true';
  else delete out['rnap.cast'];
  return out;
}

/** `android/gradle.properties` entries: read by android/build.gradle. */
function applyGradleProperties(entries, resolved) {
  const out = entries.filter(
    (e) => !(e.type === 'property' && e.key === 'rnapCast')
  );
  if (resolved.cast)
    out.push({ type: 'property', key: 'rnapCast', value: 'true' });
  return out;
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
  addPlayFromSearchFilter,
  applyEntitlements,
  applyGradleProperties,
  applyInfoPlist,
  applyPodfileProperties,
  injectHandleIntent,
  resolveOptions,
};
