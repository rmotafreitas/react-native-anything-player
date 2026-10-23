// Human-readable output. `--json` bypasses this module entirely, so nothing
// here can change the machine-readable schema.

import { formatBytes } from './size.mjs';

const STYLES = {
  red: [31, 39],
  yellow: [33, 39],
  blue: [34, 39],
  gray: [90, 39],
  bold: [1, 22],
};

export function createPainter(enabled) {
  if (!enabled) return (text) => text;
  return (text, ...styles) => {
    let out = String(text);
    for (const style of styles) {
      const [open, close] = STYLES[style] ?? [];
      if (open) out = `\u001b[${open}m${out}\u001b[${close}m`;
    }
    return out;
  };
}

const LABELS = {
  error: ['error', 'red'],
  warning: ['warn ', 'yellow'],
  info: ['info ', 'blue'],
};

function urlLine(result) {
  if (result.error) return `  ${result.url} — ${result.error}`;
  const parts = [`HTTP ${result.status}`, result.codec];
  if (result.icyMetaInt) parts.push('ICY');
  if (result.redirects.length > 0) parts.push('redirected');
  return `  ${result.finalUrl} — ${parts.join(', ')}`;
}

export function formatDoctor(report, { version, paint }) {
  const lines = [];
  const project = report.project;
  const kind = project.kind === 'expo' ? 'Expo' : 'bare React Native';
  const versions = [
    project.kind === 'expo' && project.expo?.sdk
      ? `Expo SDK ${project.expo.sdk}`
      : null,
    project.reactNative ? `React Native ${project.reactNative}` : null,
    project.library ? `RNAP ${project.library.version}` : null,
  ].filter(Boolean);

  lines.push(paint(`RNAP doctor ${version}`, 'bold'));
  lines.push(`${report.cwd}`);
  lines.push(paint([kind, ...versions].join(' · '), 'gray'));

  if (report.findings.length === 0) {
    lines.push('');
    lines.push(paint('No problems found.', 'bold'));
  } else {
    for (const finding of report.findings) {
      const [label, color] = LABELS[finding.severity] ?? LABELS.info;
      lines.push('');
      lines.push(`${paint(label, color)} ${paint(finding.id, 'bold')}`);
      lines.push(`      ${finding.message}`);
      if (finding.fix) {
        lines.push(
          `      ${paint('fix', 'gray')}  ${finding.fix.file} — ${finding.fix.change}`
        );
      }
    }
    lines.push('');
    const { errors, warnings, infos } = report.summary;
    const parts = [];
    if (errors)
      parts.push(paint(`${errors} error${errors === 1 ? '' : 's'}`, 'red'));
    if (warnings) parts.push(`${warnings} warning${warnings === 1 ? '' : 's'}`);
    if (infos) parts.push(`${infos} info`);
    lines.push(parts.join(', '));
    if (errors > 0)
      lines.push(paint('Run `rnap init` to apply the safe fixes.', 'gray'));
  }

  if (report.urls.length > 0) {
    lines.push('');
    lines.push(paint('Streams', 'bold'));
    for (const result of report.urls) lines.push(urlLine(result));
  }
  return `${lines.join('\n')}\n`;
}

export function formatInitHeader(cwd, version, paint) {
  return `${paint(`RNAP init ${version}`, 'bold')}\n${cwd}\n`;
}

const SOURCE_LABELS = {
  'app.json': 'app.json',
  'android/gradle.properties': 'gradle.properties',
  'ios/Podfile.properties.json': 'Podfile.properties.json',
  'Info.plist': 'Info.plist',
  manual: 'by hand',
  default: 'default',
};

function costText(item) {
  if (!item.size) return item.sizeNote ?? 'not measured in the APK';
  const r8 = formatBytes(item.size.r8);
  return item.defaultOn
    ? `${r8} of the default build`
    : `adds ${r8} with R8`;
}

export function formatModules(report, { version, paint, project }) {
  const lines = [];
  lines.push(paint(`RNAP modules ${version}`, 'bold'));
  lines.push(`${report.cwd}  ${paint(`(${project})`, 'gray')}`);
  lines.push(
    paint(`${report.summary.on} of ${report.summary.total} on`, 'gray')
  );
  lines.push('');
  for (const item of report.modules) {
    const state = item.effective ? 'on ' : 'off';
    const source = SOURCE_LABELS[item.source] ?? item.source ?? 'default';
    const label = item.effective ? paint(state, 'bold') : paint(state, 'gray');
    lines.push(
      `  ${label} ${String(item.id).padEnd(17)}${source.padEnd(23)}${item.description}`
    );
    lines.push(
      paint(
        `      ${''.padEnd(17)}${''.padEnd(23)}${costText(item)}`,
        'gray'
      )
    );
  }
  lines.push('');
  lines.push('Turn one on:   npx rnap add <module>');
  lines.push('Turn one off:  npx rnap remove <module>');
  lines.push('What they cost: npx rnap size');
  return `${lines.join('\n')}\n`;
}

export function formatToggleHeader({ action, version, cwd, project, paint }) {
  return `${paint(`RNAP ${action} ${version}`, 'bold')}\n${cwd}  ${paint(`(${project})`, 'gray')}\n`;
}

export function formatMigrateHeader({ cwd, version, paint }) {
  return `${paint(`RNAP migrate ${version}`, 'bold')}\n${cwd}\n`;
}

export function formatModuleChanges({
  action,
  applied,
  skipped,
  failed = [],
  dryRun,
  manual,
  nextSteps,
  paint,
}) {
  const lines = [];
  const notApplied = skipped.length + failed.length;
  const total = applied.length + notApplied;
  lines.push('');
  if (total === 0) {
    lines.push(
      manual.length > 0
        ? 'No file changes: the steps below are by hand.'
        : 'Nothing to change: this project is already in that state.'
    );
  } else if (dryRun) {
    lines.push(
      `Dry run: ${total} file${total === 1 ? '' : 's'} would change, nothing written.`
    );
  } else {
    lines.push(
      `${applied.length} file${applied.length === 1 ? '' : 's'} changed${
        notApplied > 0 ? `, ${notApplied} not applied` : ''
      }.`
    );
  }

  if (manual.length > 0) {
    lines.push('');
    lines.push(paint('By hand', 'bold'));
    for (const item of manual) lines.push(`  ${item.module}: ${item.step}`);
  }

  if (nextSteps.length > 0) {
    lines.push('');
    lines.push(paint('Next', 'bold'));
    for (const step of nextSteps) lines.push(`  ${step}`);
  } else if (
    manual.length === 0 &&
    (action === 'add' || action === 'remove')
  ) {
    lines.push('');
    lines.push(paint('Nothing to rebuild: no build file changed.', 'gray'));
  }
  return `${lines.join('\n')}\n`;
}

function row(label, value) {
  return `  ${String(label).padEnd(18)}${value}`;
}

export function formatInfo(report, { paint }) {
  const lines = [];
  lines.push(paint(`RNAP info ${report.cli.version}`, 'bold'));
  lines.push(`${report.cwd}  ${paint(report.collectedAt, 'gray')}`);
  lines.push('');
  lines.push(paint('Environment', 'bold'));
  lines.push(row('OS', report.environment.os));
  lines.push(row('Node', report.environment.node));
  lines.push(row('npm', report.environment.npm ?? 'not found'));
  lines.push(row('yarn', report.environment.yarn ?? 'not found'));
  lines.push('');
  lines.push(paint('Project', 'bold'));
  lines.push(row('Project kind', report.project.kind));
  if (report.project.library)
    lines.push(
      row(
        'RNAP',
        `${report.project.library.version}${report.project.library.installed ? '' : ' (workspace, not node_modules)'}`
      ),
      row('RNAP path', report.project.library.path)
    );
  lines.push(row('React Native', report.project.reactNative ?? 'not a dependency'));
  if (report.project.expo)
    lines.push(
      row(
        'Expo SDK',
        `${report.project.expo.sdk ?? 'unknown'} (${report.project.expo.configFile})`
      )
    );
  lines.push(row('Media3', report.project.media3Version ?? 'unknown'));
  lines.push(row('New Architecture', newArchText(report.project.newArchitecture)));
  if (report.project.ios)
    lines.push(row('iOS target', report.project.ios.deploymentTarget ?? 'unknown'));
  if (report.project.android)
    lines.push(
      row(
        'Android SDK',
        `min ${report.project.android.minSdk ?? '?'}, compile ${report.project.android.compileSdk ?? '?'}, target ${report.project.android.targetSdk ?? '?'}`
      )
    );
  lines.push(
    row(
      'Modules on',
      report.project.modules.on.length > 0
        ? report.project.modules.on.join(', ')
        : 'none'
    )
  );
  lines.push(
    row(
      'Modules off',
      report.project.modules.off.length > 0
        ? report.project.modules.off.join(', ')
        : 'none'
    )
  );
  lines.push('');
  lines.push(paint('Doctor', 'bold'));
  const { errors, warnings, infos } = report.doctor.summary;
  lines.push(
    row(
      'Findings',
      `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}, ${infos} info`
    )
  );
  for (const finding of report.doctor.findings) {
    lines.push(
      `  ${finding.severity.padEnd(8)}${finding.id}  ${paint(finding.message, 'gray')}`
    );
  }
  return `${lines.join('\n')}\n`;
}

function newArchText(value) {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return 'unknown';
}

