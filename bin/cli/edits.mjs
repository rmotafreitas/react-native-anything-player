// The edits the CLI makes: which files it may write, a minimal JSON editor that
// keeps the file's layout, and one diff-and-confirm loop shared by `init`,
// `add`, `remove` and `migrate`.

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { unifiedDiff } from './diff.mjs';
import { Unsupported, patchJson } from './json-edit.mjs';

function within(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/**
 * The file the CLI may write, or null: inside the project both as written and
 * once every symlink is resolved, and not itself a symlink (writing through one
 * could change a file outside the project). With `create`, a file that does not
 * exist yet is allowed when its directory is inside the project.
 */
export function writableTarget(cwd, file, { create = false } = {}) {
  const absolute = path.resolve(cwd, file);
  try {
    const root = fs.realpathSync(path.resolve(cwd));
    if (!within(path.resolve(cwd), absolute)) return null;
    if (!fs.existsSync(absolute)) {
      if (!create) return null;
      return within(root, fs.realpathSync(path.dirname(absolute)))
        ? absolute
        : null;
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return within(root, fs.realpathSync(absolute)) ? absolute : null;
  } catch {
    return null;
  }
}

export function withEol(text, template) {
  return template.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * A format-preserving JSON edit: only the keys the mutation touches change in
 * the text, the rest of the file stays byte for byte. For a structure it cannot
 * patch (a removed key, a shortened array) the whole file is reserialized, and
 * `note` says so. `null` when the mutation changes nothing.
 *
 * @returns {{text: string, note: string|null}|null}
 */
export function editJsonDetailed(text, mutate) {
  const value = JSON.parse(text);
  const next = structuredClone(value);
  if (mutate(next) === false) return null;
  try {
    return { text: patchJson(text, value, next), note: null };
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
  }
  const indent = /^[{[][^\n]*\r?\n([ \t]+)/.exec(text)?.[1] ?? '  ';
  const body = JSON.stringify(next, null, indent);
  return {
    text: withEol(body, text) + (text.endsWith('\n') ? '\n' : ''),
    note: 'the file is rewritten in full: its layout cannot be patched in place',
  };
}

/** `editJsonDetailed` for callers that only want the text (or `null`). */
export function editJson(text, mutate) {
  return editJsonDetailed(text, mutate)?.text ?? null;
}

/**
 * What an edit function returned as text and a note: edits return the new text,
 * `null` for no change, or `{ text, note }` (a JSON edit that fell back to
 * rewriting the whole file says so).
 */
export function editResult(result) {
  if (result === null || result === undefined) return { after: null, note: null };
  if (typeof result === 'string') return { after: result, note: null };
  return { after: result.text, note: result.note ?? null };
}

/** One file change: the diff is computed once, from the text it started with. */
export function buildChange({
  cwd,
  file,
  before,
  after,
  change,
  id = null,
  create = false,
}) {
  return {
    id,
    file,
    change,
    cwd,
    absolute: path.resolve(cwd, file),
    before,
    after,
    create,
    diff: unifiedDiff(file, before, after),
  };
}

/** The target changed after the diff was shown: nothing is written. */
export class ChangedSinceDiffError extends Error {}

function currentText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function applyChange(change) {
  // Checked again: the tree may have changed while the user read the diff.
  if (
    writableTarget(change.cwd, change.absolute, { create: change.create }) !==
    change.absolute
  )
    throw new Error(`${change.file} is no longer a file inside the project`);
  // The diff was computed from `before`: a file that is no longer that text
  // would lose whatever was written in the meantime.
  const current = currentText(change.absolute);
  if (current !== (change.create && current === null ? null : change.before))
    throw new ChangedSinceDiffError(
      `${change.file} changed since the diff was shown, so nothing was written to it: run the command again`
    );

  // Written beside the target and renamed over it: a crash leaves the old file
  // or the new one, never half of either. The file's mode is kept.
  const directory = path.dirname(change.absolute);
  const temporary = path.join(
    directory,
    `.${path.basename(change.absolute)}.rnap-${process.pid}.tmp`
  );
  const mode =
    current === null ? 0o644 : fs.statSync(change.absolute).mode & 0o7777;
  try {
    fs.writeFileSync(temporary, change.after, { encoding: 'utf8', mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, change.absolute);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

/**
 * Line-based asker that also answers '' on end of input, so a piped command
 * (or CI without --yes) skips the change instead of hanging on a question that
 * can never be answered.
 */
export function createAsker(input, output) {
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

/**
 * Shows every change as a unified diff and applies the accepted ones.
 * `--yes` accepts everything, `--dry-run` asks nothing and writes nothing.
 *
 * A change that cannot be written (the file changed since the diff, or left
 * the project) is reported, listed in `failed` and left untouched; the other
 * changes go on.
 *
 * @returns {Promise<{applied: object[], skipped: object[], failed: {change: object, error: string}[]}>}
 */
export async function reviewChanges({
  changes,
  yes,
  dryRun,
  quiet = false,
  paint,
  stdout,
  stdin,
}) {
  const applied = [];
  const skipped = [];
  const failed = [];
  const asker = yes || dryRun ? null : createAsker(stdin, stdout);
  try {
    for (const [index, change] of changes.entries()) {
      if (!quiet) {
        stdout.write(
          `\n${index + 1}/${changes.length}  ${paint(change.id ?? change.file, 'bold')}  ${change.file}\n`
        );
        stdout.write(`${paint(change.change, 'gray')}\n\n${change.diff}\n`);
      }
      if (dryRun) {
        skipped.push(change);
        continue;
      }
      let accept = Boolean(yes);
      if (asker) {
        const answer = await asker.ask('Apply this change? [y/N] ');
        accept = /^y(es)?$/i.test(answer.trim());
      }
      if (!accept) {
        if (!quiet) stdout.write('Skipped.\n');
        skipped.push(change);
        continue;
      }
      try {
        applyChange(change);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        failed.push({ change, error: error.message });
        if (!quiet) stdout.write(`${paint(`Not applied: ${error.message}`, 'red')}\n`);
        continue;
      }
      applied.push(change);
      if (!quiet) stdout.write('Applied.\n');
    }
  } finally {
    asker?.close();
  }
  return { applied, skipped, failed };
}
