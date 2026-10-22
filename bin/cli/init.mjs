// `init`: the safe subset of the fixes doctor reports, each shown as a unified
// diff and applied one by one (or all with --yes). Everything else stays a
// printed instruction.

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { addPlistArrayItem } from './plist.mjs';
import { setProperty } from './project.mjs';
import { unifiedDiff } from './diff.mjs';
import { relative, readText } from './util.mjs';
import { formatInitHeader } from './report.mjs';
import { LIBRARY } from './project.mjs';
import { runDoctor } from './doctor.mjs';

function within(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * The file `init` may write, or null: inside the project both as written and
 * once every symlink is resolved, and not itself a symlink (writing through
 * one could change a file outside the project).
 */
export function writableTarget(cwd, file) {
  const absolute = path.resolve(cwd, file);
  try {
    const root = fs.realpathSync(path.resolve(cwd));
    if (!within(path.resolve(cwd), absolute)) return null;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return within(root, fs.realpathSync(absolute)) ? absolute : null;
  } catch {
    return null;
  }
}

function withEol(text, template) {
  return template.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

/** Minimal, format-preserving JSON edit (indent and newlines kept). */
function editJson(text, mutate) {
  const value = JSON.parse(text);
  if (mutate(value) === false) return null;
  const indent = /^[{[][^\n]*\r?\n([ \t]+)/.exec(text)?.[1] ?? '  ';
  const body = JSON.stringify(value, null, indent);
  return withEol(body, text) + (text.endsWith('\n') ? '\n' : '');
}

const FIXERS = {
  'ios-background-audio': (ctx, before) =>
    addPlistArrayItem(before, 'UIBackgroundModes', 'audio'),

  'android-new-arch': (ctx, before) => {
    if (/^\s*newArchEnabled\s*=\s*true\s*$/m.test(before)) return null;
    return setProperty(before, 'newArchEnabled', 'true');
  },

  'ios-new-arch': (ctx, before) =>
    editJson(before, (properties) => {
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
    editJson(before, (config) => {
      if (!config.expo || config.expo.newArchEnabled === true) return false;
      config.expo.newArchEnabled = true;
      return true;
    }),

  'expo-plugin': (ctx, before) =>
    editJson(before, (config) => {
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
    try {
      after = FIXERS[finding.autofix](ctx, before);
    } catch {
      continue; // A file the fixer cannot parse stays a manual fix.
    }
    if (after === null || after === before) continue;

    const display = relative(ctx.cwd, file);
    working.set(file, after);
    fixes.push({
      id: finding.autofix,
      finding: finding.id,
      file: display,
      absolute: file,
      cwd: ctx.cwd,
      change: finding.fix.change,
      before,
      after,
      diff: unifiedDiff(display, before, after),
    });
  }
  return fixes;
}

export function applyFix(fix) {
  // Checked again: the tree may have changed while the user read the diff.
  if (writableTarget(fix.cwd, fix.absolute) !== fix.absolute)
    throw new Error(`${fix.file} is no longer a file inside the project`);
  fs.writeFileSync(fix.absolute, fix.after, 'utf8');
}

/**
 * Line-based asker that also answers '' on end of input, so a piped `init`
 * (or CI without --yes) skips the change instead of hanging on a question that
 * can never be answered.
 */
function createAsker(input, output) {
  const rl = createInterface({ input, output, terminal: false });
  const queued = [];
  let waiting = null;
  let closed = false;
  rl.on('line', (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      queued.push(line);
    }
  });
  rl.on('close', () => {
    closed = true;
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve('');
    }
  });
  return {
    ask(question) {
      output.write(question);
      if (queued.length > 0) return Promise.resolve(queued.shift());
      if (closed) return Promise.resolve('');
      return new Promise((resolve) => {
        waiting = resolve;
      });
    },
    close() {
      rl.close();
    },
  };
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

  if (json) {
    const applied = [];
    if (yes) {
      for (const fix of fixes) {
        applyFix(fix);
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
      skipped: fixes
        .filter((fix) => !applied.some((item) => item.id === fix.id))
        .map((fix) => ({ id: fix.id, file: fix.file, change: fix.change })),
      findings: after.findings,
      summary: after.summary,
    };
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return after.summary.errors === 0 ? 0 : 1;
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
        let accept = Boolean(yes);
        if (asker) {
          const answer = await asker.ask('Apply this change? [y/N] ');
          accept = /^y(es)?$/i.test(answer.trim());
        }
        if (!accept) {
          stdout.write('Skipped.\n');
          continue;
        }
        applyFix(fix);
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
  return errors > 0 ? 1 : 0;
}
