#!/usr/bin/env node
// Install-size comparison: react-native-airwave against the other React Native
// audio players, measured from what npm actually ships.
//
//   node benchmarks/size/measure.mjs            # writes benchmarks/results/size.json
//
// Every number is computed from the published tarballs (plus Airwave's own
// `npm pack` of this checkout), so the run is reproducible on any machine with
// npm and network access to the registry. No device or build is involved:
// app-binary impact is a separate, on-device measurement (see README.md here).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'benchmarks/results/size.json');

/** The field. `role` is what it is to an app choosing an audio library. */
const PACKAGES = [
  { name: '@rntp/player', label: 'RNTP 5 (@rntp/player)', role: 'player, commercial' },
  { name: 'react-native-track-player', version: '4', label: 'RNTP 4', role: 'player, last Apache-2.0 line' },
  { name: 'expo-audio', label: 'expo-audio', role: 'player + recorder' },
  { name: 'expo-av', label: 'expo-av', role: 'deprecated audio/video' },
  { name: 'react-native-audio-pro', label: 'react-native-audio-pro', role: 'player' },
  { name: 'react-native-nitro-sound', label: 'react-native-nitro-sound', role: 'player + recorder' },
  { name: 'react-native-video', label: 'react-native-video', role: 'video player' },
  { name: 'react-native-audio-api', label: 'react-native-audio-api', role: 'Web Audio engine' },
  { name: 'react-native-sound', label: 'react-native-sound', role: 'sound effects' },
];

/** Provided by every RN app (or by the package's own peer framework): not counted. */
const EXTERNAL = [
  'react', 'react/*', 'react-native', 'react-native/*', 'react-native-web',
  '@react-native/*', 'expo', 'expo-modules-core', 'expo-asset', 'expo-constants',
  'expo-file-system', '@expo/*', 'react-native-nitro-modules',
  'react-native-worklets', 'react-native-windows', 'shaka-player', 'shaka-player/*',
];

const NATIVE_EXT = /\.(swift|m|mm|h|hpp|c|cc|cpp|kt|java)$/;
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Native sources that compile into an app (tests, examples and builds excluded). */
function nativeFootprint(pkgDir) {
  const files = [...walk(path.join(pkgDir, 'ios')), ...walk(path.join(pkgDir, 'apple')),
    ...walk(path.join(pkgDir, 'android')), ...walk(path.join(pkgDir, 'cpp')),
    ...walk(path.join(pkgDir, 'common')), ...walk(path.join(pkgDir, 'nitrogen'))]
    .filter((f) => NATIVE_EXT.test(f))
    .filter((f) => !/[\\/](test|tests|androidTest|Tests|example|build|\.build)[\\/]/.test(f));
  let bytes = 0;
  let lines = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    bytes += Buffer.byteLength(text);
    lines += text.split('\n').filter((l) => l.trim() !== '').length;
  }
  return { files: files.length, bytes, lines };
}

/** Maven artifacts a package adds to an Android app (React Native / Kotlin / tests excluded). */
function androidDependencies(pkgDir) {
  const gradle = path.join(pkgDir, 'android/build.gradle');
  if (!fs.existsSync(gradle)) return [];
  const deps = new Set();
  for (const line of fs.readFileSync(gradle, 'utf8').split('\n')) {
    const m = /^\s*(implementation|api)\s*\(?\s*["']([^"'$]+)/.exec(line);
    if (!m) continue;
    const coord = m[2].split(':').slice(0, 2).join(':');
    if (/^com\.facebook\.react|^org\.jetbrains\.kotlin:kotlin-stdlib/.test(coord)) continue;
    deps.add(coord);
  }
  return [...deps].sort();
}

/** Vendored binaries (xcframeworks, .so, .a) a package downloads or ships. */
function vendoredBinaries(pkgDir) {
  const podspecs = walk(pkgDir).filter((f) => f.endsWith('.podspec'));
  return podspecs.some((f) => /vendored_frameworks|vendored_libraries/.test(fs.readFileSync(f, 'utf8')));
}

/** Minified + gzipped size of the JS an app bundles (compiled entry, peers external). */
async function jsCost(esbuild, entryDir, pkgName, nodePaths, fromSource = false) {
  const result = await esbuild.build({
    stdin: { contents: `export * from '${pkgName}';`, resolveDir: entryDir },
    bundle: true,
    minify: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    // Compiled output first (what most apps resolve); TypeScript source as a
    // fallback for packages whose compiled output does not bundle on its own
    // (type-only re-exports left in JS).
    mainFields: fromSource ? ['react-native', 'module', 'main'] : ['module', 'main'],
    conditions: ['import', 'default'],
    resolveExtensions: ['.native.js', '.ios.js', '.js', '.mjs', '.cjs', '.native.ts', '.ios.ts', '.ts', '.tsx', '.json'],
    external: EXTERNAL,
    loader: { '.js': 'jsx', '.png': 'empty', '.jpg': 'empty', '.ttf': 'empty', '.wasm': 'empty' },
    nodePaths,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].contents;
  return { min: code.length, gzip: zlib.gzipSync(code, { level: 9 }).length };
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'airwave-size-'));
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"size","private":true}');
  const specs = PACKAGES.map((p) => (p.version ? `${p.name}@${p.version}` : p.name));
  console.log(`installing ${specs.length} packages into ${work} …`);
  sh('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--omit=peer', '--no-audit',
    '--no-fund', 'esbuild@0.25', ...specs], { cwd: work });
  const { default: esbuild } = await import(path.join(work, 'node_modules/esbuild/lib/main.js'));
  const nodePaths = [path.join(work, 'node_modules')];

  // Airwave: pack this checkout exactly as it would be published.
  console.log('packing react-native-airwave …');
  if (!fs.existsSync(path.join(ROOT, 'lib/module/index.js'))) sh('yarn', ['prepare'], { cwd: ROOT });
  // `npm pack` may still print the `prepare` build log before its JSON.
  const packOutput = sh('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], { cwd: ROOT });
  const packed = JSON.parse(packOutput.slice(packOutput.search(/^\[/m)))[0];
  const airwaveDir = path.join(work, 'airwave');
  fs.mkdirSync(airwaveDir);
  sh('tar', ['xzf', path.join(work, packed.filename), '-C', airwaveDir]);
  fs.symlinkSync(path.join(airwaveDir, 'package'), path.join(work, 'node_modules/react-native-airwave'));

  const rows = [];
  const all = [{ name: 'react-native-airwave', label: 'Airwave', role: 'player (this repo)', local: packed }, ...PACKAGES];
  for (const pkg of all) {
    const dir = path.join(work, 'node_modules', pkg.name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    let tarball;
    let unpacked;
    if (pkg.local) {
      tarball = pkg.local.size;
      unpacked = pkg.local.unpackedSize;
    } else {
      const meta = JSON.parse(sh('npm', ['view', `${pkg.name}@${manifest.version}`, 'dist', '--json']));
      unpacked = meta.unpackedSize;
      tarball = (await (await fetch(meta.tarball)).arrayBuffer()).byteLength;
    }
    const peers = Object.keys(manifest.peerDependencies ?? {})
      .filter((p) => !(manifest.peerDependenciesMeta?.[p]?.optional))
      .filter((p) => !['react', 'react-native'].includes(p));
    let js = null;
    try {
      js = await jsCost(esbuild, work, pkg.name, nodePaths).catch(() =>
        jsCost(esbuild, work, pkg.name, nodePaths, true));
    } catch (error) {
      console.warn(`  ${pkg.name}: JS bundle failed:\n    ${(error.errors ?? []).map((e) => e.text).join('\n    ')}`);
    }
    const row = {
      name: pkg.name,
      label: pkg.label,
      role: pkg.role,
      version: manifest.version,
      license: manifest.license ?? null,
      tarballBytes: tarball,
      unpackedBytes: unpacked,
      jsMinBytes: js?.min ?? null,
      jsGzipBytes: js?.gzip ?? null,
      runtimeDependencies: Object.keys(manifest.dependencies ?? {}),
      requiredPeers: peers,
      native: nativeFootprint(dir),
      androidDependencies: androidDependencies(dir),
      vendoredBinaries: vendoredBinaries(dir),
    };
    rows.push(row);
    console.log(`  ${row.label.padEnd(26)} ${row.version.padEnd(9)} tgz ${(tarball / 1024).toFixed(0).padStart(5)} KB` +
      `  unpacked ${(unpacked / 1024).toFixed(0).padStart(6)} KB  js ${js ? (js.gzip / 1024).toFixed(1) : '-'} KB gz` +
      `  native ${row.native.lines} loc  android deps ${row.androidDependencies.length}`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    measuredAt: new Date().toISOString().slice(0, 10),
    method: 'benchmarks/size/measure.mjs',
    packages: rows,
  }, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
