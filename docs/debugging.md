# Debugging & troubleshooting

## Diagnostics

The engine keeps its last ~300 decisions in a native ring buffer, **always on** and cheap. Read it any time — including after something went wrong in the background:

```ts
for (const e of player.getDiagnostics()) {
  console.log(new Date(e.time).toISOString(), `g${e.generation}`, e.state, e.event, e.details);
}
```

```
…:14.688 g0 idle    load        {"uri":"https://…/live.mp3","autoplay":"true"}
…:14.689 g1 loading transition  {"from":"idle","to":"loading","cause":"load"}
…:15.892 g1 buffering transition {"from":"loading","to":"buffering","cause":"ready"}
…:15.901 g1 playing transition  {"from":"buffering","to":"playing","cause":"audio flowing"}
…:24.164 g1 playing failure     {"code":"STREAM_ENDED","recoverable":"true","message":"…"}
…:24.165 g1 reconnecting transition {"cause":"STREAM_ENDED — attempt 1 in 896ms", …}
…:25.062 g1 reconnecting reopen {"reason":"reconnect: backoff elapsed"}
```

`generation` increments on every open; `stale event dropped` entries show native events from replaced items being rejected. Attach this trace to bug reports.

`player.setDiagnosticsEnabled(true)` (or `new Player({ diagnostics: true })`) additionally streams entries as `diagnostic` events and to the native log:

- iOS: unified log, subsystem `com.radioanimu.airwave` (Console.app, or `xcrun simctl spawn booted log stream --predicate 'subsystem == "com.radioanimu.airwave"' --level debug`). Now Playing publications and remote commands are logged there at debug level even without diagnostics.
- Android: logcat tag `Airwave` (`adb logcat Airwave:V '*:S'`).

Nothing is logged at default levels in production.

## Inspecting the system's view (Android)

```sh
adb shell dumpsys media_session | sed -n '/<your.package>/,/^  [a-z]/p'   # session state + metadata
adb shell dumpsys activity services <your.package>                         # isForeground, type
adb shell dumpsys audio | grep -A3 "Audio Focus stack"                     # who holds focus
adb shell input keyevent KEYCODE_MEDIA_PAUSE                               # hardware media keys
adb shell dumpsys deviceidle force-idle                                    # Doze
adb shell svc wifi disable && adb shell svc data disable                   # offline
```

## Troubleshooting

**Nothing plays on iOS in the background / audio stops when locking.** The `audio` background mode is missing (Expo: add the config plugin and rebuild; bare: `UIBackgroundModes`).

**`INVALID_SOURCE: Cleartext HTTP is blocked…`** Use `https`, or allow the host: iOS `NSAppTransportSecurity` exception; Android `android:networkSecurityConfig` with a `domain-config cleartextTrafficPermitted="true"`. Debug builds are often permissive and release builds are not.

**`AUDIO_FOCUS_DENIED` on `play()`.** A call or another app holds audio focus. On Android 15+, starting playback from the background without a foreground service is also denied; Airwave retries after the media service is promoted, and reports `interruption.reason: 'audio-focus-delayed'` meanwhile.

**The lock screen shows nothing (iOS).** `audio.mixWithOthers: true` disables Now Playing on iOS. Also check `mediaSession.enabled`.

**The play button flickers / spinner flashes.** Render the button from `status.playWhenReady`, not `state === 'playing'`.

**Metadata shows `Title - Artist` swapped.** Set `metadata.streamTitleFormat: 'title-artist'` for that station.

**A radio resumes from where it was paused instead of live.** That is intentional for pauses shorter than `recovery.liveMaxDriftMs` (5 s). Lower it if you need strict live.

**The app traps at launch on iOS 27 (`NoSceneLifecycleAdoption` in the crash report).** Not Airwave-specific: iOS 27 requires the scene life cycle. The React Native 0.86 template and Expo SDK 57's prebuild template still create the window in the app delegate. Bare apps: move window creation to a `UIWindowSceneDelegate` (see `example/ios/AirwaveExample/AppDelegate.swift`). Expo SDK 57: use SDK 58's template, or a config plugin that subclasses `ExpoAppSceneDelegate` (see `example-expo/plugins/withSceneLifecycle.js`).

**Expo Go says the native module is missing.** Expected — use a development build.

**`Invariant Violation: "<App>" has not been registered` while developing several RN apps.** Two Metro servers on port 8081; run one per port (`--port`), and on Android pass `-PreactNativeDevServerPort` (the emulator reaches the host as `10.0.2.2`, bypassing `adb reverse`).

## FAQ

**Does it work with Expo?** Yes, in development builds and EAS/prebuild, with the config plugin. Not in Expo Go.

**Does it need the New Architecture?** Yes (it is a TurboModule); RN ≥ 0.80.

**Can I use several players?** Yes; each is an independent native engine. The lock screen follows the most recently started one; Android audio focus is shared.

**Do players stop when a component unmounts?** No. Create them at module scope and `release()` them explicitly.

**What happens on a JS reload (Fast Refresh, dev menu)?** Native releases the players created by the old JS instance (no zombie audio, no orphaned connections), and the new JS starts fresh.

**Queues / playlists?** Not built in. Load the next item on `ended`; `load()` while playing switches seamlessly.

**Caching / offline downloads?** Not built in — download files yourself and play the `file://` URI.

**Is it open source?** It is source-available under PolyForm Noncommercial 1.0.0: free for noncommercial use, commercial use needs a license ([COMMERCIAL.md](../COMMERCIAL.md)).
