// A small XML reader for TTML: elements, attributes, text and CDATA, the
// predefined and numeric entities. No DTDs, no validation: React Native has
// no `DOMParser`, and TTML needs only this.

import { decodeEntities } from './markup';

export interface XmlElement {
  /** The local name (`tt:p` → `p`). */
  name: string;
  /** Attributes by their full name (`tts:color`, `xml:id`). */
  attributes: Record<string, string>;
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

const NAME = /^[^\s/>=]+/;

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(colon + 1) : name;
}

/** `name="value"` and `name='value'` pairs, scanned without a regular expression. */
function readAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  let i = 0;
  let eq = source.indexOf('=');
  while (eq >= 0) {
    const name = source.slice(i, eq).trim().split(/\s/).pop() ?? '';
    let open = eq + 1;
    while (/\s/.test(source[open] ?? '')) open += 1;
    const quote = source[open];
    const close =
      quote === '"' || quote === "'" ? source.indexOf(quote, open + 1) : -1;
    if (close >= 0 && name !== '')
      attributes[name] = decodeEntities(source.slice(open + 1, close));
    // A value without quotes ends the attributes.
    i = close >= 0 ? close + 1 : source.length;
    eq = source.indexOf('=', i);
  }
  return attributes;
}

/** Where the markup at `i` (a `<`) ends, past its `>`. */
function markupEnd(xml: string, i: number): number {
  if (xml.startsWith('<!--', i)) return end(xml, '-->', i);
  if (xml.startsWith('<![CDATA[', i)) return end(xml, ']]>', i);
  if (xml.startsWith('<?', i)) return end(xml, '?>', i);
  if (xml.startsWith('<!', i)) return end(xml, '>', i);
  // A `>` inside a quoted attribute does not end the tag.
  let quote: string | null = null;
  for (let j = i + 1; j < xml.length; j += 1) {
    const ch = xml[j];
    if (quote != null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return j + 1;
    } else {
      // Part of the tag.
    }
  }
  return xml.length;
}

function end(xml: string, token: string, from: number): number {
  const at = xml.indexOf(token, from);
  return at < 0 ? xml.length : at + token.length;
}

/** Parses a document; returns its root element, or `null` if it has none. */
export function parseXml(xml: string): XmlElement | null {
  const root: XmlElement = { name: '#document', attributes: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const top = stack[stack.length - 1]!;
    if (lt < 0) {
      top.children.push(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) top.children.push(decodeEntities(xml.slice(i, lt)));
    const close = markupEnd(xml, lt);
    markup(xml.slice(lt, close), stack);
    i = close;
  }
  const element = root.children.find(
    (c): c is XmlElement => typeof c !== 'string'
  );
  return element ?? null;
}

function markup(tag: string, stack: XmlElement[]): void {
  const top = stack[stack.length - 1]!;
  if (tag.startsWith('<![CDATA[')) {
    top.children.push(tag.slice(9, -3));
    return;
  }
  if (tag.startsWith('<!') || tag.startsWith('<?')) return;
  if (tag.startsWith('</')) {
    if (stack.length > 1) stack.pop();
    return;
  }
  const inner = tag.slice(1, tag.endsWith('/>') ? -2 : -1);
  const name = NAME.exec(inner)?.[0] ?? '';
  const element: XmlElement = {
    name: localName(name),
    attributes: readAttributes(inner.slice(name.length)),
    children: [],
  };
  top.children.push(element);
  if (!tag.endsWith('/>')) stack.push(element);
}

/** An attribute by local name, whatever its prefix (`tts:color`, `color`). */
export function attribute(element: XmlElement, name: string): string | null {
  const direct = element.attributes[name];
  if (direct != null) return direct;
  for (const [key, value] of Object.entries(element.attributes)) {
    if (localName(key) === name) return value;
  }
  return null;
}

export function childElements(element: XmlElement): XmlElement[] {
  return element.children.filter((c): c is XmlElement => typeof c !== 'string');
}

/** The first descendant (or the element itself) with this local name. */
export function find(element: XmlElement, name: string): XmlElement | null {
  if (element.name === name) return element;
  for (const child of childElements(element)) {
    const found = find(child, name);
    if (found) return found;
  }
  return null;
}
