import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addPlistArrayItem,
  parsePlist,
  removePlistArrayItem,
  setPlistString,
} from '../../bin/cli/plist.mjs';
import { unifiedDiff } from '../../bin/cli/diff.mjs';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Tom &amp; Jerry</string>
  <key>Count</key>
  <integer>3</integer>
  <key>Level</key>
  <real>1.5</real>
  <key>Enabled</key>
  <true/>
  <key>Disabled</key>
  <false/>
  <key>Modes</key>
  <array>
    <string>audio</string>
    <string>fetch</string>
  </array>
  <key>Nested</key>
  <dict>
    <key>Inner</key>
    <array>
      <integer>1</integer>
      <dict>
        <key>Deep</key>
        <string>yes</string>
      </dict>
    </array>
  </dict>
  <!-- comments are skipped -->
</dict>
</plist>
`;

test('parses the plist types RNAP checks read', () => {
  const value = parsePlist(SAMPLE);
  assert.equal(value.CFBundleName, 'Tom & Jerry');
  assert.equal(value.Count, 3);
  assert.equal(value.Level, 1.5);
  assert.equal(value.Enabled, true);
  assert.equal(value.Disabled, false);
  assert.deepEqual(value.Modes, ['audio', 'fetch']);
  assert.deepEqual(value.Nested, { Inner: [1, { Deep: 'yes' }] });
});

test('rejects malformed XML instead of returning half a plist', () => {
  assert.throws(() =>
    parsePlist('<plist><dict><key>a</key><string>b</dict></plist>')
  );
  assert.throws(() => parsePlist('<plist><dict><key>a</key></plist>'));
  assert.throws(() => parsePlist('<plist><dict><key>a</key></dict></plist>'));
});

test('decodes numeric character references', () => {
  const value = parsePlist(
    '<plist><dict><key>Name</key><string>caf&#233;</string></dict></plist>'
  );
  assert.equal(value.Name, 'café');
});

test('appends to an existing array and keeps the rest of the file', () => {
  const before = SAMPLE;
  const after = addPlistArrayItem(before, 'Modes', 'location');
  assert.match(
    after,
    /<string>audio<\/string>\n {4}<string>fetch<\/string>\n {4}<string>location<\/string>/
  );
  assert.equal(parsePlist(after).Modes.at(-1), 'location');
  assert.equal(parsePlist(after).CFBundleName, 'Tom & Jerry');
  assert.match(after, /<key>Nested<\/key>/);
});

test('adds a missing key as a new array before the root close', () => {
  const before = `<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n\t<key>A</key>\n\t<true/>\n</dict>\n</plist>\n`;
  const after = addPlistArrayItem(before, 'UIBackgroundModes', 'audio');
  assert.match(
    after,
    /\t<key>UIBackgroundModes<\/key>\n\t<array>\n\t\t<string>audio<\/string>\n\t<\/array>\n<\/dict>/
  );
  assert.deepEqual(parsePlist(after), {
    A: true,
    UIBackgroundModes: ['audio'],
  });
});

test('is idempotent, and debugs can run without colours', () => {
  const once = addPlistArrayItem(SAMPLE, 'Modes', 'audio');
  assert.equal(once, null);
  assert.equal(unifiedDiff('a', 'same\n', 'same\n'), '');
});

test('refuses to replace a scalar with an array', () => {
  const before =
    '<plist><dict><key>Modes</key><string>audio</string></dict></plist>';
  assert.throws(() => addPlistArrayItem(before, 'Modes', 'audio'));
});

test('removes one array item and keeps the rest of the array', () => {
  const after = removePlistArrayItem(SAMPLE, 'Modes', 'fetch');
  assert.match(
    after,
    /<key>Modes<\/key>\n {2}<array>\n {4}<string>audio<\/string>\n {2}<\/array>/
  );
  assert.deepEqual(parsePlist(after).Modes, ['audio']);
  assert.equal(parsePlist(after).CFBundleName, 'Tom & Jerry');
});

test('removing the last array item drops the key and the empty array', () => {
  const before = `<?xml version="1.0"?>
<plist version="1.0">
<dict>
\t<key>A</key>
\t<true/>
\t<key>UIBackgroundModes</key>
\t<array>
\t\t<string>audio</string>
\t</array>
</dict>
</plist>
`;
  const after = removePlistArrayItem(before, 'UIBackgroundModes', 'audio');
  assert.equal(parsePlist(after).UIBackgroundModes, undefined);
  assert.equal(parsePlist(after).A, true);
  assert.doesNotMatch(after, /UIBackgroundModes/);
});

test('removing an item that is not there changes nothing', () => {
  assert.equal(removePlistArrayItem(SAMPLE, 'Modes', 'location'), null);
  assert.equal(removePlistArrayItem(SAMPLE, 'Missing', 'audio'), null);
  assert.equal(removePlistArrayItem(SAMPLE, 'Count', 3), null);
});

test('sets a string, escaping what XML cannot hold', () => {
  const after = setPlistString(SAMPLE, 'CFBundleName', 'Tom & Jerry <3');
  assert.equal(parsePlist(after).CFBundleName, 'Tom & Jerry <3');
  assert.match(after, /Tom &amp; Jerry &lt;3/);
  assert.equal(setPlistString(SAMPLE, 'CFBundleName', 'Tom & Jerry'), null);
});

test('adds a missing string key before the root close', () => {
  const before = `<?xml version="1.0"?>
<plist version="1.0">
<dict>
\t<key>A</key>
\t<true/>
</dict>
</plist>
`;
  const after = setPlistString(before, 'NSLocalNetworkUsageDescription', 'Find');
  assert.equal(parsePlist(after).NSLocalNetworkUsageDescription, 'Find');
  assert.match(
    after,
    /\t<key>NSLocalNetworkUsageDescription<\/key>\n\t<string>Find<\/string>\n<\/dict>/
  );
  assert.throws(() => setPlistString(SAMPLE, 'Count', 'many'));
});

test('unified diff shows changed lines with context and correct headers', () => {
  const diff = unifiedDiff(
    'app.json',
    '{\n  "a": 1,\n  "b": 2,\n  "c": 3,\n  "d": 4,\n  "e": 5\n}\n',
    '{\n  "a": 1,\n  "b": 2,\n  "c": 30,\n  "d": 4,\n  "e": 5\n}\n'
  );
  assert.match(
    diff,
    /^--- a\/app\.json\n\+\+\+ b\/app\.json\n@@ -1,7 \+1,7 @@/
  );
  assert.match(diff, /^-  "c": 3,$/m);
  assert.match(diff, /^\+  "c": 30,$/m);
  assert.match(diff, /^   "d": 4,$/m);
});
