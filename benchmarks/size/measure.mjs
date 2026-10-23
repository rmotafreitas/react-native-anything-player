#!/usr/bin/env node
// Size comparison, measured from what npm actually ships, by where an app runs:
//
//   - iOS and Android: RNAP against the other React Native audio players
//     (download, native code, Android libraries, JS);
//   - Expo web and React Native Web: the same React Native packages, bundled for
//     the browser;
//   - React (react-dom) and plain JavaScript pages: RNAP's `/react` and `/web`
//     entries against the web audio libraries of each kind.
//
// Web numbers are what a production bundle loads: code-split like Vite or
// webpack would, the JS a page loads up front apart from what a package loads
// only when a feature is used.
//
//   node benchmarks/size/measure.mjs            # writes benchmarks/results/size.json
//
// Every number is computed from the published tarballs (plus RNAP's own
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

/**
 * The web libraries, by the kind of page they are for. `use`: what an app
 * imports. `later`: what a package itself fetches at run time (not a bundle
 * import), with when.
 */
const R = 'react-native-anything-player';
const WEB = [
  {
    id: 'rnWeb',
    title: 'Expo web and React Native Web',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'react-native', 'react-native/*', 'react-native-web',
      'react-native-web/*', 'expo', 'expo-modules-core', 'expo-asset', 'expo-constants', 'expo-file-system', '@expo/*',
      'react-native-nitro-modules'],
    reactNative: true,
    packages: [
      { name: R, label: 'RNAP', use: `export * from '${R}';`,
        later: [{ name: 'hls.js', when: 'HLS outside Safari (the app adds it)' }] },
      { name: '@rntp/player', label: 'RNTP 5', use: `export * from '@rntp/player';`,
        later: [{ name: 'shaka-player', file: 'dist/shaka-player.compiled.js', when: 'HLS / DASH outside Safari' }] },
      { name: 'react-native-track-player', version: '4', label: 'RNTP 4', use: `export * from 'react-native-track-player';`,
        later: [{ name: 'shaka-player', file: 'dist/shaka-player.ui.js', when: 'playing anything', required: true }] },
      { name: 'expo-audio', label: 'expo-audio', use: `export * from 'expo-audio';` },
      { name: 'expo-av', label: 'expo-av', use: `export * from 'expo-av';` },
      { name: 'react-native-video', label: 'react-native-video', use: `export * from 'react-native-video';` },
      { name: 'react-native-audio-api', label: 'react-native-audio-api', use: `export * from 'react-native-audio-api';` },
    ],
  },
  {
    id: 'react',
    title: 'React (react-dom)',
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    packages: [
      { name: R, label: 'RNAP /react', use: `export * from '${R}/react';` },
      { name: 'use-sound', label: 'use-sound (howler)', use: `export { default } from 'use-sound';` },
      { name: 'react-h5-audio-player', label: 'react-h5-audio-player', use: `export { default } from 'react-h5-audio-player';` },
      { name: 'react-audio-player', label: 'react-audio-player', use: `export { default } from 'react-audio-player';` },
      { name: 'react-player', label: 'react-player', use: `export { default } from 'react-player';` },
      { name: '@vidstack/react', label: 'Vidstack', use: `export { MediaPlayer, MediaProvider } from '@vidstack/react';` },
    ],
  },
  {
    id: 'vanilla',
    title: 'Any web page (no framework)',
    external: [],
    packages: [
      { name: R, label: 'RNAP /web', use: `export * from '${R}/web';` },
      { name: 'howler', label: 'howler.js', use: `export { Howl, Howler } from 'howler';` },
      { name: 'amplitudejs', label: 'Amplitude.js', use: `export { default } from 'amplitudejs';` },
      { name: 'plyr', label: 'Plyr', use: `export { default } from 'plyr';` },
      { name: 'icecast-metadata-player', label: 'icecast-metadata-player', use: `export { default } from 'icecast-metadata-player';` },
    ],
  },
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

/**
 * RNAP's opt-in parts: Google Cast (`cast`), the Sound API (`sound`), CarPlay
 * and Android Auto (`car`), and the Siri templates an app compiles only with
 * `siri`. Reported apart from what every app compiles.
 */
const OPT_IN_NATIVE = /[\\/](ios[\\/](Cast|CarPlay|Sound|AppIntents|IntentsExtension)|android[\\/]src[\\/](cast|castcar|car|sound))[\\/]/;

function countLines(files) {
  let bytes = 0;
  let lines = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    bytes += Buffer.byteLength(text);
    lines += text.split('\n').filter((l) => l.trim() !== '').length;
  }
  return { files: files.length, bytes, lines };
}

/** Native sources that compile into an app (tests, examples and builds excluded), and RNAP's opt-in ones apart. */
function nativeFootprint(pkgDir) {
  const files = [...walk(path.join(pkgDir, 'ios')), ...walk(path.join(pkgDir, 'apple')),
    ...walk(path.join(pkgDir, 'android')), ...walk(path.join(pkgDir, 'cpp')),
    ...walk(path.join(pkgDir, 'common')), ...walk(path.join(pkgDir, 'nitrogen'))]
    .filter((f) => NATIVE_EXT.test(f))
    .filter((f) => !/[\\/](test|tests|androidTest|Tests|example|build|\.build)[\\/]/.test(f));
  const optIn = files.filter((f) => OPT_IN_NATIVE.test(f));
  const always = files.filter((f) => !OPT_IN_NATIVE.test(f));
  return optIn.length > 0
    ? { ...countLines(always), optIn: countLines(optIn) }
    : countLines(always);
}

/** Maven artifacts a package adds to an Android app (React Native / Kotlin / tests excluded). */
function androidDependencies(pkgDir, { optIn = false } = {}) {
  const gradle = path.join(pkgDir, 'android/build.gradle');
  if (!fs.existsSync(gradle)) return [];
  const deps = new Set();
  // Inside `if (includeCast) { … }` (RNAP's opt-in Cast): counted apart.
  let castDepth = 0;
  for (const line of fs.readFileSync(gradle, 'utf8').split('\n')) {
    if (castDepth === 0 && /^\s*if\s*\(.*[Cc]ast.*\)\s*\{/.test(line)) {
      castDepth = 1;
      continue;
    }
    if (castDepth > 0) castDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    const m = /^\s*(implementation|api)\s*\(?\s*["']([^"'$]+)/.exec(line);
    if (!m || (castDepth > 0) !== optIn) continue;
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

/**
 * A production web bundle of `contents`, split like an app bundler splits it:
 * the JS a page loads up front (the entry and its static imports) and all of
 * it (with the chunks loaded by `import()` when a feature is used). Minified,
 * gzip -9.
 */
async function webCost(esbuild, work, contents, { external, reactNative }) {
  const entry = path.join(work, 'web-entry.js');
  fs.writeFileSync(entry, contents);
  const result = await esbuild.build({
    entryPoints: [entry],
    outdir: path.join(work, 'web-out'),
    bundle: true,
    minify: true,
    splitting: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    // React Native packages resolve their `.web` files, as Metro and the RNW
    // bundler configs do.
    ...(reactNative
      ? {
          mainFields: ['browser', 'module', 'main'],
          resolveExtensions: ['.web.tsx', '.web.ts', '.web.js', '.web.mjs', '.tsx', '.ts', '.js', '.mjs', '.json'],
        }
      : {}),
    conditions: ['browser', 'import', 'default'],
    define: { 'process.env.NODE_ENV': '"production"', __DEV__: 'false' },
    external,
    loader: { '.js': 'jsx', '.png': 'empty', '.jpg': 'empty', '.css': 'empty', '.ttf': 'empty', '.wasm': 'empty' },
    logLevel: 'silent',
  });
  const gzip = (bytes) => zlib.gzipSync(bytes, { level: 9 }).length;
  const files = new Map(result.outputFiles.map((f) => [path.relative(process.cwd(), f.path), f.contents]));
  const outputs = result.metafile.outputs;
  const initial = new Set();
  const visit = (file) => {
    if (initial.has(file)) return;
    initial.add(file);
    for (const i of outputs[file].imports) if (i.kind === 'import-statement' && outputs[i.path]) visit(i.path);
  };
  visit(Object.keys(outputs).find((file) => outputs[file].entryPoint));
  const cost = { initialMin: 0, initialGzip: 0, totalGzip: 0, chunks: 0 };
  for (const [file, code] of files) {
    if (!file.endsWith('.js')) continue;
    cost.chunks += 1;
    cost.totalGzip += gzip(code);
    if (initial.has(file)) {
      cost.initialMin += code.length;
      cost.initialGzip += gzip(code);
    }
  }
  return cost;
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'rnap-size-'));
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"size","private":true}');
  const webOnly = WEB.flatMap((c) => c.packages)
    .filter((p) => p.name !== R && !PACKAGES.some((q) => q.name === p.name))
    .map((p) => (p.version ? `${p.name}@${p.version}` : p.name));
  const runtimeExtras = [...new Set(WEB.flatMap((c) => c.packages.flatMap((p) => (p.later ?? []).map((l) => l.name))))];
  const specs = [...PACKAGES.map((p) => (p.version ? `${p.name}@${p.version}` : p.name)), ...new Set(webOnly), ...runtimeExtras];
  console.log(`installing ${specs.length} packages into ${work} …`);
  sh('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--omit=peer', '--no-audit',
    '--no-fund', 'esbuild@0.25', ...specs], { cwd: work });
  const { default: esbuild } = await import(path.join(work, 'node_modules/esbuild/lib/main.js'));
  const nodePaths = [path.join(work, 'node_modules')];

  // RNAP: pack this checkout exactly as it would be published.
  console.log('packing react-native-anything-player …');
  if (!fs.existsSync(path.join(ROOT, 'lib/module/index.js'))) sh('yarn', ['prepare'], { cwd: ROOT });
  // `npm pack` may still print the `prepare` build log before its JSON.
  const packOutput = sh('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], { cwd: ROOT });
  const packed = JSON.parse(packOutput.slice(packOutput.search(/^\[/m)))[0];
  const rnapDir = path.join(work, 'rnap');
  fs.mkdirSync(rnapDir);
  sh('tar', ['xzf', path.join(work, packed.filename), '-C', rnapDir]);
  fs.symlinkSync(path.join(rnapDir, 'package'), path.join(work, 'node_modules/react-native-anything-player'));

  const rows = [];
  const all = [{ name: 'react-native-anything-player', label: 'RNAP', role: 'player (this repo)', local: packed }, ...PACKAGES];
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
      optInAndroidDependencies: androidDependencies(dir, { optIn: true }),
      vendoredBinaries: vendoredBinaries(dir),
    };
    rows.push(row);
    console.log(`  ${row.label.padEnd(26)} ${row.version.padEnd(9)} tgz ${(tarball / 1024).toFixed(0).padStart(5)} KB` +
      `  unpacked ${(unpacked / 1024).toFixed(0).padStart(6)} KB  js ${js ? (js.gzip / 1024).toFixed(1) : '-'} KB gz` +
      `  native ${row.native.lines} loc  android deps ${row.androidDependencies.length}`);
  }

  // What a package fetches later on its own (hls.js, shaka-player): its own size, gzipped.
  const extraSize = (name, file) => {
    const dir = path.join(work, 'node_modules', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const main = file ?? (name === 'hls.js' ? 'dist/hls.min.js' : manifest.main);
    return { version: manifest.version, gzip: zlib.gzipSync(fs.readFileSync(path.join(dir, main)), { level: 9 }).length };
  };

  const web = [];
  for (const category of WEB) {
    console.log(`web: ${category.title}`);
    const packages = [];
    for (const pkg of category.packages) {
      const manifest = JSON.parse(fs.readFileSync(path.join(work, 'node_modules', pkg.name, 'package.json'), 'utf8'));
      const cost = await webCost(esbuild, work, pkg.use, category);
      const later = (pkg.later ?? []).map((l) => {
        const extra = extraSize(l.name, l.file);
        return { name: l.name, version: extra.version, gzipBytes: extra.gzip, when: l.when, required: l.required === true };
      });
      packages.push({
        name: pkg.name,
        label: pkg.label,
        version: manifest.version,
        license: manifest.license ?? null,
        initialMinBytes: cost.initialMin,
        initialGzipBytes: cost.initialGzip,
        totalGzipBytes: cost.totalGzip,
        later,
      });
      console.log(`  ${pkg.label.padEnd(26)} ${manifest.version.padEnd(9)} on load ${(cost.initialGzip / 1024).toFixed(1).padStart(6)} KB gz` +
        `  with every feature ${(cost.totalGzip / 1024).toFixed(1).padStart(6)} KB gz` +
        later.map((l) => `  + ${l.name} ${(l.gzipBytes / 1024).toFixed(0)} KB (${l.when})`).join(''));
    }
    web.push({ id: category.id, title: category.title, packages });
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    measuredAt: new Date().toISOString().slice(0, 10),
    method: 'benchmarks/size/measure.mjs',
    packages: rows,
    web,
  }, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
