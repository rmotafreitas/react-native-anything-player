/// <reference types="node" />
// Runs `conformance/catalog/*.json` against the TypeScript matcher. Twins:
// `ios/Tests/AnythingPlayerCoreTests/CatalogSearchTests.swift` and
// `android/src/test/.../core/CatalogSearchTest.kt`.

import fs from 'node:fs';
import path from 'node:path';
import {
  searchCatalog,
  tokenize,
  type CatalogQuery,
  type SearchableItem,
} from '../core/catalog';

const DIR = path.resolve(__dirname, '../../conformance/catalog');
const read = <T>(file: string): T =>
  JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as T;

const normalize =
  read<Array<{ name: string; text: string; tokens: string[] }>>(
    'normalize.json'
  );
const search = read<{
  catalog: Array<SearchableItem & { id: string }>;
  cases: Array<{
    name: string;
    request: CatalogQuery;
    expect: string[];
    emptyQuery?: boolean;
  }>;
}>('search.json');

describe('catalog normalization (conformance)', () => {
  it.each(normalize.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(tokenize(c.text)).toEqual(c.tokens);
  });
});

describe('catalog search (conformance)', () => {
  it.each(search.cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const outcome = searchCatalog(search.catalog, c.request);
    expect(outcome.matches.map((i) => search.catalog[i]!.id)).toEqual(c.expect);
    expect(outcome.emptyQuery).toBe(c.emptyQuery ?? false);
  });
});
