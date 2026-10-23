// A format-preserving JSON editor: `patchJson` turns the difference between a
// parsed value and its edited copy into replacements of exact source ranges, so
// everything the edit does not touch stays byte for byte. It handles setting
// and adding object keys and array elements; anything else (removing a key,
// shortening an array, duplicate keys) throws `Unsupported`, and the caller
// rewrites the whole file instead.

import { isDeepStrictEqual } from 'node:util';

export class Unsupported extends Error {}

const WHITESPACE = /[ \t\r\n]/;
const INLINE_LIMIT = 72;

/** The node tree of a JSON text, with the source range of every value. */
function spans(text) {
  let index = 0;
  const skip = () => {
    while (index < text.length && WHITESPACE.test(text[index])) index += 1;
  };
  const string = () => {
    const start = index;
    index += 1;
    while (index < text.length && text[index] !== '"')
      index += text[index] === '\\' ? 2 : 1;
    index += 1;
    return { start, end: index };
  };
  const value = () => {
    skip();
    const start = index;
    const char = text[index];
    if (char === '{') {
      index += 1;
      const members = [];
      skip();
      while (text[index] !== '}') {
        skip();
        const key = string();
        skip();
        index += 1; // :
        const node = value();
        members.push({
          key: JSON.parse(text.slice(key.start, key.end)),
          start: key.start,
          node,
        });
        skip();
        if (text[index] === ',') index += 1;
        skip();
      }
      index += 1;
      return { type: 'object', start, end: index, members };
    }
    if (char === '[') {
      index += 1;
      const elements = [];
      skip();
      while (text[index] !== ']') {
        elements.push(value());
        skip();
        if (text[index] === ',') index += 1;
        skip();
      }
      index += 1;
      return { type: 'array', start, end: index, elements };
    }
    if (char === '"') {
      const { end } = string();
      return { type: 'scalar', start, end };
    }
    while (index < text.length && !/[,\]}\s]/.test(text[index])) index += 1;
    return { type: 'scalar', start, end: index };
  };
  const root = value();
  return root;
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function inline(value) {
  if (Array.isArray(value))
    return value.length === 0 ? '[]' : `[${value.map(inline).join(', ')}]`;
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`).join(', ')} }`;
  }
  return JSON.stringify(value);
}

/** A value as text: on one line when it is short, else expanded at `base`. */
function render(value, { unit, eol }, base) {
  const compact = inline(value);
  if (compact.length <= INLINE_LIMIT || typeof value !== 'object' || value === null)
    return compact;
  const inner = `${base}${unit}`;
  if (Array.isArray(value))
    return `[${eol}${value.map((item) => `${inner}${render(item, { unit, eol }, inner)}`).join(`,${eol}`)}${eol}${base}]`;
  return `{${eol}${Object.entries(value)
    .map(
      ([key, item]) =>
        `${inner}${JSON.stringify(key)}: ${render(item, { unit, eol }, inner)}`
    )
    .join(`,${eol}`)}${eol}${base}}`;
}

/** The whitespace that starts the line holding `offset`. */
function lineIndent(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))[0];
}

function patch(text, node, before, after, style, edits) {
  if (isDeepStrictEqual(before, after)) return;

  if (node.type === 'object' && isObject(before) && isObject(after)) {
    const keys = node.members.map((member) => member.key);
    if (new Set(keys).size !== keys.length) throw new Unsupported();
    for (const key of Object.keys(before))
      if (!Object.hasOwn(after, key)) throw new Unsupported();
    const added = [];
    for (const [key, value] of Object.entries(after)) {
      const member = node.members.find((item) => item.key === key);
      if (member) patch(text, member.node, before[key], value, style, edits);
      else added.push([key, value]);
    }
    if (added.length > 0) addMembers(text, node, added, style, edits);
    return;
  }

  if (node.type === 'array' && Array.isArray(before) && Array.isArray(after)) {
    if (after.length < before.length) throw new Unsupported();
    for (let i = 0; i < before.length; i += 1)
      patch(text, node.elements[i], before[i], after[i], style, edits);
    if (after.length > before.length)
      addElements(text, node, after.slice(before.length), style, edits);
    return;
  }

  // A different kind of value, or a different scalar: replace it in place.
  edits.push({
    start: node.start,
    end: node.end,
    text: render(after, style, lineIndent(text, node.start)),
  });
}

function addMembers(text, node, added, style, edits) {
  const { eol, unit } = style;
  if (node.members.length === 0) {
    const base = lineIndent(text, node.start);
    const value = Object.fromEntries(added);
    edits.push({ start: node.start, end: node.end, text: render(value, style, base) });
    return;
  }
  const first = node.members[0];
  const last = node.members.at(-1);
  const multiline = text.slice(node.start, last.node.end).includes('\n');
  if (!multiline) {
    const items = added.map(
      ([key, value]) => `${JSON.stringify(key)}: ${inline(value)}`
    );
    edits.push({
      start: last.node.end,
      end: last.node.end,
      text: `, ${items.join(', ')}`,
    });
    return;
  }
  if (text.slice(node.start, first.start).indexOf('\n') === -1)
    throw new Unsupported();
  const indent = lineIndent(text, first.start);
  const items = added.map(
    ([key, value]) =>
      `${indent}${JSON.stringify(key)}: ${render(value, { unit, eol }, indent)}`
  );
  edits.push({
    start: last.node.end,
    end: last.node.end,
    text: `,${eol}${items.join(`,${eol}`)}`,
  });
}

function addElements(text, node, added, style, edits) {
  const { eol, unit } = style;
  if (node.elements.length === 0) {
    const base = lineIndent(text, node.start);
    edits.push({ start: node.start, end: node.end, text: render(added, style, base) });
    return;
  }
  const first = node.elements[0];
  const last = node.elements.at(-1);
  const multiline = text.slice(node.start, last.end).includes('\n');
  if (!multiline) {
    edits.push({
      start: last.end,
      end: last.end,
      text: `, ${added.map(inline).join(', ')}`,
    });
    return;
  }
  if (text.slice(node.start, first.start).indexOf('\n') === -1)
    throw new Unsupported();
  const indent = lineIndent(text, first.start);
  edits.push({
    start: last.end,
    end: last.end,
    text: `,${eol}${added.map((value) => `${indent}${render(value, { unit, eol }, indent)}`).join(`,${eol}`)}`,
  });
}

/**
 * `text` with `before` turned into `after`, touching only the ranges that
 * differ. Throws `Unsupported` when the change cannot be made that way.
 */
export function patchJson(text, before, after) {
  const root = spans(text);
  const style = {
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    unit: /^[{[][^\n]*\r?\n([ \t]+)/.exec(text)?.[1] ?? '  ',
  };
  const edits = [];
  patch(text, root, before, after, style, edits);
  let out = text;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  // The proof: whatever the patch did, the file means what the edit says.
  if (!isDeepStrictEqual(JSON.parse(out), after)) throw new Unsupported();
  return out;
}
