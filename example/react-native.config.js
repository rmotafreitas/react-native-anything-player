const path = require('path');
const pkg = require('../package.json');
const library = require('../react-native.config.js');

module.exports = {
  project: {
    ios: {
      automaticPodsInstallation: true,
    },
  },
  dependencies: {
    [pkg.name]: {
      root: path.join(__dirname, '..'),
      platforms: {
        // Codegen script incorrectly fails without this
        // So we explicitly specify the platforms (Android: the library's own
        // settings, which this entry replaces as written, so with an absolute
        // path)
        ios: {},
        android: {
          ...library.dependency.platforms.android,
          cmakeListsPath: path.join(
            __dirname,
            '../android',
            library.dependency.platforms.android.cmakeListsPath
          ),
        },
      },
    },
  },
};
