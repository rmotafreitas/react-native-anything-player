// Runs every check and shapes the report both `doctor` and `init` use.

import { loadProject, versionParts } from './project.mjs';
import { projectChecks } from './checks/project.mjs';
import { iosChecks } from './checks/ios.mjs';
import { androidChecks } from './checks/android.mjs';
import { collectUrls, urlChecks } from './checks/url.mjs';
import { sortFindings, summarize } from './findings.mjs';
import { relative } from './util.mjs';

function projectSummary(ctx) {
  const expoVersion = ctx.expo.sdkVersion;
  const sdk = expoVersion ? versionParts(expoVersion)?.[0] : null;
  return {
    kind: ctx.isExpo ? 'expo' : 'bare',
    reactNative: ctx.dependencies['react-native'] ?? null,
    library: ctx.library.version
      ? {
          version: ctx.library.version,
          installed: ctx.library.installed,
          path: relative(ctx.cwd, ctx.library.path),
        }
      : null,
    expo: ctx.isExpo
      ? {
          sdk: sdk ?? null,
          configFile: relative(ctx.cwd, ctx.jsConfigFile ?? ctx.appJsonFile),
        }
      : null,
    platforms: { ios: ctx.ios.present, android: ctx.android.present },
  };
}

/**
 * @param {object} options
 * @param {string} options.cwd absolute project directory
 * @param {string[]} [options.urls] extra stream URLs
 * @param {boolean} [options.skipUrlChecks] `init` never touches the network
 */
export async function runDoctor({
  cwd,
  urls = [],
  skipUrlChecks = false,
  probeOptions,
}) {
  const ctx = loadProject(cwd);
  const findings = [
    ...projectChecks(ctx),
    ...iosChecks(ctx),
    ...androidChecks(ctx),
  ];

  let results = [];
  if (!skipUrlChecks) {
    const targets = collectUrls(ctx, urls);
    if (targets.length > 0) {
      const checked = await urlChecks(ctx, targets, probeOptions);
      findings.push(...checked.findings);
      results = checked.results;
    }
  }

  const sorted = sortFindings(findings);
  const summary = summarize(sorted);
  return {
    ctx,
    report: {
      schemaVersion: 1,
      command: 'doctor',
      cwd,
      ok: summary.errors === 0,
      project: projectSummary(ctx),
      findings: sorted,
      urls: results,
      summary,
    },
  };
}
