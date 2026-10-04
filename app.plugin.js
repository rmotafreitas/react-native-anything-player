// Expo config plugin: `plugins: ["react-native-airwave"]` in app.json.
//
// iOS: background audio needs the `audio` UIBackgroundMode.
// Android: nothing to do — the library's manifest (media playback foreground
// service, permissions) is merged automatically.
const { withInfoPlist, createRunOncePlugin } = require('expo/config-plugins');
const pkg = require('./package.json');

/** @param {{ backgroundAudio?: boolean }} [options] */
function withAirwave(config, options = {}) {
  const backgroundAudio = options.backgroundAudio !== false;
  return withInfoPlist(config, (cfg) => {
    const modes = new Set(cfg.modResults.UIBackgroundModes ?? []);
    if (backgroundAudio) modes.add('audio');
    else modes.delete('audio');
    cfg.modResults.UIBackgroundModes = [...modes];
    return cfg;
  });
}

module.exports = createRunOncePlugin(withAirwave, pkg.name, pkg.version);
