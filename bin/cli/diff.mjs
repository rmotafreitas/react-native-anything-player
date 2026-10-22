// Unified diffs without a dependency: line LCS, three lines of context. Files
// here are config files (a few hundred lines), so the O(n*m) table is fine.

const CONTEXT = 3;

function toLines(text) {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

function lineOps(before, after) {
  const a = toLines(before);
  const b = toLines(after);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Int32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        a[i] === b[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      ops.push({ type: '-', text: a[i] });
      i += 1;
    } else {
      ops.push({ type: '+', text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) ops.push({ type: '-', text: a[i++] });
  while (j < b.length) ops.push({ type: '+', text: b[j++] });
  return ops;
}

function hunkRanges(ops) {
  const changed = ops
    .map((op, index) => (op.type === ' ' ? -1 : index))
    .filter((index) => index !== -1);
  if (changed.length === 0) return [];

  const ranges = [];
  let start = Math.max(0, changed[0] - CONTEXT);
  let end = Math.min(ops.length - 1, changed[0] + CONTEXT);
  for (const index of changed.slice(1)) {
    if (index - CONTEXT <= end + 1) {
      end = Math.min(ops.length - 1, index + CONTEXT);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, index - CONTEXT);
      end = Math.min(ops.length - 1, index + CONTEXT);
    }
  }
  ranges.push([start, end]);
  return ranges;
}

export function unifiedDiff(file, before, after) {
  const ops = lineOps(before, after);
  const ranges = hunkRanges(ops);
  if (ranges.length === 0) return '';

  // Old/new line numbers at every index, so hunk headers are cheap.
  const oldLine = new Array(ops.length + 1);
  const newLine = new Array(ops.length + 1);
  let oldAt = 1;
  let newAt = 1;
  for (let index = 0; index < ops.length; index += 1) {
    oldLine[index] = oldAt;
    newLine[index] = newAt;
    if (ops[index].type !== '+') oldAt += 1;
    if (ops[index].type !== '-') newAt += 1;
  }
  oldLine[ops.length] = oldAt;
  newLine[ops.length] = newAt;

  const lines = [`--- a/${file}`, `+++ b/${file}`];
  for (const [start, end] of ranges) {
    const slice = ops.slice(start, end + 1);
    const oldCount = slice.filter((op) => op.type !== '+').length;
    const newCount = slice.filter((op) => op.type !== '-').length;
    lines.push(
      `@@ -${oldLine[start]},${oldCount} +${newLine[start]},${newCount} @@`
    );
    for (const op of slice) lines.push(`${op.type}${op.text}`);
  }
  return `${lines.join('\n')}\n`;
}
