// iOS 27 traps at launch unless the app adopts the scene life cycle. Expo SDK
// 57 ships `ExpoAppSceneDelegate`, but its prebuild template still creates the
// window in the app delegate; this applies the SDK 58 template's pattern.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

const WINDOW_BLOCK =
  /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n[\s\S]*?#endif\n/;

module.exports = function withSceneLifecycle(config) {
  config = withAppDelegate(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes('ExpoAppSceneDelegate')) return cfg;
    if (cfg.modResults.language !== 'swift' || !WINDOW_BLOCK.test(src)) {
      throw new Error('withSceneLifecycle: unexpected AppDelegate template');
    }
    src = src.replace(
      'class AppDelegate: ExpoAppDelegate {',
      'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {'
    );
    src = src.replace(
      WINDOW_BLOCK,
      '\n    // The window is created by `SceneDelegate` (scene life cycle).\n'
    );
    src += `
@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {}
`;
    cfg.modResults.contents = src;
    return cfg;
  });
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };
    return cfg;
  });
};
