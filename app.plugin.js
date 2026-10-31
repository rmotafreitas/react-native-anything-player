// Expo config plugin: `plugins: ["react-native-anything-player"]` in app.json,
// or with options: `["react-native-anything-player", { "cast": true, "siri": true }]`.
//
// - `backgroundAudio` (default true): iOS's `audio` background mode. Android
//   needs nothing: the library's manifest (media playback foreground service,
//   permissions) is merged automatically.
// - `cast` (true or `{ receiverApplicationId, localNetworkUsageDescription }`):
//   builds Google Cast in (Gradle property `rnapCast`, Podfile property
//   `rnap.cast`) and adds iOS's local network keys. See docs/routes-and-casting.md.
// - `sound` (default false): builds the Sound API in (Gradle property
//   `rnapSound`, Podfile property `rnap.sound`). See docs/sound.md.
// - `video` (true or `{ pictureInPicture }`): builds video players and
//   `<VideoView>` in (Gradle property `rnapVideo`, Podfile property
//   `rnap.video`). Picture in Picture (default on) marks the main activity
//   `supportsPictureInPicture` with the config changes it handles, and keeps
//   iOS's `audio` background mode it needs. See docs/video.md.
// - `videoDecoders` (default false): Android's software decoders, for what
//   the device cannot decode (Gradle property `rnapVideoDecoders`). See
//   docs/video.md#software-decoders.
// - `siri` (true or `{ usageDescription, appIntents }`): the Siri capability,
//   the Intents extension that hands requests to the app, and (unless
//   `appIntents` is false) the App Intents of Siri shortcuts, Spotlight and the
//   Shortcuts app (iOS 16+), compiled by the app target. See docs/voice.md.
// - `car` (true, or `{ ios, android }` to leave one out): CarPlay and Android
//   Auto browsing of the catalog (Gradle property `rnapCar`, Podfile property
//   `rnap.car`), the CarPlay audio entitlement and CarPlay's scene in the
//   Info.plist. CarPlay needs Apple's CarPlay audio entitlement approval. See
//   docs/cars-and-watches.md.
// - `assistant` (default true): Google Assistant and Gemini requests to the
//   main activity (`MEDIA_PLAY_FROM_SEARCH` → `AnythingPlayer.handleIntent`).
const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withFinalizedMod,
  withGradleProperties,
  withInfoPlist,
  withMainActivity,
  withPodfileProperties,
  withXcodeProject,
  IOSConfig,
  WarningAggregator,
} = require('expo/config-plugins');
const pkg = require('./package.json');
const helpers = require('./plugin/helpers');
const extension = require('./plugin/intentsExtension');
const appIntents = require('./plugin/appIntents');

const RECEIVER_META = 'com.anythingplayer.CAST_RECEIVER_ID';

/** Edits the Info.plist on disk (outside the `withInfoPlist` chain). */
function editInfoPlist(projectRoot, edit) {
  let file;
  try {
    file = IOSConfig.Paths.getInfoPlistPath(projectRoot);
  } catch {
    return; // No iOS project yet.
  }
  // The plist library expo/config-plugins itself uses.
  const plist = require(
    require.resolve('@expo/plist', {
      paths: [path.dirname(require.resolve('expo/config-plugins'))],
    })
  );
  const before = plist.default.parse(fs.readFileSync(file, 'utf8'));
  const after = edit(before);
  if (after !== before) fs.writeFileSync(file, plist.default.build(after));
}

/**
 * CarPlay's scene, outside the `withInfoPlist` chain so the plugin order does
 * not matter: removed from a project prebuilt before (dangerous mods run
 * first), added back after every other Info.plist edit (finalized mods last).
 */
function withCarPlayScene(config) {
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      editInfoPlist(cfg.modRequest.projectRoot, (plist) => {
        const manifest = helpers.removeCarPlayScene(plist);
        if (manifest === plist.UIApplicationSceneManifest) return plist;
        const out = { ...plist, UIApplicationSceneManifest: manifest };
        if (manifest === undefined) delete out.UIApplicationSceneManifest;
        return out;
      });
      return cfg;
    },
  ]);
  return withFinalizedMod(config, [
    'ios',
    (cfg) => {
      editInfoPlist(cfg.modRequest.projectRoot, (plist) => {
        if (!helpers.hasWindowScene(plist))
          WarningAggregator.addWarningIOS(
            'react-native-anything-player',
            "car: the Info.plist has no UIWindowSceneSessionRoleApplication scene, so CarPlay's scene would leave the phone without a window. Adopt the scene life cycle first (docs/cars-and-watches.md)."
          );
        return {
          ...plist,
          UIApplicationSceneManifest: helpers.addCarPlayScene(plist),
        };
      });
      return cfg;
    },
  ]);
}

function withIos(config, resolved) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults = helpers.applyInfoPlist(cfg.modResults, resolved);
    return cfg;
  });
  config = withPodfileProperties(config, (cfg) => {
    cfg.modResults = helpers.applyPodfileProperties(cfg.modResults, resolved);
    return cfg;
  });
  if (resolved.car?.ios) config = withCarPlayScene(config);
  if (!resolved.siri && !resolved.car?.ios) return config;
  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults = helpers.applyEntitlements(cfg.modResults, resolved);
    return cfg;
  });
  if (!resolved.siri) return config;
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const from = path.join(__dirname, 'ios', 'IntentsExtension');
      const to = path.join(
        cfg.modRequest.platformProjectRoot,
        extension.TARGET
      );
      fs.mkdirSync(to, { recursive: true });
      for (const file of extension.FILES)
        fs.copyFileSync(path.join(from, file), path.join(to, file));
      if (resolved.siri.appIntents)
        fs.copyFileSync(
          path.join(__dirname, 'ios', 'AppIntents', appIntents.FILE),
          path.join(
            cfg.modRequest.platformProjectRoot,
            cfg.modRequest.projectName,
            appIntents.FILE
          )
        );
      return cfg;
    },
  ]);
  config = withXcodeProject(config, (cfg) => {
    const bundleIdentifier = cfg.ios?.bundleIdentifier;
    if (!bundleIdentifier)
      throw new Error(
        'react-native-anything-player: `siri` needs `ios.bundleIdentifier` in app.json.'
      );
    extension.addIntentsExtension(cfg.modResults, { bundleIdentifier });
    if (resolved.siri.appIntents)
      appIntents.addAppIntentsSource(cfg.modResults, {
        projectName: cfg.modRequest.projectName,
      });
    return cfg;
  });
  // EAS Build signs the extension too.
  const eas = (config.extra ??= {}).eas ?? {};
  const ios = ((eas.build ??= {}).experimental ??= {}).ios ?? {};
  const extensions = ios.appExtensions ?? [];
  if (!extensions.some((e) => e.targetName === extension.TARGET)) {
    extensions.push({
      targetName: extension.TARGET,
      bundleIdentifier: `${config.ios?.bundleIdentifier}.${extension.TARGET}`,
      entitlements: {},
    });
  }
  eas.build.experimental.ios = { ...ios, appExtensions: extensions };
  config.extra.eas = eas;
  return config;
}

function withAndroid(config, resolved) {
  config = withGradleProperties(config, (cfg) => {
    cfg.modResults = helpers.applyGradleProperties(cfg.modResults, resolved);
    return cfg;
  });
  config = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const application =
      AndroidConfig.Manifest.getMainApplicationOrThrow(manifest);
    if (resolved.cast?.customReceiver) {
      AndroidConfig.Manifest.addMetaDataItemToMainApplication(
        application,
        RECEIVER_META,
        resolved.cast.receiverApplicationId
      );
    } else {
      AndroidConfig.Manifest.removeMetaDataItemFromMainApplication(
        application,
        RECEIVER_META
      );
    }
    if (resolved.assistant) {
      const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
      Object.assign(activity, helpers.addPlayFromSearchFilter(activity));
    }
    if (resolved.video?.pictureInPicture) {
      const activity = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
      Object.assign(activity, helpers.applyPictureInPicture(activity));
    }
    return cfg;
  });
  if (!resolved.assistant) return config;
  return withMainActivity(config, (cfg) => {
    if (cfg.modResults.language !== 'kt')
      throw new Error(
        'react-native-anything-player: MainActivity is not Kotlin; add AnythingPlayer.handleIntent by hand (docs/voice.md), or set "assistant": false.'
      );
    cfg.modResults.contents = helpers.injectHandleIntent(
      cfg.modResults.contents
    );
    return cfg;
  });
}

/** @param {object} [options] see the header */
function withAnythingPlayer(config, options = {}) {
  const resolved = helpers.resolveOptions(options);
  return withAndroid(withIos(config, resolved), resolved);
}

module.exports = createRunOncePlugin(withAnythingPlayer, pkg.name, pkg.version);
