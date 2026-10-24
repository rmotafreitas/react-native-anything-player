// Reads a project into a plain data snapshot. No check lives here: this module
// only answers "what is on disk?", so the checks stay easy to read and test.

import path from 'node:path';
import { createRequire } from 'node:module';
import {
  children,
  filesWithExtension,
  isDirectory,
  isFile,
  readJson,
  readText,
} from './util.mjs';
import { isPlistDict, parsePlist } from './plist.mjs';

export const LIBRARY = 'react-native-anything-player';
export const DEFAULT_RECEIVER_ID = 'CC1AD845';

const require = createRequire(import.meta.url);
// The CLI ships inside the library, so the plugin's own option resolution is
// available: reuse it instead of re-implementing the defaults.
let helpers = null;
try {
  helpers = require('../../plugin/helpers.js');
} catch {
  helpers = null;
}

/** Numeric parts of a version string, ignoring ranges and pre-release tags. */
export function versionParts(version) {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version ?? ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

export function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/** The first `name = 24` / `name 24` level a Gradle file sets, among `names`. */
export function sdkLevel(text, ...names) {
  for (const name of names) {
    const match = new RegExp(`${name}\\s*(?:=\\s*)?(\\d+)\\b`).exec(
      String(text ?? '')
    );
    if (match) return Number(match[1]);
  }
  return null;
}

/** `key=value` lines of a gradle.properties file. */
export function parseProperties(text) {
  const values = {};
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && !line.trim().startsWith('#') && !line.trim().startsWith('!'))
      values[match[1]] = match[2];
  }
  return values;
}

/** Sets (or appends) one `key=value` line, returning the new text. */
export function setProperty(text, key, value) {
  const source = text ?? '';
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (pattern.test(source)) return source.replace(pattern, line);
  const separator = source === '' || source.endsWith('\n') ? '' : '\n';
  return `${source}${separator}${line}\n`;
}

/** Version of a pod as recorded in ios/Podfile.lock. */
export function podVersion(lock, pod) {
  const match = new RegExp(`^\\s*-\\s+${pod}\\s+\\(([^)]+)\\)`, 'm').exec(
    String(lock ?? '')
  );
  return match ? match[1] : null;
}

/** iOS deployment targets declared in a project.pbxproj. */
export function pbxDeploymentTargets(text) {
  return [
    ...String(text ?? '').matchAll(
      /IPHONEOS_DEPLOYMENT_TARGET\s*=\s*"?([0-9.]+)"?/g
    ),
  ].map((match) => match[1]);
}

/** `platform :ios, '15.1'` of an iOS Podfile. */
export function podfileDeploymentTarget(text) {
  const match = /platform\s+:ios\s*,\s*['"]([0-9.]+)['"]/.exec(
    String(text ?? '')
  );
  return match ? match[1] : null;
}

function findAppInfoPlist(iosDir) {
  for (const name of children(iosDir)) {
    if (['Pods', 'build', 'node_modules', 'Tests'].includes(name)) continue;
    const dir = path.join(iosDir, name);
    if (!isDirectory(dir)) continue;
    const candidate = path.join(dir, 'Info.plist');
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function findAppEntitlements(iosDir) {
  const files = [];
  for (const name of children(iosDir)) {
    if (['Pods', 'build', 'node_modules', 'Tests'].includes(name)) continue;
    const dir = path.join(iosDir, name);
    if (isDirectory(dir))
      files.push(...filesWithExtension(dir, ['.entitlements']));
  }
  return files;
}

function findPbxproj(iosDir) {
  for (const name of children(iosDir)) {
    const project = path.join(iosDir, name, 'project.pbxproj');
    if (isFile(project)) return project;
  }
  return null;
}

function findMainActivity(androidDir) {
  const root = path.join(androidDir, 'app', 'src', 'main');
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of children(dir)) {
      const file = path.join(dir, name);
      if (isDirectory(file)) {
        if (name !== 'build') stack.push(file);
      } else if (/^MainActivity\.(kt|java)$/.test(name)) {
        return file;
      }
    }
  }
  return null;
}

function readManifest(androidDir) {
  return readText(
    path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml')
  );
}

function readNetworkSecurityConfig(androidDir, manifestText) {
  const match = /android:networkSecurityConfig="@xml\/([^"]+)"/.exec(
    manifestText ?? ''
  );
  if (!match) return null;
  const file = path.join(
    androidDir,
    'app',
    'src',
    'main',
    'res',
    'xml',
    `${match[1]}.xml`
  );
  return isFile(file) ? { file, text: readText(file) } : { file, text: null };
}

function readPlistFile(file) {
  if (!file) return { file: null, value: null, error: null };
  const text = readText(file);
  if (text === null) return { file, value: null, error: 'missing' };
  try {
    const value = parsePlist(text);
    return { file, value: isPlistDict(value) ? value : null, error: null };
  } catch (error) {
    return { file, value: null, error: error.message };
  }
}

/** Expo config plugins declared in app.json. */
function pluginEntries(config) {
  const plugins = Array.isArray(config?.plugins) ? config.plugins : [];
  return plugins.map((entry, index) => {
    if (typeof entry === 'string') return { name: entry, options: {}, index };
    if (Array.isArray(entry))
      return {
        name: entry[0],
        options: entry[1] && typeof entry[1] === 'object' ? entry[1] : {},
        rawOptions: entry[1],
        index,
      };
    return { name: null, options: {}, index };
  });
}

function localPluginSources(cwd, entries) {
  const sources = [];
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || !entry.name.startsWith('.')) continue;
    const base = path.resolve(cwd, entry.name);
    const candidates = [base, `${base}.js`, `${base}.ts`, `${base}.mjs`];
    for (const candidate of candidates) {
      const text = readText(candidate);
      if (text !== null) {
        sources.push({ file: candidate, text });
        break;
      }
    }
  }
  return sources;
}

function findLibrary(cwd) {
  const local = path.join(cwd, 'node_modules', LIBRARY, 'package.json');
  const localPkg = readJson(local);
  if (localPkg)
    return {
      installed: true,
      version: localPkg.version,
      path: path.dirname(local),
    };

  // Workspace/monorepo: the library is an ancestor (example/ -> repo root).
  let dir = cwd;
  for (let depth = 0; depth < 6; depth += 1) {
    const pkg = readJson(path.join(dir, 'package.json'));
    if (pkg?.name === LIBRARY)
      return { installed: false, version: pkg.version, path: dir };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { installed: false, version: null, path: null };
}

/** Applies the RNAP plugin's own defaults, then the project's overrides. */
function effectiveExpoInfoPlist(config, resolved, enabled) {
  const base = config?.ios?.infoPlist ?? {};
  if (!enabled || !helpers?.applyInfoPlist) return { ...base };
  return helpers.applyInfoPlist({ ...base }, resolved);
}

function resolvePluginOptions(raw) {
  if (helpers?.resolveOptions) return helpers.resolveOptions(raw ?? {});
  return {
    backgroundAudio: raw?.backgroundAudio !== false,
    cast: raw?.cast ? raw.cast : null,
    siri: raw?.siri ? raw.siri : null,
    assistant: raw?.assistant !== false,
  };
}

/** Builds the snapshot every check reads. */
export function loadProject(cwd) {
  const packageJsonFile = path.join(cwd, 'package.json');
  const packageJson = readJson(packageJsonFile);
  const dependencies = {
    ...(packageJson?.devDependencies ?? {}),
    ...(packageJson?.dependencies ?? {}),
  };
  const library = findLibrary(cwd);

  const appJsonFile = path.join(cwd, 'app.json');
  const jsConfigFile = [
    'app.config.js',
    'app.config.ts',
    'app.config.mjs',
    'app.config.cjs',
  ]
    .map((name) => path.join(cwd, name))
    .find(isFile);
  const appJson = readJson(appJsonFile);
  const expoConfig = appJson?.expo ?? null;
  const isExpo = Boolean(dependencies.expo || expoConfig || jsConfigFile);

  const expoPlugins = expoConfig ? pluginEntries(expoConfig) : [];
  const rnapPlugin =
    expoPlugins.find((entry) => entry.name === LIBRARY) ?? null;
  const resolved = rnapPlugin
    ? resolvePluginOptions(rnapPlugin.rawOptions ?? rnapPlugin.options)
    : null;

  const iosDir = path.join(cwd, 'ios');
  const hasIos = isDirectory(iosDir);
  const infoPlistFile = hasIos ? findAppInfoPlist(iosDir) : null;
  const infoPlist = hasIos ? readPlistFile(infoPlistFile) : null;
  const podfileFile = path.join(iosDir, 'Podfile');
  const podfileLockFile = path.join(iosDir, 'Podfile.lock');
  const podfilePropertiesFile = path.join(iosDir, 'Podfile.properties.json');
  const podfileProperties = readJson(podfilePropertiesFile);
  const pbxprojFile = hasIos ? findPbxproj(iosDir) : null;
  const entitlements = hasIos
    ? findAppEntitlements(iosDir).map((file) => ({
        file,
        text: readText(file),
      }))
    : [];

  const androidDir = path.join(cwd, 'android');
  const hasAndroid = isDirectory(androidDir);
  const manifestFile = hasAndroid
    ? path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml')
    : null;
  const manifest = hasAndroid ? readManifest(androidDir) : null;
  const mainActivityFile = hasAndroid ? findMainActivity(androidDir) : null;

  const localPlugins = expoConfig ? localPluginSources(cwd, expoPlugins) : [];

  return {
    cwd,
    packageJsonFile,
    packageJson,
    dependencies,
    library,
    isExpo,
    jsConfigFile,
    appJsonFile,
    appJson,
    expoConfig,
    expoPlugins,
    rnapPlugin,
    pluginOptions: resolved,
    ios: {
      present: hasIos,
      infoPlistFile,
      infoPlist: infoPlist?.value ?? null,
      infoPlistError: infoPlist?.error ?? null,
      podfileFile,
      podfile: readText(podfileFile),
      podfileLockFile,
      podfileLock: readText(podfileLockFile),
      podfilePropertiesFile,
      podfileProperties,
      pbxprojFile,
      pbxproj: readText(pbxprojFile),
      entitlements,
    },
    android: {
      present: hasAndroid,
      gradlePropertiesFile: path.join(androidDir, 'gradle.properties'),
      gradlePropertiesText: readText(
        path.join(androidDir, 'gradle.properties')
      ),
      buildGradle: readText(path.join(androidDir, 'build.gradle')),
      appBuildGradle: readText(path.join(androidDir, 'app', 'build.gradle')),
      manifestFile,
      manifest,
      mainActivityFile,
      mainActivity: mainActivityFile ? readText(mainActivityFile) : null,
      networkSecurityConfig: readNetworkSecurityConfig(androidDir, manifest),
    },
    /** Info.plist the checks should read for iOS. */
    iosPolicy: {
      meldedInfoPlist: effectiveExpoInfoPlist(
        expoConfig,
        resolved,
        Boolean(rnapPlugin)
      ),
      localPlugins,
    },
    expo: {
      sdkVersion: dependencies.expo ?? null,
      configFile: appJsonFile,
      config: expoConfig,
      rnapPlugin,
      options: resolved,
      rawOptions: rnapPlugin?.rawOptions ?? rnapPlugin?.options ?? null,
    },
  };
}
