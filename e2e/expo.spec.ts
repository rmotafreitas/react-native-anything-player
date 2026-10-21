import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// The Expo example on the web (React Native Web): its integration scenarios
// (example/src/scenarios.ts), written for the native engines, run unchanged
// against the browser engine through the public API.
const EXPORT = path.join(__dirname, '../example-expo/dist-web/index.html');

test('runs the native integration scenarios on Expo web', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== 'chromium',
    'Scenarios need ICY over MSE; one engine run is enough'
  );
  test.skip(
    !fs.existsSync(EXPORT),
    'Build the export first: scripts/build-expo-web.sh'
  );
  test.setTimeout(8 * 60_000);
  const lines: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (text.startsWith('[RNAPTest]'))
      lines.push(text.slice('[RNAPTest] '.length));
  });
  await page.goto('http://localhost:4400/');
  await page.getByRole('button', { name: 'Run all' }).click();
  await expect
    .poll(() => lines.find((l) => l.startsWith('DONE')), {
      timeout: 7 * 60_000,
      intervals: [1_000],
    })
    .toBeTruthy();
  const failures = lines.filter(
    (l) => l.startsWith('FAIL') || l.startsWith('  trace')
  );
  expect(failures, failures.join('\n')).toEqual([]);
  expect(lines.find((l) => l.startsWith('DONE'))).toMatch(/failed=0/);
});
