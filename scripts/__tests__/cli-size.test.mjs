import test from 'node:test';
import assert from 'node:assert/strict';
import { bareGood, makeDir, runCli } from './cli-fixtures.mjs';
import {
  buildSizeReport,
  formatBytes,
  formatSizeReport,
  moduleCostText,
  projectSize,
} from '../../bin/cli/size.mjs';
import fs from 'node:fs';
import { deriveSizeData, loadSizeData } from '../../bin/cli/size-data.mjs';
import { moduleStates } from '../../bin/cli/modules.mjs';
import { loadProject } from '../../bin/cli/project.mjs';

const data = loadSizeData();

test('bytes are rounded the way the CLI prints them', () => {
  assert.equal(formatBytes(0), '0 KB');
  assert.equal(formatBytes(65536), '64 KB');
  assert.equal(formatBytes(1467731), '1.4 MB');
  assert.equal(formatBytes(-65536), '-64 KB');
  assert.equal(formatBytes(1536), '2 KB');
});

// The measured builds, as benchmarks/android/measure-apk.mjs wrote them.
const apk = JSON.parse(
  fs.readFileSync(new URL('../../benchmarks/results/apk.json', import.meta.url))
);
const built = (id) => {
  const entry = apk.libraries.find((l) => l.id === id);
  return { r8: entry.r8.apkBytes, noR8: entry.noR8.apkBytes };
};
const minus = (a, b) => ({ r8: a.r8 - b.r8, noR8: a.noR8 - b.noR8 });

test('the registry data has a base build and the measured modules', () => {
  assert.ok(data, 'the repository carries the measured size data');
  const base = built('rnap');
  assert.deepEqual(data.android.base, base);
  assert.deepEqual(data.android.modules.hls, minus(base, built('rnapNoHls')));
  assert.deepEqual(data.android.modules.cast, minus(built('rnapCast'), base));
  assert.deepEqual(data.android.modules.sound, minus(built('rnapSound'), base));
  assert.deepEqual(data.android.modules.car, minus(built('rnapCar'), base));
  assert.equal(data.web.length, 3);
  assert.equal(data.web[0].id, 'rnWeb');
  assert.equal(data.web[0].later[0].name, 'hls.js');
});

test('a module cost line says whether it is part of the default build', () => {
  const hls = { id: 'hls', platforms: ['android'], defaultOn: true };
  const cast = { id: 'cast', platforms: ['android'], defaultOn: false };
  const siri = { id: 'siri', platforms: ['ios'], defaultOn: false };
  const sound = { id: 'sound', platforms: ['android'], defaultOn: false };

  const measured = (modules) => ({
    ...data,
    android: { ...data.android, modules },
  });
  const sample = measured({
    hls: { r8: 65536, noR8: 98304 },
    cast: { r8: 1467731, noR8: 7391451 },
    sound: { r8: 300, noR8: 400 },
  });
  assert.equal(moduleCostText(hls, sample), '64 KB of the default build');
  assert.equal(moduleCostText(cast, sample), 'adds 1.4 MB with R8');
  assert.equal(
    moduleCostText(siri, sample),
    'iOS only: nothing in the Android APK'
  );
  assert.equal(moduleCostText(sound, sample), 'adds less than 1 KB with R8');
  assert.equal(moduleCostText(sound, measured({})), 'not measured in the APK');
  assert.equal(moduleCostText(hls, null), 'not measured in the APK');
});

test('the project total is the default build plus what this app changed', () => {
  const states = (values) =>
    Object.entries(values).map(([id, effective]) => ({ id, effective }));

  const defaults = projectSize(
    states({ hls: true, cast: false, assistant: true }),
    data
  );
  assert.deepEqual(defaults.total, data.android.base);

  const withoutHls = projectSize(states({ hls: false }), data);
  assert.deepEqual(withoutHls.total, {
    r8: data.android.base.r8 - 65536,
    noR8: data.android.base.noR8 - 98304,
  });

  const withCast = projectSize(states({ hls: true, cast: true }), data);
  assert.deepEqual(withCast.total, {
    r8: data.android.base.r8 + 1467731,
    noR8: data.android.base.noR8 + 7391451,
  });

  assert.equal(
    withCast.modules.find((item) => item.id === 'cast').enabled,
    true
  );
});

test('deriveSizeData keeps only what the CLI prints', () => {
  const apk = {
    measuredAt: '2026-01-01',
    method: 'benchmark.mjs',
    reactNative: '0.80.0',
    abi: 'arm64-v8a',
    libraries: [
      {
        id: 'rnap',
        version: '1.0.0',
        r8: { apkBytes: 100 },
        noR8: { apkBytes: 300 },
      },
      { id: 'rnapNoHls', r8: { apkBytes: 90 }, noR8: { apkBytes: 280 } },
      { id: 'rnapCast', r8: { apkBytes: 150 }, noR8: { apkBytes: 400 } },
      { id: 'rnapSound', r8: { apkBytes: 105 }, noR8: { apkBytes: 310 } },
      { id: 'other', r8: { apkBytes: 1 }, noR8: { apkBytes: 1 } },
    ],
  };
  const size = {
    web: [
      {
        id: 'rnWeb',
        title: 'Expo web',
        packages: [
          {
            name: 'react-native-anything-player',
            initialGzipBytes: 10,
            totalGzipBytes: 20,
            later: [{ name: 'hls.js', gzipBytes: 30, when: 'HLS' }],
          },
          { name: 'other', initialGzipBytes: 1, totalGzipBytes: 1 },
        ],
      },
      { id: 'none', title: 'Nothing', packages: [] },
    ],
  };

  const derived = deriveSizeData(apk, size);
  assert.deepEqual(derived.android.base, { r8: 100, noR8: 300 });
  assert.deepEqual(derived.android.modules.hls, { r8: 10, noR8: 20 });
  assert.deepEqual(derived.android.modules.cast, { r8: 50, noR8: 100 });
  assert.deepEqual(derived.android.modules.sound, { r8: 5, noR8: 10 });
  // No rnapCar entry in the run: the module is reported as not measured.
  assert.equal(derived.android.modules.car, undefined);
  assert.equal(derived.version, '1.0.0');
  assert.deepEqual(derived.web, [
    {
      id: 'rnWeb',
      title: 'Expo web',
      initialGzipBytes: 10,
      totalGzipBytes: 20,
      later: [{ name: 'hls.js', gzipBytes: 30, when: 'HLS' }],
    },
  ]);
  assert.equal(deriveSizeData({ libraries: [] }, {}).android.base, null);
});

test('size --json reports this project against the default build', (t) => {
  const root = bareGood(t);
  const result = runCli(['size', '--json'], { cwd: root });
  assert.equal(result.status, 0);
  assert.equal(result.json.schemaVersion, 1);
  assert.equal(result.json.command, 'size');
  assert.equal(result.json.measured.reactNative, '0.86.3');
  assert.equal(result.json.measured.abi, 'arm64-v8a');
  assert.deepEqual(result.json.android.base, data.android.base);
  assert.deepEqual(result.json.android.total, data.android.base);
  assert.equal(result.json.android.modules.length, 7);
  assert.equal(
    result.json.android.modules.find((item) => item.id === 'cast').cost.r8,
    1467731
  );
  assert.equal(result.json.web.length, 3);
  assert.match(result.json.note, /An estimate for your app/);
});

test('size prints the tables, the modules and the switch commands', (t) => {
  const root = bareGood(t);
  runCli(['add', 'cast', '--yes'], { cwd: root });
  const result = runCli(['size'], { cwd: root });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Android release APK/);
  assert.match(result.stdout, /R8 on\s+R8 off/);
  assert.match(result.stdout, /RNAP, default build/);
  assert.match(result.stdout, /this project, 4 modules on/);
  assert.match(result.stdout, /adds 1\.4 MB with R8/);
  assert.match(result.stdout, /Web page \(gzip\)/);
  assert.match(result.stdout, /npx rnap remove cast\s+saves 1\.4 MB with R8/);
});

test('size needs a package.json and never invents a project', (t) => {
  const root = makeDir(t);
  const result = runCli(['size'], { cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /No package\.json here/);

  const json = runCli(['size', '--json'], { cwd: root });
  assert.equal(json.status, 1);
  assert.equal(json.json.ok, false);
  assert.equal(json.json.command, 'size');
});

test('buildSizeReport reads the project state', (t) => {
  const root = bareGood(t);
  const report = buildSizeReport(root, data);
  const states = moduleStates(loadProject(root));
  assert.equal(report.android.modules.length, states.length);
  assert.equal(report.android.total.r8, projectSize(states, data).total.r8);
});

test('the text report can be rendered without a terminal', () => {
  const report = buildSizeReport(process.cwd(), data);
  const text = formatSizeReport(report, {
    paint: (value) => value,
    version: '9.9.9',
  });
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(text, /^RNAP size 9\.9\.9$/m);
  assert.match(
    text,
    new RegExp(
      `RNAP ${escape(data.version)} · measured ${escape(data.measuredAt)}\\.`
    )
  );
});
