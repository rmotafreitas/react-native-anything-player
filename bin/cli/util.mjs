// Small filesystem helpers shared by the CLI. Every read is tolerant: a
// missing file is `null`, never an exception, because most checks are about
// files that may legitimately be absent (Expo before prebuild, Android on an
// iOS-only project, ...).

import fs from 'node:fs';
import path from 'node:path';

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** JSON file contents, or `null` when missing/unparsable. */
export function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Direct children of `dir` (empty when it does not exist). */
export function children(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Files directly in `dir` with one of `extensions` (e.g. ['.plist']). */
export function filesWithExtension(dir, extensions) {
  return children(dir)
    .filter((name) => extensions.includes(path.extname(name)))
    .map((name) => path.join(dir, name))
    .filter(isFile);
}

/** Relative path for reports, always with forward slashes. */
export function relative(cwd, file) {
  return path.relative(cwd, file).split(path.sep).join('/') || '.';
}
