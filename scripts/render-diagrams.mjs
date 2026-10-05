#!/usr/bin/env node
// Renders docs/diagrams/*.puml to docs/assets/diagrams/*.svg.
//
//   node scripts/render-diagrams.mjs
//
// Needs Java and Graphviz (`dot`). PlantUML is fetched once from Maven Central
// into node_modules/.cache/plantuml. Text is measured with Liberation Sans, which is
// metric-compatible with Arial, so the SVGs can name a portable font stack.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs/diagrams');
const OUT = path.join(ROOT, 'docs/assets/diagrams');
const VERSION = '1.2026.8';
const JAR = path.join(ROOT, `node_modules/.cache/plantuml/plantuml-${VERSION}.jar`);

if (!fs.existsSync(JAR)) {
  fs.mkdirSync(path.dirname(JAR), { recursive: true });
  const url = `https://repo1.maven.org/maven2/net/sourceforge/plantuml/plantuml/${VERSION}/plantuml-${VERSION}.jar`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`PlantUML download failed: HTTP ${res.status}`);
  fs.writeFileSync(JAR, Buffer.from(await res.arrayBuffer()));
}

const sources = fs.readdirSync(SRC).filter((f) => f.endsWith('.puml') && !f.startsWith('_'));
fs.mkdirSync(OUT, { recursive: true });
execFileSync('java', ['-jar', JAR, '-tsvg', '-o', OUT, ...sources.map((f) => path.join(SRC, f))], {
  stdio: 'inherit',
});
for (const file of sources.map((f) => f.replace(/\.puml$/, '.svg'))) {
  const p = path.join(OUT, file);
  const svg = fs
    .readFileSync(p, 'utf8')
    .replaceAll('font-family="Liberation Sans"', 'font-family="Arial, \'Liberation Sans\', Helvetica, sans-serif"');
  fs.writeFileSync(p, svg);
  console.log(`wrote ${path.relative(ROOT, p)}`);
}
