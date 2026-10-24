// The module registry: every build-time part of RNAP that can be switched, and
// where each switch lives. `add`, `remove`, `modules`, `size`, `info` and the
// doctor's module check all read this table, so a new module is one entry.
//
// Switches (`gradle`, `pod`, `plist`, `expo`) are the places the CLI can write;
// `manual` is what it prints when a place has no safe automatic edit. A module
// is on when its switch is on, or — with no switch written — when it is on by
// default (`defaultOn` describes the Expo plugin and the measured APK; `gradle`
// and `pod` entries carry their own default for a native project).

import path from 'node:path';
import { LIBRARY, parseProperties, setProperty } from './project.mjs';
import {
  addPlistArrayItem,
  removePlistArrayItem,
  setPlistString,
} from './plist.mjs';
import { editJsonDetailed, editResult } from './edits.mjs';
import { readText, relative } from './util.mjs';

/**
 * @typedef {object} Module
 * @property {string} id the name `rnap add` takes
 * @property {string} label
 * @property {string} description one line, shown by the picker and `modules`
 * @property {boolean} defaultOn the Expo plugin's default (and the measured build)
 * @property {string[]} platforms `android` and/or `ios`
 * @property {{key: string, on: string, off: string, defaultOn?: boolean}} [gradle] android/gradle.properties
 * @property {{key: string}} [pod] ios/Podfile.properties.json
 * @property {{key: string, item: string}} [plist] an Info.plist array item
 * @property {{key: string, item?: string, value?: string}[]} [plistExtras]
 *   further Info.plist keys a module needs (Cast discovery)
 * @property {{key: string, type?: 'string'}} [expo] option of the Expo config plugin
 * @property {{key: string}} [offMarker] a key in ios/Podfile.properties.json set
 *   to `"false"` when the module is turned off on purpose. Nothing builds from
 *   it: it tells the doctor the missing setting is intended.
 * @property {string} [manualUndo] what to undo by hand when the module goes off
 * @property {Record<string, string>} [manual] steps by platform, or `expo`
 * @property {string} docs where the switch is documented
 */

/** @type {Module[]} */
export const MODULES = [
  {
    id: 'hls',
    label: 'HLS',
    description:
      'HLS streams on Android (the Media3 HLS module). iOS plays HLS itself.',
    defaultOn: true,
    platforms: ['android'],
    gradle: { key: 'rnapHls', on: 'true', off: 'false', defaultOn: true },
    manual: {
      expo: 'HLS on Android has no Expo plugin option: after `npx expo prebuild`, set `rnapHls` in android/gradle.properties (on unless it is `false`). Set it now and re-apply it after a `prebuild --clean`.',
    },
    docs: 'docs/configuration.md#build-time-options',
  },
  {
    id: 'cast',
    label: 'Google Cast',
    description: 'Cast to Chromecast and Google Home devices.',
    defaultOn: false,
    platforms: ['android', 'ios'],
    gradle: { key: 'rnapCast', on: 'true', off: 'false' },
    pod: { key: 'rnap.cast' },
    expo: { key: 'cast', type: 'string' },
    plistExtras: [
      { key: 'NSBonjourServices', item: '_googlecast._tcp' },
      { key: 'NSBonjourServices', item: '_CC1AD845._googlecast._tcp' },
      {
        key: 'NSLocalNetworkUsageDescription',
        value:
          'Finds Cast devices on your network to play audio on them.',
      },
    ],
    docs: 'docs/routes-and-casting.md',
  },
  {
    id: 'siri',
    label: 'Siri',
    description: 'Siri requests and shortcuts (an Intents extension on iOS).',
    defaultOn: false,
    platforms: ['ios'],
    expo: { key: 'siri', type: 'string' },
    manual: {
      ios: 'Siri needs an Intents extension target, the Siri entitlement, NSSiriUsageDescription and INPlayMediaIntent in NSUserActivityTypes: follow docs/voice.md#siri, or use the Expo plugin with `siri: true`.',
    },
    docs: 'docs/voice.md#siri',
  },
  {
    id: 'assistant',
    label: 'Google Assistant',
    description: 'Google Assistant and Gemini requests on Android.',
    defaultOn: true,
    platforms: ['android'],
    expo: { key: 'assistant' },
    manual: {
      android:
        'Add the MEDIA_PLAY_FROM_SEARCH intent filter to the main activity, then call AnythingPlayer.handleIntent in onCreate and onNewIntent: docs/voice.md#google-assistant-gemini.',
    },
    docs: 'docs/voice.md#google-assistant-gemini',
  },
  {
    id: 'background-audio',
    label: 'Background audio',
    description: 'The iOS `audio` background mode: playback with the screen off.',
    defaultOn: true,
    platforms: ['ios'],
    expo: { key: 'backgroundAudio' },
    plist: { key: 'UIBackgroundModes', item: 'audio' },
    offMarker: { key: 'rnap.backgroundAudio' },
    docs: 'docs/getting-started.md#bare-react-native',
  },
  {
    id: 'sound',
    label: 'Sound effects',
    description:
      'Short sounds with the Sound API (react-native-anything-player/sound).',
    defaultOn: false,
    platforms: ['android', 'ios'],
    gradle: { key: 'rnapSound', on: 'true', off: 'false' },
    pod: { key: 'rnap.sound' },
    expo: { key: 'sound' },
    docs: 'docs/sound.md#enabling-it',
  },
  {
    id: 'car',
    label: 'Cars',
    description: 'Android Auto and CarPlay browsing.',
    defaultOn: false,
    platforms: ['android', 'ios'],
    gradle: { key: 'rnapCar', on: 'true', off: 'false' },
    pod: { key: 'rnap.car' },
    expo: { key: 'car' },
    manual: {
      ios: 'CarPlay also needs Apple\'s CarPlay audio entitlement (`com.apple.developer.carplay-audio`) and the `RNAP CarPlay` scene in `UIApplicationSceneManifest`: follow docs/cars-and-watches.md#carplay, or use the Expo plugin with `car: true`.',
    },
    manualUndo:
      'Remove the `RNAP CarPlay` scene from `UIApplicationSceneManifest` and the `com.apple.developer.carplay-audio` entitlement by hand (the CLI does not edit them).',
    docs: 'docs/cars-and-watches.md',
  },
  {
    id: 'video',
    label: 'Video',
    description:
      'Video players and <VideoView> (react-native-anything-player/video). The web needs no switch.',
    defaultOn: false,
    platforms: ['android', 'ios'],
    gradle: { key: 'rnapVideo', on: 'true', off: 'false' },
    pod: { key: 'rnap.video' },
    expo: { key: 'video', type: 'string' },
    manual: {
      android:
        'For Picture in Picture, mark the main activity in AndroidManifest.xml: android:supportsPictureInPicture="true", with screenSize|smallestScreenSize|screenLayout|orientation in its android:configChanges (docs/video.md#picture-in-picture). The Expo plugin\'s `video` option does it.',
    },
    docs: 'docs/video.md#enabling-it',
  },
  {
    id: 'video-decoders',
    label: 'Software decoders',
    description:
      "Android: decodes what the device cannot (AC-3, E-AC-3, DTS, TrueHD and MPEG audio with FFmpeg; VP9; AV1). Downloaded once from RNAP's GitHub release, checksums pinned.",
    defaultOn: false,
    platforms: ['android'],
    gradle: { key: 'rnapVideoDecoders', on: 'true', off: 'false' },
    expo: { key: 'videoDecoders' },
    docs: 'docs/video.md#software-decoders',
  },
];

export const MODULE_IDS = MODULES.map((module) => module.id);

export function findModule(id) {
  return MODULES.find((module) => module.id === id) ?? null;
}

/** Splits `add`/`remove` arguments into known modules and unknown names. */
export function resolveModules(names) {
  const modules = [];
  const unknown = [];
  for (const name of names) {
    const module = findModule(name);
    if (module) {
      if (!modules.includes(module)) modules.push(module);
    } else unknown.push(name);
  }
  return { modules, unknown };
}

/** The Expo plugin option keys the registry knows, for the doctor. */
export function expoOptions() {
  return MODULES.filter((module) => module.expo).map((module) => ({
    key: module.expo.key,
    type: module.expo.type ?? 'boolean',
  }));
}

/** One place a module can be switched, with whether it is written there. */
function place(value, explicit) {
  return { value: Boolean(value), explicit: Boolean(explicit) };
}

function expoState(module, ctx) {
  if (!module.expo || !ctx.expo.rnapPlugin || ctx.jsConfigFile) return null;
  const raw = ctx.expo.rawOptions;
  const options =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  const explicit = Boolean(options && options[module.expo.key] !== undefined);
  if (!options) return place(module.defaultOn, false);
  const value = options[module.expo.key];
  return place(value === undefined ? module.defaultOn : Boolean(value), explicit);
}

function gradleState(module, ctx) {
  if (!module.gradle || !ctx.android.present) return null;
  const text = ctx.android.gradlePropertiesText;
  const value =
    text === null ? undefined : parseProperties(text)[module.gradle.key];
  if (value === undefined)
    return place(module.gradle.defaultOn ?? false, false);
  return place(
    value.toLowerCase() === module.gradle.on.toLowerCase(),
    true
  );
}

function podState(module, ctx) {
  if (!module.pod || !ctx.ios.present) return null;
  const properties = ctx.ios.podfileProperties;
  if (!properties) return place(false, false);
  const value = properties[module.pod.key];
  if (value === undefined) return place(false, false);
  return place(value === 'true' || value === true, true);
}

function plistState(module, ctx) {
  if (!module.plist || !ctx.ios.present) return null;
  const value = ctx.ios.infoPlist?.[module.plist.key];
  if (!Array.isArray(value)) return place(false, false);
  return place(value.includes(module.plist.item), true);
}

/**
 * Whether a bare project already carries what a manual module needs, judged
 * from files the doctor already reads. `null` when there is no way to tell.
 */
function manualState(module, ctx) {
  if (module.id === 'siri') {
    if (!ctx.ios.present) return null;
    return Boolean(
      /RNAPIntents/.test(ctx.ios.pbxproj ?? '') ||
        ctx.ios.infoPlist?.NSSiriUsageDescription
    );
  }
  if (module.id === 'assistant') {
    if (!ctx.android.present) return null;
    return (
      /android\.media\.action\.MEDIA_PLAY_FROM_SEARCH/.test(
        ctx.android.manifest ?? ''
      ) && /AnythingPlayer\.handleIntent/.test(ctx.android.mainActivity ?? '')
    );
  }
  return null;
}

/** The manual place for a platform, or `null` when the module has none. */
function manualPlace(module, platform, ctx) {
  if (!module.manual?.[platform]) return null;
  const value = manualState(module, ctx);
  if (value === null) return null;
  return place(value, value);
}

/** The first place a module is explicitly written, for `source`. */
function sourceOf({ expo, gradle, pod, plist, androidManual, iosManual }) {
  if (expo?.explicit) return 'app.json';
  if (gradle?.explicit) return 'android/gradle.properties';
  if (pod?.explicit) return 'ios/Podfile.properties.json';
  if (plist?.explicit) return 'Info.plist';
  if (androidManual?.value || iosManual?.value) return 'manual';
  return 'default';
}

/**
 * One entry per module: the state in every place (or `null` when the place does
 * not apply), the effective state a build produces, and where it is configured.
 */
export function moduleStates(ctx) {
  return MODULES.map((module) => {
    const expo = expoState(module, ctx);
    const gradle = gradleState(module, ctx);
    const pod = podState(module, ctx);
    const plist = plistState(module, ctx);
    const androidManual = module.platforms.includes('android')
      ? manualPlace(module, 'android', ctx)
      : null;
    const iosManual = module.platforms.includes('ios')
      ? manualPlace(module, 'ios', ctx)
      : null;

    const android = gradle ?? androidManual;
    const ios = pod ?? plist ?? iosManual;

    let effective;
    if (expo !== null) effective = expo.value;
    else {
      const places = [];
      if (android) places.push(android.value);
      if (ios) places.push(ios.value);
      effective = places.length > 0 ? places.some(Boolean) : module.defaultOn;
    }

    return {
      id: module.id,
      label: module.label,
      description: module.description,
      defaultOn: module.defaultOn,
      platforms: module.platforms,
      docs: module.docs,
      expo: expo?.value ?? null,
      android: android?.value ?? null,
      ios: ios?.value ?? null,
      effective,
      source: sourceOf({
        expo,
        gradle,
        pod,
        plist,
        androidManual,
        iosManual,
      }),
      written: [
        expo?.explicit ? 'app.json' : null,
        gradle?.explicit ? 'android/gradle.properties' : null,
        pod?.explicit ? 'ios/Podfile.properties.json' : null,
        plist?.explicit ? 'Info.plist' : null,
      ].filter(Boolean),
    };
  });
}

export function moduleState(ctx, id) {
  return moduleStates(ctx).find((state) => state.id === id) ?? null;
}

function pluginEntryIndex(plugins) {
  return plugins.findIndex(
    (entry) => (Array.isArray(entry) ? entry[0] : entry) === LIBRARY
  );
}

/** Sets one plugin option in an app.json, keeping the file's layout (see `editJsonDetailed`). */
export function setPluginOption(text, key, value) {
  return editJsonDetailed(text, (config) => {
    const expo = config.expo;
    if (!expo || typeof expo !== 'object') return false;
    const plugins = Array.isArray(expo.plugins) ? expo.plugins : [];
    const index = pluginEntryIndex(plugins);
    if (index === -1) return false;
    const entry = plugins[index];
    const current =
      Array.isArray(entry) &&
      entry[1] &&
      typeof entry[1] === 'object' &&
      !Array.isArray(entry[1])
        ? entry[1]
        : {};
    if (current[key] === value) return false;
    plugins[index] = [LIBRARY, { ...current, [key]: value }];
    expo.plugins = plugins;
    return true;
  });
}

const PODFILE_PROPERTIES = 'ios/Podfile.properties.json';

/**
 * The `offMarker` value to write for `on`, or `null` when the file already
 * says it: turning off writes `"false"`, turning on only resets a marker that
 * is there (an absent marker already means on).
 */
function offMarkerValue(ctx, module, on) {
  const current = ctx.ios.podfileProperties?.[module.offMarker.key];
  if (on) return current === undefined || current === 'true' ? null : 'true';
  return current === 'false' ? null : 'false';
}

function propertyValue(value) {
  return value ? 'true' : 'false';
}

/** The places that decide a module's state, from `moduleStates`. */
function applicablePlaces(state) {
  return [state.expo, state.android, state.ios].filter(
    (value) => value !== null
  );
}

function undoText(module) {
  return `Undo the ${module.label} setup by hand (the CLI does not edit it); the steps are the reverse of ${module.docs}.`;
}

/**
 * The edits `add`/`remove` make for one module, plus the steps it cannot make
 * safely. The project kind decides the place: the Expo plugin options in
 * app.json when the plugin is listed, else the native files.
 *
 * @param {object} ctx project snapshot
 * @param {Module} module
 * @param {boolean} on turn it on (true) or off (false)
 * @param {{readFile?: (file: string) => string|null}} [options]
 */
export function planModuleChanges(ctx, module, on, { readFile } = {}) {
  const edits = [];
  const manual = [];
  const state = moduleState(ctx, module.id);
  const places = state ? applicablePlaces(state) : [];
  const expoOwns = Boolean(ctx.expo.rnapPlugin) && !ctx.jsConfigFile;
  const markerPending =
    Boolean(module.offMarker) &&
    ctx.ios.present &&
    !(expoOwns && module.expo) &&
    offMarkerValue(ctx, module, on) !== null;
  if (
    places.length > 0 &&
    places.every((value) => value === on) &&
    !markerPending
  )
    return { edits, manual };

  const read = readFile ?? ((file) => readText(path.resolve(ctx.cwd, file)));

  const addEdit = (file, apply, change, { create = false } = {}) => {
    const before = read(file) ?? '';
    if (before === '' && !create) return false;
    let after;
    let note;
    try {
      ({ after, note } = editResult(apply(before)));
    } catch {
      // A file the CLI cannot parse stays a printed instruction.
      manual.push(`Could not edit ${file}: fix it by hand, then ${change}.`);
      return false;
    }
    if (after === null || after === before) return false;
    edits.push({
      file,
      before,
      after,
      change: note ? `${change} (${note})` : change,
      create,
    });
    return true;
  };

  if (module.expo && ctx.jsConfigFile) {
    const setting = JSON.stringify({ [module.expo.key]: on });
    manual.push(
      `app.config.js/ts is never rewritten: set ${setting} in the plugin options in ${relative(ctx.cwd, ctx.jsConfigFile)}, then run \`npx expo prebuild\`.`
    );
  } else if (module.expo && ctx.isExpo && !ctx.expo.rnapPlugin) {
    manual.push(
      'The Expo plugin is not listed: add `react-native-anything-player` to `expo.plugins` first (`npx rnap init`), then run this again.'
    );
  } else if (expoOwns && module.expo) {
    addEdit(
      'app.json',
      (before) => setPluginOption(before, module.expo.key, on),
      `set the plugin option \`${module.expo.key}\` to ${on}`
    );
  } else if (expoOwns && module.manual?.expo && places.length === 0) {
    manual.push(module.manual.expo);
  }

  const native = !(expoOwns && module.expo);
  if (native && module.gradle && ctx.android.present) {
    addEdit(
      'android/gradle.properties',
      (before) =>
        setProperty(
          before,
          module.gradle.key,
          on ? module.gradle.on : module.gradle.off
        ),
      `set \`${module.gradle.key}=${on ? module.gradle.on : module.gradle.off}\``,
      { create: ctx.android.gradlePropertiesText === null }
    );
  } else if (native && module.platforms.includes('android') && module.manual?.android) {
    if (manualState(module, ctx) === true) {
      if (!on) manual.push(undoText(module));
    } else if (on) {
      manual.push(module.manual.android);
    }
  }

  if (native && module.pod && ctx.ios.present) {
    addEdit(
      PODFILE_PROPERTIES,
      (before) =>
        editJsonDetailed(before === '' ? '{}\n' : before, (properties) => {
          const value = propertyValue(on);
          if (properties[module.pod.key] === value) return false;
          properties[module.pod.key] = value;
          return true;
        }),
      `set \`"${module.pod.key}": "${propertyValue(on)}"\``,
      { create: ctx.ios.podfileProperties === null }
    );
  }

  if (markerPending) {
    const value = offMarkerValue(ctx, module, on);
    addEdit(
      PODFILE_PROPERTIES,
      (before) =>
        editJsonDetailed(before === '' ? '{}\n' : before, (properties) => {
          properties[module.offMarker.key] = value;
          return true;
        }),
      on
        ? `set \`"${module.offMarker.key}": "true"\``
        : `set \`"${module.offMarker.key}": "false"\` (the doctor then reports ${module.id} as off on purpose)`,
      { create: ctx.ios.podfileProperties === null }
    );
  }

  if (native && module.plistExtras && ctx.ios.present) {
    if (ctx.ios.infoPlistFile) {
      addEdit(
        relative(ctx.cwd, ctx.ios.infoPlistFile),
        (before) => {
          let out = before;
          for (const extra of module.plistExtras) {
            const next = extra.item
              ? on
                ? addPlistArrayItem(out, extra.key, extra.item)
                : removePlistArrayItem(out, extra.key, extra.item)
              : on && extra.value !== undefined
                ? setPlistString(out, extra.key, extra.value)
                : null;
            if (next !== null) out = next;
          }
          return out === before ? null : out;
        },
        on
          ? 'add the Google Cast discovery keys (`NSLocalNetworkUsageDescription` and `NSBonjourServices`)'
          : 'remove the Google Cast Bonjour services (the usage description stays)'
      );
    } else {
      manual.push(
        'No app Info.plist was found: add `NSLocalNetworkUsageDescription` and the Google Cast entries of `NSBonjourServices` by hand.'
      );
    }
  }

  if (native && module.plist && ctx.ios.present) {
    if (ctx.ios.infoPlistFile) {
      addEdit(
        relative(ctx.cwd, ctx.ios.infoPlistFile),
        (before) =>
          on
            ? addPlistArrayItem(before, module.plist.key, module.plist.item)
            : removePlistArrayItem(before, module.plist.key, module.plist.item),
        `${on ? 'add' : 'remove'} \`${module.plist.item}\` in \`${module.plist.key}\``
      );
    } else {
      manual.push(
        `No app Info.plist was found: ${on ? 'add' : 'remove'} \`${module.plist.item}\` in \`${module.plist.key}\` by hand.`
      );
    }
  } else if (native && module.platforms.includes('ios') && module.manual?.ios) {
    if (manualState(module, ctx) === true) {
      if (!on) manual.push(undoText(module));
    } else if (on) {
      manual.push(module.manual.ios);
    } else if (module.manualUndo) {
      manual.push(module.manualUndo);
    }
  }

  return { edits, manual };
}
