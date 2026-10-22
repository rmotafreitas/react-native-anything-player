// Android checks: SDK levels, the Cast switch, and the Assistant intent.

import { parseProperties } from '../project.mjs';
import { finding } from '../findings.mjs';
import { relative } from '../util.mjs';

const MIN_SDK = 24;
const COMPILE_SDK = 36;
const PLAY_FROM_SEARCH = 'android.media.action.MEDIA_PLAY_FROM_SEARCH';

function sdkLevel(text, name) {
  const match = new RegExp(`${name}\\s*(?:=\\s*)?(\\d+)\\b`).exec(
    String(text ?? '')
  );
  return match ? Number(match[1]) : null;
}

function androidPath(ctx, file) {
  return relative(ctx.cwd, file);
}

function mainActivityBlock(manifest) {
  const match = /<activity\b[^>]*android:name="[^"]*\.?MainActivity"[^>]*>([\s\S]*?)<\/activity>/.exec(
    String(manifest ?? '')
  );
  return match ? match[1] : null;
}

function hasAssistantFilter(manifest) {
  const block = mainActivityBlock(manifest);
  return Boolean(block && block.includes(PLAY_FROM_SEARCH));
}

function handleIntentCalls(text) {
  return /AnythingPlayer\.handleIntent\s*\(/.test(String(text ?? ''));
}

function checkSdks(ctx, findings) {
  const gradle = ctx.android.buildGradle ?? '';
  const app = ctx.android.appBuildGradle ?? '';
  const minSdk = sdkLevel(gradle, 'minSdkVersion');
  const compileSdk =
    sdkLevel(gradle, 'compileSdkVersion') ?? sdkLevel(gradle, 'compileSdk');

  if (minSdk !== null && minSdk < MIN_SDK) {
    findings.push(
      finding(
        'android-minsdk',
        'error',
        `minSdkVersion ${minSdk} is below API ${MIN_SDK} (Android 7.0), the minimum RNAP supports (docs/getting-started.md).`,
        {
          file: 'android/build.gradle',
          change: `set minSdkVersion = ${MIN_SDK}`,
        }
      )
    );
  }
  if (compileSdk !== null && compileSdk < COMPILE_SDK) {
    findings.push(
      finding(
        'android-compilesdk',
        'warning',
        `compileSdkVersion ${compileSdk} is older than ${COMPILE_SDK}, which RNAP compiles against; its Media3 dependency may not build.`,
        {
          file: 'android/build.gradle',
          change: `set compileSdkVersion = ${COMPILE_SDK}`,
        }
      )
    );
  }
  // A version pinned in app/build.gradle can disagree with the root ext block.
  const appMin = sdkLevel(app, 'minSdkVersion');
  if (minSdk === null && appMin !== null && appMin < MIN_SDK) {
    findings.push(
      finding(
        'android-minsdk',
        'error',
        `minSdkVersion ${appMin} is below API ${MIN_SDK} (Android 7.0), the minimum RNAP supports (docs/getting-started.md).`,
        {
          file: 'android/app/build.gradle',
          change: `set minSdkVersion ${MIN_SDK}`,
        }
      )
    );
  }
}

function checkCast(ctx, findings) {
  const enabled = parseProperties(ctx.android.gradlePropertiesText).rnapCast === 'true';
  const iosWantsCast = Boolean(
    ctx.ios.podfileProperties?.['rnap.cast'] === 'true' ||
      ctx.expo.options?.cast
  );
  if (!iosWantsCast || enabled) return;
  findings.push(
    finding(
      'android-cast',
      'warning',
      'Cast is on for iOS (or the plugin), but `rnapCast` is not `true` here: Android builds without the Cast SDK, so the Cast button reports unavailable.',
      {
        file: 'android/gradle.properties',
        change: 'add `rnapCast=true`, then rebuild the app (docs/routes-and-casting.md)',
      }
    )
  );
}

function checkAssistant(ctx, findings) {
  // Expo: the plugin adds the filter and the MainActivity lines.
  if (ctx.isExpo && !ctx.android.present) {
    const options = ctx.expo.options;
    if (ctx.rnapPlugin && options?.assistant === false) {
      findings.push(
        finding(
          'android-assistant',
          'info',
          'Google Assistant and Gemini integration is off (`assistant: false`).',
          null
        )
      );
    }
    return;
  }
  if (!ctx.android.present) return;
  if (ctx.isExpo && ctx.rnapPlugin && ctx.expo.options?.assistant !== false) {
    // Prebuilt output should already contain what the plugin adds.
    if (ctx.android.manifest && !hasAssistantFilter(ctx.android.manifest)) {
      findings.push(
        finding(
          'android-assistant',
          'warning',
          'The plugin adds the Google Assistant intent filter, but the prebuilt AndroidManifest.xml does not have it: the native project is stale.',
          {
            file: 'android/app/src/main/AndroidManifest.xml',
            change: 'run `npx expo prebuild --clean`, then rebuild',
          }
        )
      );
    }
    return;
  }

  const filter = hasAssistantFilter(ctx.android.manifest);
  const handleIntent = handleIntentCalls(ctx.android.mainActivity);
  if (filter && handleIntent) return;

  const missing = [];
  if (!filter) missing.push('the `MEDIA_PLAY_FROM_SEARCH` intent filter');
  if (!handleIntent) missing.push('`AnythingPlayer.handleIntent` in onCreate and onNewIntent');
  const file =
    (filter ? ctx.android.mainActivityFile : ctx.android.manifestFile) ??
    ctx.android.manifestFile;

  findings.push(
    finding(
      'android-assistant',
      filter || handleIntent ? 'error' : 'warning',
      `Google Assistant and Gemini cannot start playback: the main activity is missing ${missing.join(' and ')} (docs/voice.md).`,
      {
        file: androidPath(ctx, file),
        change: filter
          ? 'add the import and call `AnythingPlayer.handleIntent(this, intent)` after `super.onCreate(…)` and in `onNewIntent` (docs/voice.md)'
          : 'add the `MEDIA_PLAY_FROM_SEARCH` intent filter to the main activity (docs/voice.md)',
      }
    )
  );
}

export function androidChecks(ctx) {
  const findings = [];
  if (!ctx.android.present) {
    if (!ctx.isExpo) return findings;
    // Expo before prebuild: the plugin options are what matter.
    checkAssistant(ctx, findings);
    return findings;
  }
  checkSdks(ctx, findings);
  checkCast(ctx, findings);
  checkAssistant(ctx, findings);
  return findings;
}
