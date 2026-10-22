// `rnap info`: one paste-able report for a bug report. Versions, platforms,
// the build modules that are on, the tools on the machine and what doctor sees.
// Paths are printed with the home directory as `~`; no environment is dumped,
// so nothing secret can end up in the report.

import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject, parseProperties, versionParts } from './project.mjs';
import { moduleStates } from './modules.mjs';
import { runDoctor } from './doctor.mjs';
import { formatInfo } from './report.mjs';
import { readText, relative } from './util.mjs';
import { projectKindName } from './module-command.mjs';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Prints a path with the home directory replaced by `~`. */
export function tilde(target) {
  if (!target) return null;
  const home = os.homedir();
  if (!home) return target;
  if (target === home) return '~';
  if (target.startsWith(`${home}${path.sep}`))
    return `~${target.slice(home.length).split(path.sep).join('/')}`;
  return target.split(path.sep).join('/');
}

function sdkLevel(text, ...names) {
  for (const name of names) {
    const match = new RegExp(`${name}\\s*(?:=\\s*)?(\\d+)\\b`).exec(
      String(text ?? '')
    );
    if (match) return Number(match[1]);
  }
  return null;
}

function media3Version(ctx) {
  const pinned = /rnapMedia3Version\s*[=:]\s*['"]([^'"]+)['"]/.exec(
    String(ctx.android.buildGradle ?? '')
  );
  if (pinned) return pinned[1];
  const libraryGradle = readText(
    path.join(PACKAGE_ROOT, 'android/build.gradle')
  );
  const parts = /media3Version:\s*"([^"]+)"/.exec(String(libraryGradle ?? ''));
  return parts ? parts[1] : null;
}

function newArchitecture(ctx) {
  if (ctx.isExpo && ctx.expo.config?.newArchEnabled === false) return false;
  if (ctx.isExpo && ctx.expo.config?.newArchEnabled === true) return true;
  const ios = ctx.ios.podfileProperties;
  const iosValues = [ios?.newArchEnabled, ios?.RCT_NEW_ARCH_ENABLED];
  if (iosValues.some((value) => value === false || value === 'false'))
    return false;
  const gradle = parseProperties(ctx.android.gradlePropertiesText);
  if (gradle.newArchEnabled === 'false') return false;
  if (
    iosValues.some((value) => value === true || value === 'true') ||
    gradle.newArchEnabled === 'true'
  )
    return true;
  return null;
}

function toolVersion(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const text = (result.stdout ?? '').trim();
  return result.status === 0 && text !== '' ? text : null;
}

function iosInfo(ctx) {
  if (!ctx.ios.present) return null;
  const targets = [
    ...String(ctx.ios.pbxproj ?? '').matchAll(
      /IPHONEOS_DEPLOYMENT_TARGET\s*=\s*"?([0-9.]+)"?/g
    ),
  ].map((match) => match[1]);
  const podfile = /platform\s+:ios\s*,\s*['"]([0-9.]+)['"]/.exec(
    String(ctx.ios.podfile ?? '')
  )?.[1];
  return { deploymentTarget: targets[0] ?? podfile ?? null };
}

function androidInfo(ctx) {
  if (!ctx.android.present) return null;
  return {
    minSdk: sdkLevel(ctx.android.buildGradle, 'minSdkVersion'),
    compileSdk: sdkLevel(
      ctx.android.buildGradle,
      'compileSdkVersion',
      'compileSdk'
    ),
    targetSdk: sdkLevel(
      ctx.android.appBuildGradle,
      'targetSdkVersion',
      'targetSdk'
    ),
  };
}

export async function runInfo({
  cwd,
  json,
  version,
  paint,
  stdout = process.stdout,
}) {
  const ctx = loadProject(cwd);
  const { report: doctor } = await runDoctor({ cwd, skipUrlChecks: true });
  const states = moduleStates(ctx);
  const expo = ctx.isExpo
    ? {
        sdk: versionParts(ctx.expo.sdkVersion)?.[0] ?? null,
        configFile: ctx.jsConfigFile
          ? relative(ctx.cwd, ctx.jsConfigFile)
          : ctx.appJsonFile
            ? relative(ctx.cwd, ctx.appJsonFile)
            : null,
      }
    : null;

  const report = {
    schemaVersion: 1,
    command: 'info',
    cli: { version },
    cwd: tilde(ctx.cwd),
    collectedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    environment: {
      os: `${os.type()} ${os.release()} (${os.arch()})`,
      node: process.version,
      npm: toolVersion('npm', ['--version']),
      yarn: toolVersion('yarn', ['--version']),
    },
    project: {
      kind: projectKindName(ctx),
      reactNative: ctx.dependencies['react-native'] ?? null,
      library: ctx.library.version
        ? {
            version: ctx.library.version,
            installed: ctx.library.installed,
            path: tilde(ctx.library.path),
          }
        : null,
      expo,
      media3Version: media3Version(ctx),
      newArchitecture: newArchitecture(ctx),
      ios: iosInfo(ctx),
      android: androidInfo(ctx),
      modules: {
        on: states.filter((state) => state.effective).map((state) => state.id),
        off: states
          .filter((state) => !state.effective)
          .map((state) => state.id),
      },
    },
    doctor: {
      ok: doctor.ok,
      summary: doctor.summary,
      findings: doctor.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        message: finding.message,
      })),
    },
  };

  stdout.write(
    json
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatInfo(report, { paint })
  );
  return 0;
}
