// The measured size data `rnap size` prints. The numbers come from the
// repository's benchmarks (benchmarks/results/apk.json and size.json); the CLI
// bundle carries them, injected by scripts/build-cli.mjs, so `rnap size` reads
// no file at run time. Running the sources (tests, `bin/rnap.mjs`) derives the
// same data from the JSON on disk.

import { fileURLToPath } from 'node:url';
import { readJson } from './util.mjs';

// scripts/build-cli.mjs replaces this identifier with the derived data.
const EMBEDDED =
  typeof __RNAP_SIZE_DATA__ === 'undefined' ? null : __RNAP_SIZE_DATA__;

const LIBRARY = 'react-native-anything-player';

/** Repository root, from bin/cli/. */
export function repoRoot() {
  return fileURLToPath(new URL('../..', import.meta.url));
}

function installedLibrary(apk) {
  return apk.libraries.find((entry) => entry.id === 'rnap') ?? null;
}

function apkBytes(entry) {
  if (!entry || entry.failed) return null;
  if (!entry.r8 || !entry.noR8) return null;
  return { r8: entry.r8.apkBytes, noR8: entry.noR8.apkBytes };
}

/**
 * Reduces the benchmark files to the few numbers the CLI needs: the RNAP
 * entries of the APK run and RNAP's own web pages. `apk.json`'s entries are
 * whole-app measurements, so a module's cost is the difference between the
 * RNAP entry and the entry built with its switch flipped.
 *
 * @param {object} apk benchmarks/results/apk.json
 * @param {object} size benchmarks/results/size.json
 */
export function deriveSizeData(apk, size) {
  const base = apkBytes(installedLibrary(apk));
  const noHls = apkBytes(apk.libraries.find((entry) => entry.id === 'rnapNoHls'));

  const modules = {};
  // HLS is on in the default entry: what turning it off saves.
  if (base && noHls)
    modules.hls = { r8: base.r8 - noHls.r8, noR8: base.noR8 - noHls.noR8 };
  // Cast, Sound, Car and video are off in the default entry: what turning one
  // on adds. A module with no entry in the APK run is reported as not measured.
  for (const [id, entryId] of [
    ['cast', 'rnapCast'],
    ['sound', 'rnapSound'],
    ['car', 'rnapCar'],
    ['video', 'rnapVideo'],
  ]) {
    const entry = apkBytes(apk.libraries.find((item) => item.id === entryId));
    if (base && entry)
      modules[id] = { r8: entry.r8 - base.r8, noR8: entry.noR8 - base.noR8 };
  }

  const web = [];
  for (const page of size.web ?? []) {
    const entry = (page.packages ?? []).find(
      (item) => item.name === LIBRARY
    );
    if (!entry) continue;
    web.push({
      id: page.id,
      title: page.title,
      initialGzipBytes: entry.initialGzipBytes,
      totalGzipBytes: entry.totalGzipBytes,
      later: (entry.later ?? []).map((item) => ({
        name: item.name,
        gzipBytes: item.gzipBytes,
        when: item.when,
      })),
    });
  }

  return {
    measuredAt: apk.measuredAt ?? null,
    method: apk.method ?? null,
    reactNative: apk.reactNative ?? null,
    abi: apk.abi ?? null,
    version: installedLibrary(apk)?.version ?? null,
    android: { base, modules },
    web,
  };
}

/** The data, or null when there is nothing to read (outside the repo). */
export function loadSizeData(root = repoRoot()) {
  if (EMBEDDED) return EMBEDDED;
  const apk = readJson(`${root}/benchmarks/results/apk.json`);
  const size = readJson(`${root}/benchmarks/results/size.json`);
  if (!apk || !size) return null;
  return deriveSizeData(apk, size);
}
