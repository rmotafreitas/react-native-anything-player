// Findings are the CLI's only output vocabulary: every check returns them and
// both `doctor` and `init` consume the same list.

export const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

/**
 * @param {string} id stable check id, documented in docs/cli.md
 * @param {'error'|'warning'|'info'} severity
 * @param {string} message what is wrong, in the words of the docs
 * @param {{file: string, change: string}|null} fix the concrete manual fix
 * @param {string|null} autofix id `init` can apply, when the fix is safe
 */
export function finding(id, severity, message, fix = null, autofix = null) {
  return { id, severity, message, fix, autofix };
}

export function sortFindings(findings) {
  return [...findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );
}

export function summarize(findings) {
  const summary = { errors: 0, warnings: 0, infos: 0 };
  for (const item of findings) {
    if (item.severity === 'error') summary.errors += 1;
    else if (item.severity === 'warning') summary.warnings += 1;
    else summary.infos += 1;
  }
  return summary;
}
