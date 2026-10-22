// Siri shortcuts (App Intents, iOS 16+), added by the Expo plugin (`siri:
// true`, unless `siri.appIntents` is false). iOS reads App Intents from the
// app target's own code, so ios/AppIntents/RNAPAppIntents.swift is copied into
// the app's source folder and compiled by the APP target (see docs/voice.md).
//
// Works on the parsed project (`project.hash`, as node-xcode and Expo's
// `withXcodeProject` give it) directly, so the tooling tests need no `xcode`
// package. node-xcode keeps string values as written in the file: quoted when
// they need quotes (`"<group>"`), hence `unquote` on every comparison.

const FILE = 'RNAPAppIntents.swift';
const APPLICATION = 'com.apple.product-type.application';

function unquote(value) {
  return typeof value === 'string' ? value.replace(/^"(.*)"$/, '$1') : value;
}

/** Quotes what a pbxproj needs quoted (as Xcode writes it). */
function quote(value) {
  return /^[\w./]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

function entries(section = {}) {
  return Object.entries(section).filter(
    ([key, value]) => !key.endsWith('_comment') && typeof value === 'object'
  );
}

/** The app target: the first application target. */
function appTarget(objects) {
  const found = entries(objects.PBXNativeTarget).find(
    ([, target]) => unquote(target.productType) === APPLICATION
  );
  if (!found)
    throw new Error(
      'react-native-anything-player: the Xcode project has no app target.'
    );
  return found[1];
}

/** The app's source folder group (`name` or `path` is the project's name). */
function appGroup(objects, projectName) {
  const found = entries(objects.PBXGroup).find(
    ([, group]) =>
      unquote(group.path) === projectName ||
      (group.path === undefined && unquote(group.name) === projectName)
  );
  if (!found)
    throw new Error(
      `react-native-anything-player: no "${projectName}" group in the Xcode project; add ${FILE} to the app target by hand (docs/voice.md).`
    );
  return found;
}

/**
 * Adds `<projectName>/RNAPAppIntents.swift` to the app target's Sources.
 * Idempotent: a group that has the file is left unchanged.
 * @param {object} project node-xcode project (`hash`, `generateUuid()`)
 * @param {{ projectName: string }} options
 */
function addAppIntentsSource(project, { projectName }) {
  const objects = project.hash.project.objects;
  const target = appTarget(objects);
  const [, group] = appGroup(objects, projectName);
  const refs = objects.PBXFileReference ?? {};
  const present = (group.children ?? []).some((child) => {
    const ref = refs[child.value];
    return ref && unquote(ref.path).split('/').pop() === FILE;
  });
  if (present) return project;

  const phaseId = (target.buildPhases ?? [])
    .map((phase) => phase.value)
    .find((id) => objects.PBXSourcesBuildPhase?.[id]);
  if (!phaseId)
    throw new Error(
      'react-native-anything-player: the app target has no Sources build phase.'
    );

  const fileRef = project.generateUuid();
  const buildFile = project.generateUuid();
  // A group with a `path` is a folder; one with only a `name` lives at its
  // parent's path (Expo's template), so the file's path names the folder.
  const filePath = group.path === undefined ? `${projectName}/${FILE}` : FILE;
  objects.PBXFileReference ??= {};
  objects.PBXFileReference[fileRef] = {
    isa: 'PBXFileReference',
    lastKnownFileType: 'sourcecode.swift',
    name: FILE,
    path: quote(filePath),
    sourceTree: '"<group>"',
  };
  objects.PBXFileReference[`${fileRef}_comment`] = FILE;
  objects.PBXBuildFile ??= {};
  objects.PBXBuildFile[buildFile] = {
    isa: 'PBXBuildFile',
    fileRef,
    fileRef_comment: FILE,
  };
  objects.PBXBuildFile[`${buildFile}_comment`] = `${FILE} in Sources`;
  (group.children ??= []).push({ value: fileRef, comment: FILE });
  const phase = objects.PBXSourcesBuildPhase[phaseId];
  (phase.files ??= []).push({
    value: buildFile,
    comment: `${FILE} in Sources`,
  });
  return project;
}

module.exports = { FILE, addAppIntentsSource };
