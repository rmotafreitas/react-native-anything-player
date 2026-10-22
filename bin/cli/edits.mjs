// The edits the CLI makes: which files it may write, a minimal JSON editor that
// keeps the file's layout, and one diff-and-confirm loop shared by `init`,
// `add`, `remove` and `migrate`.

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { unifiedDiff } from './diff.mjs';

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

/** Minimal, format-preserving JSON edit (indent and newlines kept). */
export function editJson(text, mutate) {
  const value = JSON.parse(text);
  if (mutate(value) === false) return null;
  const indent = /^[{[][^\n]*\r?\n([ \t]+)/.exec(text)?.[1] ?? '  ';
  const body = JSON.stringify(value, null, indent);
  return withEol(body, text) + (text.endsWith('\n') ? '\n' : '');
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

export function applyChange(change) {
  // Checked again: the tree may have changed while the user read the diff.
  if (
    writableTarget(change.cwd, change.absolute, { create: change.create }) !==
    change.absolute
  )
    throw new Error(`${change.file} is no longer a file inside the project`);
  fs.writeFileSync(change.absolute, change.after, 'utf8');
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
 * @returns {Promise<{applied: object[], skipped: object[]}>}
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
      applyChange(change);
      applied.push(change);
      if (!quiet) stdout.write('Applied.\n');
    }
  } finally {
    asker?.close();
  }
  return { applied, skipped };
}
