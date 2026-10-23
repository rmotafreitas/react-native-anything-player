// `init`: the safe subset of the fixes doctor reports, each shown as a unified
// diff and applied one by one (or all with --yes). Everything else stays a
// printed instruction.

import { addPlistArrayItem } from './plist.mjs';
import { setProperty } from './project.mjs';
import {
  applyChange,
  buildChange,
  createAsker,
  editJsonDetailed,
  editResult,
  writableTarget,
} from './edits.mjs';
import { relative, readText } from './util.mjs';
import { formatInitHeader } from './report.mjs';
import { LIBRARY } from './project.mjs';
import { runDoctor } from './doctor.mjs';

const FIXERS = {
  'ios-background-audio': (ctx, before) =>
    addPlistArrayItem(before, 'UIBackgroundModes', 'audio'),

  'android-new-arch': (ctx, before) => {
    if (/^\s*newArchEnabled\s*=\s*true\s*$/m.test(before)) return null;
    return setProperty(before, 'newArchEnabled', 'true');
  },

  'ios-new-arch': (ctx, before) =>
    editJsonDetailed(before, (properties) => {
      let changed = false;
      if (properties.newArchEnabled !== 'true') {
        properties.newArchEnabled = 'true';
        changed = true;
      }
      if (
        Object.hasOwn(properties, 'RCT_NEW_ARCH_ENABLED') &&
        properties.RCT_NEW_ARCH_ENABLED !== 'true'
      ) {
        properties.RCT_NEW_ARCH_ENABLED = 'true';
        changed = true;
      }
      return changed;
    }),

  'expo-new-arch': (ctx, before) =>
    editJsonDetailed(before, (config) => {
      if (!config.expo || config.expo.newArchEnabled === true) return false;
      config.expo.newArchEnabled = true;
      return true;
    }),

  'expo-plugin': (ctx, before) =>
    editJsonDetailed(before, (config) => {
      const expo = config.expo;
      if (!expo) return false;
      const plugins = Array.isArray(expo.plugins) ? expo.plugins : [];
      const listed = plugins.some((entry) =>
        Array.isArray(entry) ? entry[0] === LIBRARY : entry === LIBRARY
      );
      if (listed) return false;
      plugins.push(LIBRARY);
      expo.plugins = plugins;
      return true;
    }),
};

/**
 * Turns findings that carry an `autofix` into concrete file edits. Edits to the
 * same file are chained, so two app.json fixes produce two diffs in order.
 */
export function computeFixes(ctx, findings) {
  const working = new Map();
  const last = new Map();
  const fixes = [];
  for (const finding of findings) {
    if (!finding.autofix) continue;
    if (!FIXERS[finding.autofix] || !finding.fix?.file) continue;
    // app.json is not the source of truth when a JavaScript config exists.
    if (ctx.jsConfigFile && finding.autofix.startsWith('expo-')) continue;
    const file = writableTarget(ctx.cwd, finding.fix.file);
    if (!file) continue;

    const before = working.get(file) ?? readText(file);
    if (before === null) continue;

    let after;
    let note;
    try {
      ({ after, note } = editResult(FIXERS[finding.autofix](ctx, before)));
    } catch {
      continue; // A file the fixer cannot parse stays a manual fix.
    }
    if (after === null || after === before) continue;

    const display = relative(ctx.cwd, file);
    const previous = last.get(file) ?? null;
    working.set(file, after);
    const fix = {
      ...buildChange({
        cwd: ctx.cwd,
        file: display,
        before,
        after,
        change: note ? `${finding.fix.change} (${note})` : finding.fix.change,
        id: finding.autofix,
      }),
      finding: finding.id,
      // The text this fix starts from is the previous fix's result, so it can
      // only be written on top of it.
      requires: previous,
    };
    last.set(file, fix);
    fixes.push(fix);
  }
  return fixes;
}

export function applyFix(fix) {
  applyChange(fix);
}

function printFinding(finding, paint) {
  const lines = [];
  const color =
    finding.severity === 'error'
      ? 'red'
      : finding.severity === 'warning'
        ? 'yellow'
        : 'blue';
  lines.push(`${paint(finding.severity, color)} ${paint(finding.id, 'bold')}`);
  lines.push(`  ${finding.message}`);
  if (finding.fix)
    lines.push(
      paint(`  fix  ${finding.fix.file} — ${finding.fix.change}`, 'gray')
    );
  return lines.join('\n');
}

/**
 * @param {object} options
 * @param {boolean} options.yes apply everything without asking
 * @param {boolean} options.json machine-readable output; without `yes`, a dry run
 */
export async function runInit({
  cwd,
  json,
  yes,
  version,
  paint,
  stdout = process.stdout,
  stdin = process.stdin,
}) {
  const initial = await runDoctor({ cwd, skipUrlChecks: true });
  const fixes = computeFixes(initial.ctx, initial.report.findings);

  const done = new Set();
  const failed = [];

  if (json) {
    const applied = [];
    if (yes) {
      for (const fix of fixes) {
        if (fix.requires && !done.has(fix.requires)) continue;
        try {
          applyFix(fix);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          failed.push({ id: fix.id, file: fix.file, error: error.message });
          continue;
        }
        done.add(fix);
        applied.push({ id: fix.id, file: fix.file, change: fix.change });
      }
    }
    const after = yes
      ? (await runDoctor({ cwd, skipUrlChecks: true })).report
      : initial.report;
    const report = {
      schemaVersion: 1,
      command: 'init',
      cwd,
      dryRun: !yes,
      ok: after.summary.errors === 0,
      applied,
      failed,
      skipped: fixes
        .filter(
          (fix) =>
            !applied.some((item) => item.id === fix.id) &&
            !failed.some((item) => item.id === fix.id)
        )
        .map((fix) => ({ id: fix.id, file: fix.file, change: fix.change })),
      findings: after.findings,
      summary: after.summary,
    };
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return after.summary.errors === 0 && failed.length === 0 ? 0 : 1;
  }

  stdout.write(formatInitHeader(cwd, version, paint));
  const applied = [];

  if (fixes.length === 0) {
    stdout.write('\nNo automatic fixes for this project.\n');
  } else {
    const asker = yes ? null : createAsker(stdin, stdout);
    try {
      for (const [index, fix] of fixes.entries()) {
        stdout.write(
          `\n${index + 1}/${fixes.length}  ${paint(fix.finding, 'bold')}  ${fix.file}\n`
        );
        stdout.write(`${paint(fix.change, 'gray')}\n\n${fix.diff}\n`);
        if (fix.requires && !done.has(fix.requires)) {
          stdout.write(
            'Skipped: it builds on the previous change to this file.\n'
          );
          continue;
        }
        let accept = Boolean(yes);
        if (asker) {
          const answer = await asker.ask('Apply this change? [y/N] ');
          accept = /^y(es)?$/i.test(answer.trim());
        }
        if (!accept) {
          stdout.write('Skipped.\n');
          continue;
        }
        try {
          applyFix(fix);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          failed.push({ id: fix.id, file: fix.file, error: error.message });
          stdout.write(`${paint(`Not applied: ${error.message}`, 'red')}\n`);
          continue;
        }
        done.add(fix);
        applied.push(fix);
        stdout.write('Applied.\n');
      }
    } finally {
      asker?.close();
    }
  }

  const after = (await runDoctor({ cwd, skipUrlChecks: true })).report;
  const remaining = after.findings.filter((item) => item.severity !== 'info');

  stdout.write(
    `\n${applied.length} change${applied.length === 1 ? '' : 's'} applied.\n`
  );
  if (remaining.length > 0) {
    stdout.write('\nStill to fix:\n\n');
    for (const finding of remaining) {
      stdout.write(`${printFinding(finding, paint)}\n\n`);
    }
  }
  const { errors, warnings } = after.summary;
  stdout.write(
    errors > 0
      ? `${errors} error${errors === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'} remain.\n`
      : `No errors remain${warnings > 0 ? ` (${warnings} warning${warnings === 1 ? '' : 's'})` : ''}.\n`
  );
  return errors > 0 || failed.length > 0 ? 1 : 0;
}
