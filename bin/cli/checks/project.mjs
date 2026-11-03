// Project-level checks: versions, the New Architecture switch, and the Expo
// config plugin (listed, and its options valid).

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { compareVersions, versionParts } from '../project.mjs';
import { expoOptions, moduleStates } from '../modules.mjs';
import { finding } from '../findings.mjs';
import { relative } from '../util.mjs';

const MIN_REACT_NATIVE = '0.80.0';
const MIN_EXPO_SDK = 54;

function checkReactNative(ctx, findings) {
  const version = ctx.dependencies['react-native'];
  if (!version) {
    findings.push(
      finding(
        'react-native-version',
        'error',
        '`react-native` is not a dependency of this project.',
        {
          file: 'package.json',
          change: 'add react-native 0.80 or newer to `dependencies`',
        }
      )
    );
    return;
  }
  if (compareVersions(version, MIN_REACT_NATIVE) === -1) {
    findings.push(
      finding(
        'react-native-version',
        'error',
        `React Native ${version} is older than 0.80. RNAP is a TurboModule and the legacy architecture is not supported (docs/getting-started.md).`,
        {
          file: 'package.json',
          change: `upgrade react-native to ${MIN_REACT_NATIVE} or newer`,
        }
      )
    );
  }
}

function checkExpoSdk(ctx, findings) {
  if (!ctx.isExpo) return;
  const version = ctx.expo.sdkVersion;
  if (!version) {
    findings.push(
      finding(
        'expo-sdk',
        'warning',
        'This looks like an Expo project, but `expo` is not a dependency, so its SDK version is unknown.',
        {
          file: 'package.json',
          change:
            'add expo to `dependencies`, or remove app.json if this is a bare app',
        }
      )
    );
    return;
  }
  const parts = versionParts(version);
  if (!parts) return;
  if (parts[0] < MIN_EXPO_SDK) {
    findings.push(
      finding(
        'expo-sdk',
        'error',
        `Expo SDK ${parts[0]} ships React Native below 0.80. RNAP needs Expo SDK ${MIN_EXPO_SDK} or newer (docs/getting-started.md).`,
        {
          file: 'package.json',
          change: `upgrade expo to SDK ${MIN_EXPO_SDK} or newer`,
        }
      )
    );
  }
}

function checkLibrary(ctx, findings) {
  const { library } = ctx;
  if (!library.version) {
    findings.push(
      finding(
        'library-installed',
        'error',
        'react-native-anything-player is not installed in this project.',
        {
          file: 'package.json',
          change:
            'run `npm install react-native-anything-player`, then rebuild',
        }
      )
    );
    return;
  }
  if (!library.installed) {
    findings.push(
      finding(
        'library-installed',
        'info',
        `react-native-anything-player ${library.version} resolved from ${relative(ctx.cwd, library.path)} (workspace or local checkout, not node_modules).`
      )
    );
  }
}

function checkIosNewArch(ctx, findings) {
  const { ios } = ctx;
  if (ctx.isExpo && !ios.present) {
    if (ctx.expo.config?.newArchEnabled === false) {
      findings.push(
        finding(
          'new-arch-ios',
          'error',
          'New Architecture is disabled (`newArchEnabled: false`). RNAP is a TurboModule and needs it (docs/getting-started.md).',
          {
            file: 'app.json',
            change:
              'set `expo.newArchEnabled` to `true` (or remove it: recent SDKs default to true)',
          },
          'expo-new-arch'
        )
      );
    }
    return;
  }
  if (!ios.present) return;

  const properties = ios.podfileProperties;
  const values = [
    properties?.newArchEnabled,
    properties?.RCT_NEW_ARCH_ENABLED,
    ios.infoPlist?.RCTNewArchEnabled,
  ];
  const podfileForcesOff =
    /RCT_NEW_ARCH_ENABLED[^\n]*?['"]0['"]/.test(ios.podfile ?? '') ||
    /RCT_NEW_ARCH_ENABLED\s*=\s*0\b/.test(ios.podfile ?? '');
  const disabled = values.some((value) => value === false || value === 'false');
  if (!disabled && !podfileForcesOff) return;

  findings.push(
    finding(
      'new-arch-ios',
      'error',
      'New Architecture is disabled for iOS. RNAP is a TurboModule and the legacy architecture is not supported (docs/getting-started.md).',
      {
        file: 'ios/Podfile.properties.json',
        change:
          'set `"newArchEnabled": "true"`, remove the RCT_NEW_ARCH_ENABLED override from the Podfile, then run `pod install`',
      },
      properties ? 'ios-new-arch' : null
    )
  );
}

function checkAndroidNewArch(ctx, findings) {
  if (!ctx.android.present) return;
  const properties = ctx.android.gradlePropertiesText ?? '';
  if (!/^\s*newArchEnabled\s*=\s*false\s*$/m.test(properties)) return;
  findings.push(
    finding(
      'new-arch-android',
      'error',
      'New Architecture is disabled (`newArchEnabled=false`). RNAP is a TurboModule and the legacy architecture is not supported (docs/getting-started.md).',
      {
        file: 'android/gradle.properties',
        change: 'set `newArchEnabled=true`, then rebuild the app',
      },
      'android-new-arch'
    )
  );
}

const EXPO_OPTIONS = expoOptions();
const KNOWN_OPTIONS = new Set(EXPO_OPTIONS.map((option) => option.key));
const STRING_OPTIONS = new Set(
  EXPO_OPTIONS.filter((option) => option.type === 'string').map(
    (option) => option.key
  )
);
const OPTION_LIST = EXPO_OPTIONS.map((option) => option.key).join(', ');
/** The keys of the options that take an object, and their types. */
const OBJECT_OPTIONS = {
  cast: {
    receiverApplicationId: 'string',
    localNetworkUsageDescription: 'string',
  },
  siri: { usageDescription: 'string', appIntents: 'boolean' },
  video: { pictureInPicture: 'boolean' },
  car: { ios: 'boolean', android: 'boolean' },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** `catalog`: the path of a JSON file, from the project root, that the build bundles. */
function checkCatalogOption(ctx, value, findings) {
  const fix = {
    file: 'app.json',
    change:
      'set `catalog` to the path of a JSON file with `{ items, playerId?, playerOptions?, browse? }` (docs/voice.md)',
  };
  if (value === false || value == null) return;
  if (typeof value !== 'string' || value.trim() === '') {
    findings.push(
      finding(
        'expo-plugin-options',
        'error',
        'Plugin option `catalog` must be the path of a JSON file.',
        fix
      )
    );
    return;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(path.resolve(ctx.cwd, value), 'utf8'));
  } catch (error) {
    findings.push(
      finding(
        'expo-plugin-options',
        'error',
        `Plugin option \`catalog\`: ${value} cannot be read as JSON (${error.message}); the build would fail.`,
        fix
      )
    );
    return;
  }
  if (!input || typeof input !== 'object' || !Array.isArray(input.items)) {
    findings.push(
      finding(
        'expo-plugin-options',
        'error',
        `Plugin option \`catalog\`: ${value} needs an \`items\` array.`,
        fix
      )
    );
    return;
  }
  // The prebuild's own check, with the app's installed version of the library.
  let catalogSeed;
  try {
    ({ catalogSeed } = createRequire(path.join(ctx.cwd, 'package.json'))(
      'react-native-anything-player/plugin/catalogSeed'
    ));
  } catch {
    return; // A version without it, or not installed: the prebuild says.
  }
  try {
    catalogSeed(input);
  } catch (error) {
    findings.push(
      finding(
        'expo-plugin-options',
        'error',
        `Plugin option \`catalog\`: ${value}: ${error.message} The prebuild would fail.`,
        fix
      )
    );
  }
}

function checkOptions(ctx, findings) {
  if (ctx.jsConfigFile) return;
  const raw = ctx.expo.rawOptions;
  if (!ctx.expo.rnapPlugin) return;
  const fix = {
    file: 'app.json',
    change:
      'use `["react-native-anything-player", { … }]` with the documented options',
  };

  if (!isPlainObject(raw)) {
    findings.push(
      finding(
        'expo-plugin-options',
        'error',
        'The plugin options must be an object.',
        fix
      )
    );
    return;
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'catalog') {
      checkCatalogOption(ctx, value, findings);
      continue;
    }
    if (!KNOWN_OPTIONS.has(key)) {
      findings.push(
        finding(
          'expo-plugin-options',
          'warning',
          `Unknown plugin option \`${key}\`: it is ignored. Options are ${OPTION_LIST} (docs/getting-started.md).`,
          {
            file: 'app.json',
            change: `remove \`${key}\` or rename it to a documented option`,
          }
        )
      );
      continue;
    }
    if (!STRING_OPTIONS.has(key) && typeof value !== 'boolean') {
      findings.push(
        finding(
          'expo-plugin-options',
          'error',
          `Plugin option \`${key}\` must be \`true\` or \`false\`.`,
          { file: 'app.json', change: `set \`${key}\` to a boolean` }
        )
      );
      continue;
    }
    if (STRING_OPTIONS.has(key)) {
      if (typeof value === 'boolean') continue;
      if (!isPlainObject(value)) {
        findings.push(
          finding(
            'expo-plugin-options',
            'error',
            `Plugin option \`${key}\` must be \`true\`, \`false\`, or an object.`,
            {
              file: 'app.json',
              change: `set \`${key}\` to a boolean or an object`,
            }
          )
        );
        continue;
      }
      const types = OBJECT_OPTIONS[key] ?? {};
      const allowed = Object.keys(types);
      for (const [inner, innerValue] of Object.entries(value)) {
        const type = types[inner];
        if (!type) {
          findings.push(
            finding(
              'expo-plugin-options',
              'warning',
              `Unknown \`${key}\` option \`${inner}\`.`,
              {
                file: 'app.json',
                change: `remove \`${key}.${inner}\`; allowed: ${allowed.join(', ')}`,
              }
            )
          );
        } else if (
          type === 'boolean'
            ? typeof innerValue !== 'boolean'
            : typeof innerValue !== 'string' || innerValue === ''
        ) {
          findings.push(
            finding(
              'expo-plugin-options',
              'error',
              `Plugin option \`${key}.${inner}\` must be a ${type === 'boolean' ? 'boolean' : 'non-empty string'}.`,
              {
                file: 'app.json',
                change: `set \`${key}.${inner}\` to a ${type}`,
              }
            )
          );
        }
      }
    }
  }
}

/**
 * The Expo plugin and the native files must agree: `expo prebuild` rewrites
 * them from app.json, so a switch set the other way is lost on the next build.
 */
function checkModuleConflicts(ctx, findings) {
  if (!ctx.expo.rnapPlugin || ctx.jsConfigFile) return;
  for (const state of moduleStates(ctx)) {
    if (state.expo === null) continue;
    const native = [];
    if (state.written.includes('android/gradle.properties'))
      native.push({ file: 'android/gradle.properties', value: state.android });
    if (state.written.includes('ios/Podfile.properties.json'))
      native.push({ file: 'ios/Podfile.properties.json', value: state.ios });
    if (state.written.includes('Info.plist'))
      native.push({ file: 'Info.plist', value: state.ios });

    for (const place of native) {
      if (place.value === null || place.value === state.expo) continue;
      findings.push(
        finding(
          'module-conflict',
          'warning',
          `\`${state.id}\` is ${state.expo ? 'on' : 'off'} in the Expo plugin but ${place.value ? 'on' : 'off'} in ${place.file}: \`expo prebuild\` writes the native files from app.json, so one of the two wins by accident.`,
          {
            file: 'app.json',
            change: `set \`${state.id}\` to ${place.value} in the plugin options, or change ${place.file} to match`,
          }
        )
      );
    }
  }
}

function checkExpoPlugin(ctx, findings) {
  if (!ctx.isExpo) return;
  if (ctx.jsConfigFile) {
    findings.push(
      finding(
        'expo-config-js',
        'info',
        `This project uses ${relative(ctx.cwd, ctx.jsConfigFile)}: the CLI cannot evaluate JavaScript configs, so Expo checks read app.json only.`,
        null
      )
    );
    return;
  }
  if (!ctx.expo.config) return;
  if (ctx.expo.rnapPlugin) return;

  findings.push(
    finding(
      'expo-plugin',
      'error',
      'The RNAP config plugin is not listed, so the iOS audio background mode and the Assistant hook are never added (docs/getting-started.md).',
      {
        file: 'app.json',
        change:
          'add "react-native-anything-player" to `expo.plugins`, then rebuild or run `npx expo prebuild`',
      },
      'expo-plugin'
    )
  );
}

export function projectChecks(ctx) {
  const findings = [];
  if (!ctx.packageJson) {
    findings.push(
      finding(
        'project-package-json',
        'error',
        'No package.json here: run the CLI from the app directory, or pass `--cwd <dir>`.',
        {
          file: 'package.json',
          change: 'run `npx rnap doctor --cwd <app>`',
        }
      )
    );
    return findings;
  }
  checkReactNative(ctx, findings);
  checkLibrary(ctx, findings);
  checkExpoSdk(ctx, findings);
  checkExpoPlugin(ctx, findings);
  checkOptions(ctx, findings);
  checkModuleConflicts(ctx, findings);
  checkIosNewArch(ctx, findings);
  checkAndroidNewArch(ctx, findings);
  return findings;
}
