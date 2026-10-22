// Autolinking (React Native CLI and Expo). The Codegen also emits C++ for
// RNAPRoutePickerView, iOS's AirPlay button, and React Native compiles it into
// every Android app even though the component is excluded there (its C++
// generators ignore `excludedPlatforms`). Android registers no component and
// compiles only the TurboModule's glue (android/src/main/jni/CMakeLists.txt).
module.exports = {
  dependency: {
    platforms: {
      android: {
        componentDescriptors: [],
        cmakeListsPath: 'src/main/jni/CMakeLists.txt',
      },
    },
  },
};
