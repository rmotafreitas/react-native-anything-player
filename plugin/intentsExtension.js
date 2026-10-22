// The Siri Intents extension target (`RNAPIntents`), added to the app's Xcode
// project by the Expo plugin (`siri: true`). Siri starts a media request in
// an extension; RNAP's extension answers "handle in app" and iOS launches the
// app in the background to play it (see docs/voice.md). The extension's
// sources are copied from ios/IntentsExtension/.

const TARGET = 'RNAPIntents';
const FILES = ['IntentHandler.swift', 'Info.plist'];

function quoted(value) {
  return `"${String(value).replace(/^"|"$/g, '')}"`;
}

/** The app target's build settings (Release, else the first configuration). */
function appBuildSettings(project) {
  const target = project.getFirstTarget().firstTarget;
  const list = project.pbxXCConfigurationList()[target.buildConfigurationList];
  const configs = project.pbxXCBuildConfigurationSection();
  const entries = list.buildConfigurations.map((c) => configs[c.value]);
  const release = entries.find((c) => c.name === 'Release') ?? entries[0];
  return release.buildSettings;
}

/**
 * Adds the extension target to `project` (a node-xcode project, as Expo's
 * `withXcodeProject` gives it). Idempotent: a project that has it is unchanged.
 */
function addIntentsExtension(project, { bundleIdentifier }) {
  // node-xcode stores the names it creates quoted.
  if (
    project.pbxTargetByName(TARGET) ||
    project.pbxTargetByName(quoted(TARGET))
  )
    return project;
  const app = appBuildSettings(project);
  // node-xcode's addTarget assumes these sections exist.
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency ??= {};
  objects.PBXContainerItemProxy ??= {};

  const target = project.addTarget(
    TARGET,
    'app_extension',
    TARGET,
    `${bundleIdentifier}.${TARGET}`
  );
  project.addBuildPhase(
    ['IntentHandler.swift'],
    'PBXSourcesBuildPhase',
    'Sources',
    target.uuid
  );
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  project.addBuildPhase(
    [],
    'PBXFrameworksBuildPhase',
    'Frameworks',
    target.uuid
  );

  const group = project.addPbxGroup(FILES, TARGET, TARGET);
  const groups = objects.PBXGroup;
  const main = Object.keys(groups).find(
    (key) =>
      typeof groups[key] === 'object' &&
      groups[key].name === undefined &&
      groups[key].path === undefined
  );
  project.addToPbxGroup(group.uuid, main);

  const settings = {
    INFOPLIST_FILE: quoted(`${TARGET}/Info.plist`),
    GENERATE_INFOPLIST_FILE: 'NO',
    PRODUCT_BUNDLE_IDENTIFIER: quoted(`${bundleIdentifier}.${TARGET}`),
    SWIFT_VERSION: '5.0',
    TARGETED_DEVICE_FAMILY: quoted('1,2'),
    CODE_SIGN_STYLE: 'Automatic',
    APPLICATION_EXTENSION_API_ONLY: 'YES',
    CLANG_ENABLE_MODULES: 'YES',
  };
  for (const key of [
    'IPHONEOS_DEPLOYMENT_TARGET',
    'MARKETING_VERSION',
    'CURRENT_PROJECT_VERSION',
    'DEVELOPMENT_TEAM',
  ]) {
    if (app[key] != null) settings[key] = app[key];
  }
  const configs = project.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configs)) {
    const config = configs[key];
    if (
      typeof config === 'object' &&
      config.buildSettings?.PRODUCT_NAME === quoted(TARGET)
    )
      Object.assign(config.buildSettings, settings);
  }
  return project;
}

module.exports = { TARGET, FILES, addIntentsExtension };
