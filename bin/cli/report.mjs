// Human-readable output. `--json` bypasses this module entirely, so nothing
// here can change the machine-readable schema.

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
