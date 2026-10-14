#!/usr/bin/env node
// Renders docs/diagrams/*.puml to docs/assets/diagrams/*.svg.
//
//   node scripts/render-diagrams.mjs
//
// Needs Java and Graphviz (`dot`). PlantUML is fetched once from Maven Central
// into node_modules/.cache/plantuml. Text is measured with Liberation Sans, which is
// metric-compatible with Arial, so the SVGs can name a portable font stack.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'docs/diagrams');
const OUT = path.join(ROOT, 'docs/assets/diagrams');
const VERSION = '1.2026.8';
// Publisher's Maven Central SHA-512, checked against the downloaded JAR.
const CHECKSUM =
  '3e89bc1eda6d9151b1b085dd6896b15f077b696f98a3626d30b01ce3eea038e76f2c2c8803d996fb4f35a7fa0e7b919fa481cf81bf310b7783e098b8c12acbfe';
const JAR = path.join(
  ROOT,
  `node_modules/.cache/plantuml/plantuml-${VERSION}.jar`
);
const matches = (bytes) =>
  createHash('sha512').update(bytes).digest('hex') === CHECKSUM;
let jar;
try {
  const fd = fs.openSync(JAR, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (fs.fstatSync(fd).size > 64 * 1024 * 1024)
      throw new Error('PlantUML cache exceeds its size limit');
    jar = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

if (!jar || !matches(jar)) {
  fs.mkdirSync(path.dirname(JAR), { recursive: true });
  const url = `https://repo.maven.apache.org/maven2/net/sourceforge/plantuml/plantuml/${VERSION}/plantuml-${VERSION}.jar`;
  console.log(`downloading ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`PlantUML download failed: HTTP ${res.status}`);
  jar = Buffer.from(await res.arrayBuffer());
  if (!matches(jar)) throw new Error('PlantUML download checksum mismatch');
}

const sources = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith('.puml') && !f.startsWith('_'));
fs.mkdirSync(OUT, { recursive: true });
// Execute a private copy of verified bytes. A mutable shared cache cannot
// replace the archive between the checksum check and Java opening its path.
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), 'anythingplayer-plantuml-')
);
try {
  const executable = path.join(temporary, 'plantuml.jar');
  fs.writeFileSync(executable, jar, { flag: 'wx', mode: 0o600 });
  fs.copyFileSync(executable, JAR);
  execFileSync(
    'java',
    [
      '-jar',
      executable,
      '-tsvg',
      '-o',
      OUT,
      ...sources.map((f) => path.join(SRC, f)),
    ],
    {
      stdio: 'inherit',
    }
  );
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
for (const file of sources.map((f) => f.replace(/\.puml$/, '.svg'))) {
  const p = path.join(OUT, file);
  const svg = fs
    .readFileSync(p, 'utf8')
    .replaceAll(
      'font-family="Liberation Sans"',
      'font-family="Arial, \'Liberation Sans\', Helvetica, sans-serif"'
    )
    // PlantUML embeds its source as a processing instruction; drop it.
    .replace(/<\?plantuml[^?]*\?>/g, '');
  fs.writeFileSync(p, svg);
  console.log(`wrote ${path.relative(ROOT, p)}`);
}
