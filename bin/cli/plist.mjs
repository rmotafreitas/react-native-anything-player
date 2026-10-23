// A minimal XML property-list parser: enough for Info.plist and entitlements
// (dict, array, key, string, integer, real, true, false, date, data). No
// dependency, no schema, no validation beyond "the tags nest coherently".

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

/** Index just past the tag starting at `index`, plus whether it self-closed. */
function readTag(text, index) {
  const end = text.indexOf('>', index);
  if (end === -1) throw new Error('Unterminated XML tag');
  const inside = text.slice(index + 1, end);
  return { inside, next: end + 1, selfClosing: inside.trimEnd().endsWith('/') };
}

function skipSpace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  // Comments are legal anywhere between elements.
  if (text.startsWith('<!--', i)) {
    const end = text.indexOf('-->', i + 4);
    if (end === -1) throw new Error('Unterminated XML comment');
    return skipSpace(text, end + 3);
  }
  return i;
}

function parseValue(text, index) {
  const start = skipSpace(text, index);
  if (text[start] !== '<') throw new Error('Expected an XML element');
  const { inside, next, selfClosing } = readTag(text, start);
  const name = selfClosing ? inside.replace(/\/$/, '').trim() : inside.trim();
  const tag = name.split(/\s/)[0];

  if (selfClosing) {
    if (tag === 'true') return [true, next];
    if (tag === 'false') return [false, next];
    throw new Error(`Unexpected empty element <${tag}/>`);
  }

  if (tag === 'dict') {
    const value = {};
    let i = next;
    for (;;) {
      i = skipSpace(text, i);
      if (text.startsWith('</dict>', i)) return [value, i + 7];
      const keyTag = readTag(text, i);
      if (!keyTag.inside.trim().startsWith('key'))
        throw new Error('Expected a <key> inside <dict>');
      const keyEnd = text.indexOf('</key>', keyTag.next);
      if (keyEnd === -1) throw new Error('Unterminated <key>');
      const key = decodeEntities(text.slice(keyTag.next, keyEnd));
      let [child, afterChild] = parseValue(text, keyEnd + 6);
      value[key] = child;
      i = afterChild;
    }
  }

  const close = text.indexOf(`</${tag}>`, next);
  if (close === -1) throw new Error(`Unterminated <${tag}>`);
  const raw = text.slice(next, close);
  const after = close + tag.length + 3;

  switch (tag) {
    case 'array': {
      const value = [];
      let i = next;
      for (;;) {
        i = skipSpace(text, i);
        if (text.startsWith('</array>', i)) return [value, i + 8];
        const [child, afterChild] = parseValue(text, i);
        value.push(child);
        i = afterChild;
      }
    }
    case 'string':
      return [decodeEntities(raw), after];
    case 'integer':
      return [Number.parseInt(decodeEntities(raw).trim(), 10), after];
    case 'real':
      return [Number.parseFloat(decodeEntities(raw).trim()), after];
    case 'true':
    case 'false':
      return [tag === 'true', after];
    case 'date':
    case 'data':
      // Kept as text: checks only ask whether these exist.
      return [decodeEntities(raw).trim(), after];
    default:
      throw new Error(`Unsupported plist element <${tag}>`);
  }
}

/**
 * Parses an XML plist into plain JS. Throws on malformed input so callers can
 * report "cannot read this file" instead of silently passing a check.
 */
export function parsePlist(text) {
  const plist = /<plist\b[^>]*>/.exec(text);
  const from = plist ? plist.index + plist[0].length : 0;
  const [value] = parseValue(text, from);
  return value;
}

/** `true` when the file parses and the root is a dict. */
export function isPlistDict(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Adds `item` to the top-level array `key` of an XML plist, inserting the key
 * when it is missing. Returns the new text, or `null` when nothing changed.
 * Only the touched lines are rewritten; the rest of the file is kept as-is.
 */
export function addPlistArrayItem(text, key, item) {
  const value = parsePlist(text);
  if (!isPlistDict(value)) throw new Error('The plist root is not a dict');
  const current = value[key];
  if (Array.isArray(current) && current.includes(item)) return null;
  if (current !== undefined && !Array.isArray(current))
    throw new Error(`\`${key}\` is not an array`);

  const keyTag = `<key>${key}</key>`;
  const keyAt = text.indexOf(keyTag);
  if (keyAt !== -1) {
    const arrayOpen = text.indexOf('<array>', keyAt + keyTag.length);
    const arrayClose = text.indexOf('</array>', arrayOpen);
    if (arrayOpen === -1 || arrayClose === -1)
      throw new Error(`\`${key}\` has no <array> value`);
    const lineStart = text.lastIndexOf('\n', arrayClose) + 1;
    const closingIndent = text.slice(lineStart, arrayClose);
    const inner = text.slice(arrayOpen + '<array>'.length, arrayClose);
    const lastItemLine = inner
      .split('\n')
      .filter((line) => line.trim() !== '')
      .at(-1);
    const itemIndent =
      lastItemLine && /^\s*</.test(lastItemLine)
        ? `${/^\s*/.exec(lastItemLine)[0]}`
        : `${closingIndent}\t`;
    return `${text.slice(0, lineStart)}${itemIndent}<string>${item}</string>\n${text.slice(lineStart)}`;
  }

  const dictClose = text.lastIndexOf('</dict>');
  if (dictClose === -1) throw new Error('No closing </dict>');
  const lineStart = text.lastIndexOf('\n', dictClose) + 1;
  const dictIndent = text.slice(lineStart, dictClose);
  const keyIndent = `${dictIndent}\t`;
  const itemIndent = `${keyIndent}\t`;
  const block =
    `${keyIndent}${keyTag}\n` +
    `${keyIndent}<array>\n` +
    `${itemIndent}<string>${item}</string>\n` +
    `${keyIndent}</array>\n`;
  return `${text.slice(0, lineStart)}${block}${text.slice(lineStart)}`;
}

/**
 * Sets a top-level string value in an XML plist. Returns the new text, or
 * `null` when it already has that value. Only the touched lines change.
 */
export function setPlistString(text, key, value) {
  const parsed = parsePlist(text);
  if (!isPlistDict(parsed)) throw new Error('The plist root is not a dict');
  if (parsed[key] === value) return null;
  if (parsed[key] !== undefined && typeof parsed[key] !== 'string')
    throw new Error(`\`${key}\` is not a string`);
  const escaped = String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const keyTag = `<key>${key}</key>`;
  const keyAt = text.indexOf(keyTag);
  if (keyAt !== -1) {
    const open = text.indexOf('<string>', keyAt + keyTag.length);
    const close = text.indexOf('</string>', open + '<string>'.length);
    const nextKey = text.indexOf('<key>', keyAt + keyTag.length);
    if (open === -1 || close === -1 || (nextKey !== -1 && nextKey < open))
      throw new Error(`\`${key}\` has no <string> value`);
    return (
      text.slice(0, open + '<string>'.length) +
      escaped +
      text.slice(close)
    );
  }

  const dictClose = text.lastIndexOf('</dict>');
  if (dictClose === -1) throw new Error('No closing </dict>');
  const lineStart = text.lastIndexOf('\n', dictClose) + 1;
  const keyIndent = `${text.slice(lineStart, dictClose)}\t`;
  const block = `${keyIndent}${keyTag}\n${keyIndent}<string>${escaped}</string>\n`;
  return `${text.slice(0, lineStart)}${block}${text.slice(lineStart)}`;
}

/**
 * Removes `item` from the top-level array `key` of an XML plist, and the key
 * itself when the array ends up empty. Returns the new text, or `null` when
 * the item was not there. Only the removed lines change.
 */
export function removePlistArrayItem(text, key, item) {
  const value = parsePlist(text);
  if (!isPlistDict(value)) throw new Error('The plist root is not a dict');
  const current = value[key];
  if (!Array.isArray(current) || !current.includes(item)) return null;

  const keyTag = `<key>${key}</key>`;
  const keyAt = text.indexOf(keyTag);
  if (keyAt === -1) throw new Error(`\`${key}\` has no <key> entry`);
  const arrayOpen = text.indexOf('<array>', keyAt + keyTag.length);
  const arrayClose = text.indexOf('</array>', arrayOpen);
  if (arrayOpen === -1 || arrayClose === -1)
    throw new Error(`\`${key}\` has no <array> value`);

  const itemLine = /^\s*<string>.*<\/string>\s*$/;
  const inner = text.slice(arrayOpen + '<array>'.length, arrayClose);
  const lines = inner.split('\n');
  const kept = lines.filter(
    (line) =>
      !(itemLine.test(line) && line.trim() === `<string>${item}</string>`)
  );
  const remaining = kept.filter((line) => line.trim() !== '');

  if (remaining.length > 0)
    return (
      text.slice(0, arrayOpen + '<array>'.length) +
      kept.join('\n') +
      text.slice(arrayClose)
    );

  // Nothing left in the array: drop the whole key and its empty array.
  const lineStart = text.lastIndexOf('\n', keyAt) + 1;
  const end = text.indexOf('\n', arrayClose + '</array>'.length);
  return text.slice(0, lineStart) + text.slice(end === -1 ? text.length : end + 1);
}
