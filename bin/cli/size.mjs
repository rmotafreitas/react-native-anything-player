// `rnap size`: what this project's modules add to a release APK, with R8 and
// without, and to a web page. The measurements live in benchmarks/results/ and
// are bundled into the CLI at build time (size-data.mjs); a module without a
// measurement is reported as such, never guessed.

import { loadProject } from './project.mjs';
import { MODULES, moduleStates } from './modules.mjs';
import { loadSizeData } from './size-data.mjs';
import { missingProject } from './util.mjs';

const DISCLAIMER =
  'Measured on a React Native {rn} arm64-v8a release build ({at}), against the same empty app. An estimate for your app: other libraries share Media3 and OkHttp, and R8 results change with your rules.';

export function formatBytes(bytes) {
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs >= 1024 * 1024)
    return `${sign}${(abs / 1024 / 1024).toFixed(1)} MB`;
  return `${sign}${Math.round(abs / 1024).toLocaleString('en-US')} KB`;
}

/** One line for the picker and `rnap modules`: what the module costs. */
export function moduleCostText(state, data) {
  const cost = data?.android.modules?.[state.id] ?? null;
  if (!cost)
    return state.platforms.includes('android')
      ? 'not measured in the APK'
      : 'iOS only: nothing in the Android APK';
  const r8 = formatBytes(cost.r8);
  return state.defaultOn
    ? `${r8} of the default build`
    : `adds ${r8} with R8`;
}

/**
 * What the project builds, from the default measurement plus the modules whose
 * state differs from the default. Configuration-only modules add nothing.
 *
 * @param {Array<{id: string, effective: boolean}>} states
 * @param {ReturnType<typeof loadSizeData>} data
 */
export function projectSize(states, data) {
  const byId = new Map(states.map((state) => [state.id, state]));
  const base = data.android.base;
  const total = base ? { ...base } : null;

  const modules = MODULES.map((module) => {
    const state = byId.get(module.id);
    const enabled = Boolean(state?.effective);
    const cost = data.android.modules?.[module.id] ?? null;
    if (cost && total && enabled !== module.defaultOn) {
      const factor = enabled ? 1 : -1;
      total.r8 += factor * cost.r8;
      total.noR8 += factor * cost.noR8;
    }
    return {
      id: module.id,
      label: module.label,
      enabled,
      defaultOn: module.defaultOn,
      measured: cost !== null,
      cost,
      note: cost === null ? noteFor(module) : null,
    };
  });

  return { base, total, modules };
}

function noteFor(module) {
  if (!module.platforms.includes('android'))
    return 'iOS only: nothing in the Android APK';
  return 'not measured in the APK';
}

export function buildSizeReport(cwd, data) {
  const ctx = loadProject(cwd);
  const result = projectSize(moduleStates(ctx), data);
  return {
    schemaVersion: 1,
    command: 'size',
    cwd: ctx.cwd,
    measured: {
      at: data.measuredAt,
      reactNative: data.reactNative,
      abi: data.abi,
      version: data.version,
      method: data.method,
    },
    note: DISCLAIMER.replace('{rn}', data.reactNative ?? '?').replace(
      '{at}',
      data.measuredAt ?? '?'
    ),
    android: {
      base: result.base,
      total: result.total,
      modules: result.modules,
    },
    web: data.web,
  };
}

export function runSize({ cwd, json, version, paint, stdout = process.stdout }) {
  const data = loadSizeData();
  if (!data) {
    stdout.write(
      'rnap: no measured size data: run this command from the library checkout, or reinstall the package.\n'
    );
    return 1;
  }
  const ctx = loadProject(cwd);
  if (!ctx.packageJson) {
    const missing = missingProject('size', cwd, json);
    stdout.write(missing.text);
    return missing.status;
  }
  const report = buildSizeReport(cwd, data);
  if (json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }
  stdout.write(formatSizeReport(report, { version, paint }));
  return 0;
}

const pad = (text, width) => String(text).padEnd(width);
const padLeft = (text, width) => String(text).padStart(width);

export function formatSizeReport(report, { paint, version }) {
  const lines = [];
  lines.push(paint(`RNAP size ${version}`, 'bold'));
  lines.push(report.cwd);
  lines.push('');

  lines.push(paint('Android release APK', 'bold'));
  lines.push(
    paint(
      `measured on React Native ${report.measured.reactNative} (${report.measured.abi})`,
      'gray'
    )
  );
  lines.push(
    `  ${pad('', 34)}${padLeft('R8 on', 10)}${padLeft('R8 off', 10)}`
  );
  if (report.android.base)
    lines.push(
      `  ${pad('RNAP, default build', 34)}${padLeft(formatBytes(report.android.base.r8), 10)}${padLeft(formatBytes(report.android.base.noR8), 10)}`
    );
  const on = report.android.modules.filter((item) => item.enabled).length;
  if (report.android.total)
    lines.push(
      `  ${pad(`this project, ${on} module${on === 1 ? '' : 's'} on`, 34)}${padLeft(formatBytes(report.android.total.r8), 10)}${padLeft(formatBytes(report.android.total.noR8), 10)}`
    );

  lines.push('');
  lines.push(paint('Modules', 'bold'));
  for (const item of report.android.modules) {
    const state = item.enabled ? 'on ' : 'off';
    let cost;
    if (!item.measured) cost = item.note;
    else if (item.enabled && item.defaultOn)
      cost = `${formatBytes(item.cost.r8)} with R8 (${formatBytes(item.cost.noR8)} without), part of the default build`;
    else if (item.enabled)
      cost = `adds ${formatBytes(item.cost.r8)} with R8 (${formatBytes(item.cost.noR8)} without)`;
    else if (item.defaultOn)
      cost = `saves ${formatBytes(item.cost.r8)} with R8 (${formatBytes(item.cost.noR8)} without)`;
    else
      cost = `would add ${formatBytes(item.cost.r8)} with R8 (${formatBytes(item.cost.noR8)} without)`;
    lines.push(`  ${state} ${pad(item.id, 17)}${cost}`);
  }

  const switching = report.android.modules.filter(
    (item) => item.measured && item.enabled !== item.defaultOn
  );
  if (switching.length > 0) {
    lines.push('');
    lines.push(paint('Switching', 'bold'));
    for (const item of switching) {
      const delta = item.enabled ? item.cost : negate(item.cost);
      lines.push(
        item.enabled
          ? `  npx rnap remove ${item.id}  saves ${formatBytes(delta.r8)} with R8 (${formatBytes(delta.noR8)} without)`
          : `  npx rnap add ${item.id}  adds ${formatBytes(delta.r8)} with R8 (${formatBytes(delta.noR8)} without)`
      );
    }
  }

  if (report.web.length > 0) {
    lines.push('');
    lines.push(paint('Web page (gzip)', 'bold'));
    for (const page of report.web) {
      lines.push(
        `  ${pad(page.title, 32)}${formatBytes(page.initialGzipBytes)} up front, ${formatBytes(page.totalGzipBytes)} in total`
      );
      for (const part of page.later) {
        lines.push(
          `  ${pad('', 32)}+ ${formatBytes(part.gzipBytes)} ${part.name}: ${part.when}`
        );
      }
    }
  }

  lines.push('');
  lines.push(paint(report.note, 'gray'));
  lines.push(
    paint(
      `RNAP ${report.measured.version} · measured ${report.measured.at}.`,
      'gray'
    )
  );
  return `${lines.join('\n')}\n`;
}

function negate(cost) {
  return { r8: -cost.r8, noR8: -cost.noR8 };
}
