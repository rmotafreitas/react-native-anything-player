// iOS checks: background audio, the iOS 27 scene life cycle, Cast discovery,
// Siri, Pods, and deployment targets.

import fs from 'node:fs';
import {
  DEFAULT_RECEIVER_ID,
  compareVersions,
  parseProperties,
  pbxDeploymentTargets,
  podVersion,
  podfileDeploymentTarget,
} from '../project.mjs';
import { finding } from '../findings.mjs';
import { relative } from '../util.mjs';

const MIN_IOS = '15.1';

/**
 * The Info.plist the checks read: the prebuilt file when there is one, else
 * what app.json + the plugin produce before prebuild.
 */
function plistView(ctx) {
  if (ctx.ios.infoPlist)
    return {
      value: ctx.ios.infoPlist,
      file: ctx.ios.infoPlistFile,
      config: false,
    };
  if (!ctx.isExpo) return null;
  // A JavaScript config cannot be evaluated: without a prebuild there is no
  // trustworthy Info.plist to read.
  if (ctx.jsConfigFile) return null;
  return {
    value: ctx.iosPolicy.meldedInfoPlist ?? {},
    file: ctx.appJsonFile,
    config: true,
  };
}

function iosPath(ctx, file) {
  return relative(ctx.cwd, file);
}

function gradleCast(ctx) {
  return parseProperties(ctx.android.gradlePropertiesText).rnapCast === 'true';
}

function podCast(ctx) {
  return ctx.ios.podfileProperties?.['rnap.cast'] === 'true';
}

function castEnabled(ctx, plist) {
  return Boolean(
    podCast(ctx) ||
    gradleCast(ctx) ||
    ctx.expo.options?.cast ||
    plist?.RNAPCastReceiverId ||
    (plist?.NSBonjourServices ?? []).includes('_googlecast._tcp')
  );
}

function checkInfoPlistPresent(ctx, findings) {
  if (!ctx.ios.present || ctx.ios.infoPlist) return;
  if (ctx.ios.infoPlistError) {
    findings.push(
      finding(
        'ios-info-plist',
        'error',
        `Could not read the app's Info.plist: ${ctx.ios.infoPlistError}.`,
        {
          file: 'ios/<App>/Info.plist',
          change: 'fix the XML so the plist parses',
        }
      )
    );
    return;
  }
  findings.push(
    finding(
      'ios-info-plist',
      'warning',
      'No app Info.plist found under `ios/`; iOS settings cannot be checked.',
      {
        file: 'ios/<App>/Info.plist',
        change: 'create the app target (or run `npx expo prebuild`)',
      }
    )
  );
}

function checkBackgroundAudio(ctx, view, findings) {
  if (!view) return;
  // Without the plugin there is no background mode to inherit; the missing
  // plugin is already an error of its own.
  if (ctx.isExpo && !ctx.rnapPlugin && !ctx.ios.infoPlist) return;
  const modes = view.value.UIBackgroundModes ?? [];
  if (modes.includes('audio')) return;

  const disabledByPlugin = ctx.expo.options?.backgroundAudio === false;
  const fix = view.config
    ? {
        file: 'app.json',
        change:
          'add "audio" to `expo.ios.infoPlist.UIBackgroundModes` (or remove `backgroundAudio: false` from the plugin options)',
      }
    : {
        file: iosPath(ctx, view.file),
        change: 'add `<string>audio</string>` to `UIBackgroundModes`',
      };

  if (disabledByPlugin) {
    findings.push(
      finding(
        'ios-background-audio',
        'info',
        'Background audio is off (`backgroundAudio: false`): playback stops when the screen locks or the app is backgrounded.',
        null
      )
    );
    return;
  }

  findings.push(
    finding(
      'ios-background-audio',
      'error',
      'UIBackgroundModes does not include `audio`: audio stops when the app is backgrounded or the screen locks (docs/debugging.md).',
      fix,
      view.config ? null : 'ios-background-audio'
    )
  );
}

function checkSceneLifecycle(ctx, view, findings) {
  if (!view) return;
  if (view.value.UIApplicationSceneManifest) return;
  // A project-local config plugin may add the manifest; its source is the only
  // thing there is to inspect before prebuild.
  const pluginAddsIt = ctx.iosPolicy.localPlugins.some((plugin) =>
    /UIApplicationSceneManifest/.test(plugin.text)
  );
  if (pluginAddsIt) return;

  findings.push(
    finding(
      'ios-scene-lifecycle',
      'warning',
      'No `UIApplicationSceneManifest`: iOS 27 traps at launch with `NoSceneLifecycleAdoption` unless the app adopts the scene life cycle (docs/debugging.md).',
      view.config
        ? {
            file: 'app.json',
            change:
              'add a config plugin that subclasses `ExpoAppSceneDelegate` and sets `UIApplicationSceneManifest` (see example-expo/plugins/withSceneLifecycle.js)',
          }
        : {
            file: iosPath(ctx, view.file),
            change:
              'add `UIApplicationSceneManifest` and create the window in a `UIWindowSceneDelegate` (see example/ios/AnythingPlayerExample/AppDelegate.swift and docs/debugging.md)',
          }
    )
  );
}

function checkCastDiscovery(ctx, view, findings) {
  if (!view) return;
  const plist = view.value;
  if (!castEnabled(ctx, plist)) return;

  const receiverId =
    plist.RNAPCastReceiverId ??
    ctx.expo.options?.cast?.receiverApplicationId ??
    DEFAULT_RECEIVER_ID;
  const services = plist.NSBonjourServices ?? [];
  const hasDescription =
    typeof plist.NSLocalNetworkUsageDescription === 'string' &&
    plist.NSLocalNetworkUsageDescription.trim() !== '';
  const missing = [];
  if (!hasDescription) missing.push('NSLocalNetworkUsageDescription');
  if (!services.includes('_googlecast._tcp')) missing.push('_googlecast._tcp');
  if (!services.includes(`_${receiverId}._googlecast._tcp`))
    missing.push(`_${receiverId}._googlecast._tcp`);
  if (missing.length === 0) return;

  findings.push(
    finding(
      'ios-cast-discovery',
      'error',
      `Google Cast is on, but the app cannot find receivers: missing ${missing.join(', ')} (docs/routes-and-casting.md).`,
      view.config
        ? {
            file: 'app.json',
            change:
              'use `["react-native-anything-player", { "cast": true }]` (the plugin adds the local-network keys)',
          }
        : {
            file: iosPath(ctx, view.file),
            change: `add NSLocalNetworkUsageDescription and NSBonjourServices with _googlecast._tcp and _${receiverId}._googlecast._tcp`,
          }
    )
  );
}

function checkCastPod(ctx, findings) {
  if (!ctx.ios.present) return;
  const view = plistView(ctx);
  if (!view || !castEnabled(ctx, view.value)) return;
  if (podCast(ctx)) return;
  findings.push(
    finding(
      'ios-cast-pod',
      'warning',
      'Cast is configured for iOS, but `rnap.cast` is not set in `ios/Podfile.properties.json`: unless the pods were installed with `RNAP_CAST=1`, the Cast button finds no support.',
      {
        file: 'ios/Podfile.properties.json',
        change:
          'set `"rnap.cast": "true"` and run `pod install` (or install with `RNAP_CAST=1 pod install`)',
      }
    )
  );
}

function siriIntended(ctx, plist) {
  const entitlementsSiri = ctx.ios.entitlements.some((entry) =>
    String(entry.text ?? '').includes('com.apple.developer.siri')
  );
  return Boolean(
    /RNAPIntents/.test(ctx.ios.pbxproj ?? '') ||
    plist?.NSSiriUsageDescription ||
    entitlementsSiri ||
    ctx.expo.options?.siri
  );
}

function checkSiri(ctx, view, findings) {
  if (!view) return;
  // Before prebuild the plugin owns every piece; there is nothing to check.
  if (ctx.isExpo && !ctx.ios.present) return;
  const plist = view.value;
  if (!siriIntended(ctx, plist)) return;

  const missing = [];
  if (!/RNAPIntents/.test(ctx.ios.pbxproj ?? ''))
    missing.push('the RNAPIntents extension target');
  if (!plist.NSSiriUsageDescription) missing.push('NSSiriUsageDescription');
  if (!(plist.NSUserActivityTypes ?? []).includes('INPlayMediaIntent'))
    missing.push('INPlayMediaIntent in NSUserActivityTypes');
  if (
    !ctx.ios.entitlements.some((entry) =>
      String(entry.text ?? '').includes('com.apple.developer.siri')
    )
  )
    missing.push('the `com.apple.developer.siri` entitlement');
  if (missing.length === 0) return;

  findings.push(
    finding(
      'ios-siri',
      'error',
      `Siri is configured, but iOS cannot hand "play X on this app" to RNAP: missing ${missing.join(', ')} (docs/voice.md).`,
      {
        file: iosPath(ctx, view.file),
        change:
          "add the Siri capability, `NSSiriUsageDescription`, `NSUserActivityTypes = [INPlayMediaIntent]`, and the RNAPIntents extension target (or use the plugin's `siri: true`)",
      }
    )
  );
}

function directoryExists(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function checkPods(ctx, findings) {
  if (!ctx.ios.present) return;
  const lock = ctx.ios.podfileLock;
  const libraryVersion = ctx.library.version;
  const podsInstalled = directoryExists(`${ctx.cwd}/ios/Pods`);

  if (!ctx.ios.podfile) {
    findings.push(
      finding(
        'ios-pods',
        'warning',
        'No `ios/Podfile`: the iOS app is not set up for CocoaPods.',
        {
          file: 'ios/Podfile',
          change: 'restore the React Native Podfile, then run `pod install`',
        }
      )
    );
    return;
  }
  if (!podsInstalled) {
    findings.push(
      finding(
        'ios-pods',
        'warning',
        'Pods are not installed (`ios/Pods` is missing): the app cannot import AnythingPlayer.',
        {
          file: 'ios/Podfile',
          change: 'run `cd ios && pod install` (docs/getting-started.md)',
        }
      )
    );
  }
  if (!lock) {
    findings.push(
      finding(
        'ios-pods',
        'error',
        '`ios/Podfile.lock` is missing: pods were never installed for this app.',
        {
          file: 'ios/Podfile.lock',
          change: 'run `cd ios && pod install`',
        }
      )
    );
    return;
  }
  const installed = podVersion(lock, 'AnythingPlayer');
  if (!installed) {
    findings.push(
      finding(
        'ios-pods',
        'error',
        '`ios/Podfile.lock` does not list AnythingPlayer: the library is installed in node_modules but not in the Pods project.',
        {
          file: 'ios/Podfile.lock',
          change: 'run `cd ios && pod install`, then rebuild',
        }
      )
    );
    return;
  }
  if (libraryVersion && installed !== libraryVersion) {
    findings.push(
      finding(
        'ios-pod-version',
        'error',
        `AnythingPlayer ${installed} is installed, but the library in node_modules is ${libraryVersion}: the app builds against the old pod.`,
        {
          file: 'ios/Podfile.lock',
          change: 'run `cd ios && pod install` after installing the library',
        }
      )
    );
  }
}

function checkDeploymentTarget(ctx, findings) {
  if (!ctx.ios.present) return;
  const fromPbx = pbxDeploymentTargets(ctx.ios.pbxproj);
  const fromPodfile = podfileDeploymentTarget(ctx.ios.podfile);
  const candidates = [
    ...fromPbx.map((version) => ({
      version,
      file: ctx.ios.pbxprojFile,
    })),
    ...(fromPodfile
      ? [{ version: fromPodfile, file: ctx.ios.podfileFile }]
      : []),
  ];
  const tooOld = candidates.find(
    (candidate) => compareVersions(candidate.version, MIN_IOS) === -1
  );
  if (!tooOld) return;

  findings.push(
    finding(
      'ios-deployment-target',
      'error',
      `iOS deployment target ${tooOld.version} is below ${MIN_IOS}, the minimum RNAP supports (docs/getting-started.md).`,
      {
        file: iosPath(ctx, tooOld.file),
        change: `raise IPHONEOS_DEPLOYMENT_TARGET (and the Podfile platform) to ${MIN_IOS} or newer`,
      }
    )
  );
}

export function iosChecks(ctx) {
  const findings = [];
  if (!ctx.ios.present && !ctx.isExpo) return findings;
  checkInfoPlistPresent(ctx, findings);
  const view = plistView(ctx);
  checkBackgroundAudio(ctx, view, findings);
  checkSceneLifecycle(ctx, view, findings);
  checkCastDiscovery(ctx, view, findings);
  checkCastPod(ctx, findings);
  checkSiri(ctx, view, findings);
  checkPods(ctx, findings);
  checkDeploymentTarget(ctx, findings);
  return findings;
}
