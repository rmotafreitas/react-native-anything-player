// `rnap modules`, `rnap add` and `rnap remove`: the module registry as
// commands. The registry (modules.mjs) decides what a module switches and
// where; this file asks, shows and writes.

import path from 'node:path';
import readline from 'node:readline';
import { loadProject } from './project.mjs';
import { MODULES, moduleStates, planModuleChanges } from './modules.mjs';
import { buildChange, reviewChanges } from './edits.mjs';
import { loadSizeData } from './size-data.mjs';
import { moduleCostText } from './size.mjs';
import { readText, relative, missingProject } from './util.mjs';
import {
  formatModuleChanges,
  formatModules,
  formatToggleHeader,
} from './report.mjs';

/** `expo`, `bare`, or `both` (Expo with native projects on disk). */
export function projectKindName(ctx) {
  const expo = Boolean(ctx.isExpo);
  const native = ctx.android.present || ctx.ios.present;
  if (expo && native) return 'both';
  return expo ? 'expo' : 'bare';
}

function projectLine(ctx) {
  const parts = [labelFor(ctx)];
  const native = [];
  if (ctx.android.present) native.push('android');
  if (ctx.ios.present) native.push('ios');
  if (native.length > 0) parts.push(native.join(' and '));
  return parts.join(', ');
}

function labelFor(ctx) {
  switch (projectKindName(ctx)) {
    case 'expo':
      return 'Expo';
    case 'both':
      return 'Expo with native projects';
    default:
      return 'bare React Native';
  }
}

function statesWithSize(ctx) {
  const data = loadSizeData();
  return moduleStates(ctx).map((state) => ({
    ...state,
    cost: data?.android?.modules?.[state.id] ?? null,
    costText: moduleCostText(state, data),
  }));
}

export function modulesReport(ctx) {
  const states = statesWithSize(ctx);
  return {
    schemaVersion: 1,
    command: 'modules',
    cwd: ctx.cwd,
    project: {
      kind: projectKindName(ctx),
      ios: ctx.ios.present,
      android: ctx.android.present,
    },
    modules: states.map((state) => ({
      id: state.id,
      label: state.label,
      description: state.description,
      defaultOn: state.defaultOn,
      platforms: state.platforms,
      effective: state.effective,
      source: state.source,
      expo: state.expo,
      android: state.android,
      ios: state.ios,
      docs: state.docs,
      size: state.cost,
      sizeNote: state.cost ? null : state.costText,
    })),
    summary: {
      on: states.filter((state) => state.effective).length,
      total: states.length,
    },
  };
}

export function runModules({ cwd, json, version, paint, stdout = process.stdout }) {
  const ctx = loadProject(cwd);
  if (!ctx.packageJson) {
    const missing = missingProject('modules', cwd, json);
    stdout.write(missing.text);
    return missing.status;
  }
  const report = modulesReport(ctx);
  if (json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  stdout.write(
    formatModules(report, { version, paint, project: projectLine(ctx) })
  );
  return 0;
}

/* ------------------------------------------------------------------ picker */

export function pickerState(states) {
  return { cursor: 0, selected: new Set(), done: false, aborted: false };
}

/** One keypress. Returns the next picker state; `done`/`aborted` end it. */
export function applyPickerKey(state, key, states) {
  const next = { ...state, selected: new Set(state.selected) };
  if (key === 'up') {
    next.cursor = (state.cursor - 1 + states.length) % states.length;
    return next;
  }
  if (key === 'down') {
    next.cursor = (state.cursor + 1) % states.length;
    return next;
  }
  if (key === 'space') {
    const id = states[state.cursor].id;
    if (next.selected.has(id)) next.selected.delete(id);
    else next.selected.add(id);
    return next;
  }
  if (key === 'enter') {
    next.done = true;
    return next;
  }
  if (key === 'abort') {
    next.aborted = true;
    return next;
  }
  return next;
}

/** The picker as text: one line per module, the cursor first. */
export function renderPicker(states, state, paint = (text) => text) {
  const lines = [
    paint(
      'Space toggles, Enter applies, q quits. Only the checked modules are turned on.',
      'gray'
    ),
    '',
  ];
  for (const [index, item] of states.entries()) {
    const cursor = index === state.cursor ? '>' : ' ';
    const box = state.selected.has(item.id) ? 'x' : ' ';
    const line = `${cursor} [${box}] ${item.id.padEnd(17)}${item.costText}`;
    lines.push(
      index === state.cursor ? paint(line, 'bold') : line,
      `      ${paint(item.description, 'gray')}`
    );
  }
  return `${lines.join('\n')}\n`;
}

function keyName(str, key) {
  const name = key?.name;
  if (name === 'up' || name === 'k') return 'up';
  if (name === 'down' || name === 'j') return 'down';
  if (str === ' ') return 'space';
  if (name === 'return' || name === 'enter') return 'enter';
  if (name === 'escape' || name === 'q' || (key?.ctrl && name === 'c'))
    return 'abort';
  return null;
}

/** Interactive checkboxes. Returns the chosen modules, or null when aborted. */
export async function pickModules(states, { stdin, stdout, paint }) {
  if (!stdin.isTTY || !stdout.isTTY) return null;
  readline.emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  if (stdin.setRawMode) stdin.setRawMode(true);
  stdin.resume();

  let state = pickerState(states);
  let drawn = 0;
  const draw = () => {
    const text = renderPicker(states, state, paint);
    const lines = text.split('\n').length - 1;
    if (drawn > 0) stdout.write(`\u001b[${drawn}A\u001b[0J`);
    stdout.write(text);
    drawn = lines;
  };

  try {
    return await new Promise((resolve) => {
      const onKey = (str, key) => {
        const name = keyName(str, key);
        if (name) state = applyPickerKey(state, name, states);
        if (state.done || state.aborted) {
          stdin.removeListener('keypress', onKey);
          resolve(
            state.aborted
              ? null
              : states
                  .filter((item) => state.selected.has(item.id))
                  .map((item) => item.id)
          );
          return;
        }
        draw();
      };
      draw();
      stdin.on('keypress', onKey);
    });
  } finally {
    if (stdin.setRawMode) stdin.setRawMode(Boolean(wasRaw));
    stdin.pause();
  }
}

/* ------------------------------------------------------------- add & remove */

function nextSteps(changes) {
  const steps = [];
  const files = changes.map((change) => change.file);
  if (files.includes('app.json'))
    steps.push(
      'npx expo prebuild  (writes the native projects from app.json)'
    );
  if (
    files.some(
      (file) =>
        file.endsWith('Podfile.properties.json') || file.endsWith('Info.plist')
    )
  )
    steps.push('cd ios && pod install');
  if (files.length > 0)
    steps.push('rebuild the app (npx expo run:ios / run:android, or your own build)');
  return steps;
}

/**
 * @param {'add'|'remove'} action
 */
export async function runToggle({
  action,
  names,
  cwd,
  json,
  yes,
  dryRun,
  version,
  paint,
  stdout = process.stdout,
  stdin = process.stdin,
}) {
  const ctx = loadProject(cwd);
  if (!ctx.packageJson) {
    const missing = missingProject(action, cwd, json);
    stdout.write(missing.text);
    return missing.status;
  }

  const states = statesWithSize(ctx);
  const byId = new Map(states.map((state) => [state.id, state]));
  let requested = names;
  let picked = false;
  if (requested.length === 0) {
    if (!stdin.isTTY || !stdout.isTTY) {
      stdout.write(
        `rnap: name at least one module (${MODULES.map((module) => module.id).join(', ')}). With no names, \`rnap ${action}\` opens a picker in a terminal.\n`
      );
      return 2;
    }
    const chosen = await pickModules(states, { stdin, stdout, paint });
    if (!chosen) {
      stdout.write(`Nothing picked: no module changed.\n`);
      return 0;
    }
    if (chosen.length === 0) {
      stdout.write(`Nothing picked: no module changed.\n`);
      return 0;
    }
    requested = chosen;
    picked = true;
  }

  const on = action === 'add';
  const working = new Map();
  const readFile = (file) => {
    if (working.has(file)) return working.get(file);
    return readText(path.resolve(ctx.cwd, file));
  };

  const grouped = new Map();
  const rows = [];
  const manual = [];

  for (const id of requested) {
    const module = MODULES.find((entry) => entry.id === id);
    const before = byId.get(id);
    const plan = planModuleChanges(ctx, module, on, { readFile });
    for (const edit of plan.edits) {
      working.set(edit.file, edit.after);
      const group = grouped.get(edit.file) ?? {
        file: edit.file,
        before: edit.before,
        after: edit.after,
        create: false,
        modules: [],
        changes: [],
      };
      group.after = edit.after;
      group.create = group.create || edit.create;
      if (!group.modules.includes(id)) group.modules.push(id);
      group.changes.push(edit.change);
      grouped.set(edit.file, group);
    }
    for (const step of plan.manual) manual.push({ module: id, step });
    rows.push({
      id,
      was: before.effective,
      // `now` is what the CLI left behind: a manual step does not change it.
      now: plan.edits.length > 0 ? on : before.effective,
      changed: plan.edits.length > 0,
      already: plan.edits.length === 0 && plan.manual.length === 0,
    });
  }

  const changes = [...grouped.values()].map((group) => ({
    ...buildChange({
      cwd: ctx.cwd,
      file: group.file,
      before: group.before,
      after: group.after,
      change: group.changes.join('; '),
      id: group.modules.join(', '),
      create: group.create,
    }),
    modules: group.modules,
  }));

  const effectiveDryRun = Boolean(dryRun || (json && !yes));
  if (!json)
    stdout.write(
      formatToggleHeader({
        action,
        version,
        cwd: ctx.cwd,
        project: projectLine(ctx),
        paint,
      })
    );

  const { applied, skipped } = await reviewChanges({
    changes,
    yes: Boolean(yes) && !dryRun,
    dryRun: effectiveDryRun,
    quiet: Boolean(json),
    paint,
    stdout,
    stdin,
  });

  const report = {
    schemaVersion: 1,
    command: action,
    cwd: ctx.cwd,
    dryRun: effectiveDryRun,
    picked,
    modules: rows,
    applied: applied.map(changeSummary),
    skipped: skipped.map(changeSummary),
    manual,
    nextSteps: nextSteps(effectiveDryRun ? changes : applied),
  };

  if (json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  for (const row of rows) {
    if (row.already)
      stdout.write(
        `\n${paint(row.id, 'bold')} is already ${on ? 'on' : 'off'} in this project.\n`
      );
  }
  stdout.write(
    formatModuleChanges({
      action,
      applied,
      skipped,
      dryRun: effectiveDryRun,
      manual,
      nextSteps: report.nextSteps,
      paint,
    })
  );
  return 0;
}

function changeSummary(change) {
  return {
    modules: change.modules,
    file: relative(change.cwd, change.absolute),
    change: change.change,
    diff: change.diff,
  };
}
