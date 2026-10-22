# Feature matrix

What works where: on each operating system, and in each browser engine. **✓** works, **◐** works with the limits in the note, **–** not available there. **†** marks what is built and covered by tests but not yet exercised on real hardware (see [Testing](testing.md)).

## Where RNAP runs

The browser columns below cover three ways to use the same browser engine. They differ only in how you write your UI:

| | Import | `Player` and app API | Hooks | `<RoutePicker />`, `<CastButton />` |
|---|---|---|---|---|
| **iOS, Android** (React Native, Expo dev builds) | `react-native-anything-player` | ✓ | ✓ | ✓ (native views and buttons) |
| **Expo web, React Native Web** | `react-native-anything-player` | ✓ | ✓ | ✓ (React Native Web buttons) |
| **React** (react-dom: Vite, Next.js, Create React App) | `react-native-anything-player/react` | ✓ | ✓ | ✓ (`<button>`s, `className` and `style`) |
| **Any web page** (no framework) | `react-native-anything-player/web` | ✓ | – | – (call `showRoutePicker()` / `showCastPicker()` from your own button) |
| Expo Go | – | – | – | – (no native code: `new Player()` throws `NATIVE_MODULE_MISSING`; use a development build) |

See [Getting started](getting-started.md) for React Native and Expo, and [Web](web.md) for the three web entries.

## Platforms

### Operating systems

| | iOS, iPadOS | Android |
|---|---|---|
| Minimum | 15.1 | 7.0 (API 24) |
| React Native | 0.80 or later, New Architecture | 0.80 or later, New Architecture |
| Player | AVPlayer, behind RNAP's stream proxy | Media3 ExoPlayer |
| Later versions add | 16: Siri shortcuts, Spotlight, the Shortcuts app and the Action button | 13: the output in use in `status.route` (before: the best connected one) · 14: the system Output Switcher (before: AndroidX's switcher dialog where the device has one, else the Bluetooth settings) |

### Browser engines

In a browser, what RNAP can do depends on the browser's engine, not its name. The columns below are the four that matter. On iPhone and iPad every browser runs Safari's engine (WebKit), Chrome and Firefox included, with the limits of iOS.

| Column below | Engine | Browsers | Tested on every change |
|---|---|---|---|
| **Chromium** | Blink | Chrome, Edge, Opera, Samsung Internet and most Android browsers | ✓ (Playwright Chromium) |
| **Firefox** | Gecko | Firefox on desktop and Android | ✓ (Playwright Firefox) |
| **Safari** | WebKit on macOS | Safari on the Mac | ✓ (Playwright WebKit) |
| **iPhone, iPad** | WebKit on iOS and iPadOS | Safari, Chrome, Firefox, Edge and every other browser there | – (Playwright's WebKit is the desktop engine) |

Supported: the current and previous version of each browser. Radio titles on iPhone and iPad need iOS 17.1 (Managed Media Source); before it, streams play without them.

## Playback

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| Files over HTTP(S), seeking | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Live streams, internet radio | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| HLS (`.m3u8`) | ✓ | ✓ ¹ | ◐ ² | ◐ ² | ✓ | ✓ |
| Local files | ✓ ³ | ✓ ³ | ✓ ⁴ | ✓ ⁴ | ✓ ⁴ | ✓ ⁴ |
| Bundled assets (`require('./a.mp3')`) | ✓ | ✓ | – | – | – | – |
| Request headers on a source | ✓ | ✓ | ◐ ⁵ | ◐ ⁵ | ◐ ⁵ | ◐ ⁵ |
| Volume, mute, rate | ✓ | ✓ | ✓ | ✓ | ✓ | ◐ ⁶ |
| Several players at once | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Progress events, `getProgress()` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Queue (next / previous, gapless) | – | – | – | – | – | – |

1. Leave it out with `rnapHls=false`.
2. The browser's own HLS where it has one (Chrome on Android), else [hls.js](web.md#hls), registered with `configureHls`.
3. `file://` URLs and paths; Android also takes `content://`.
4. `File` / `Blob`, `blob:` and `data:` URLs.
5. When RNAP reads the stream itself (MSE, hls.js), not on the plain `<audio>` element. On iPhone and iPad, from iOS 17.1.
6. The system fixes the volume: `setVolume` has no effect, `setMuted` works.

A queue is planned: see the [roadmap](roadmap.md).

## Internet radio

In browsers, RNAP reads a stream itself (Media Source Extensions) when the station sends CORS headers ([what to send](web.md#what-the-stream-server-must-send)); without them the stream plays on the plain `<audio>` element, with no titles. On iPhone and iPad that needs iOS 17.1 (Managed Media Source).

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| ICY titles, timed to when they are heard | ✓ | ✓ | ◐ ¹ | ◐ ¹ ² | ◐ ¹ | ◐ ¹ |
| Station name and genre (`icy-name`, `icy-genre`) | ✓ | ✓ | ◐ ¹ | ◐ ¹ | ◐ ¹ | ◐ ¹ |
| A dropped connection replaced without stopping (`discontinuity`) | ✓ | ✓ | ◐ ¹ | ◐ ¹ | ◐ ¹ | ◐ ¹ |
| `liveOffset` (how far behind live) | ✓ | ✓ | ◐ ¹ ³ | ◐ ¹ ³ | ◐ ¹ | ◐ ¹ |
| HLS / ID3 timed metadata | ✓ | ✓ | ◐ ³ | ◐ ³ | ✓ | ✓ |
| One connection per stream, closed on release | ✓ | ✓ | ◐ ¹ | ◐ ¹ | ◐ ¹ | ◐ ¹ |

1. For streams RNAP reads (with CORS); the plain element has no titles, no `liveOffset`, and manages its own connections.
2. Firefox takes MP3 and AAC only inside MP4: RNAP repackages the stream as it arrives ([how](web.md#mp3-and-aac-in-mp4-firefox)).
3. Through hls.js.

## Recovery

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| Stall and dead-socket detection, backoff, offline probing, live-edge re-open, give-up | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Wi-Fi ↔ cellular handoff noticed | ✓ | ✓ | ✓ ¹ | – ² | – ² | – ² |
| Keeps recovering in the background | ✓ ³ | ✓ ³ | ◐ ⁴ | ◐ ⁴ | ✓ ⁴ | ◐ ⁴ |

1. Network Information API.
2. The engine recovers it as a stall instead.
3. iOS: a near-silent keepalive; Android: the foreground service and its locks.
4. While the tab plays. Android and iOS may suspend a background tab.

One engine on every column, held to [the same conformance suite](../conformance/README.md).

## System integration

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| Background playback | ✓ | ✓ | ◐ ¹ | ◐ ¹ | ◐ ¹ | ◐ ¹ |
| Lock screen, notification, media keys, headsets | ✓ | ✓ | ✓ ² | ✓ ² | ✓ ² | ✓ ² |
| Next / previous / skip forwarded to JS | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Play from the lock screen with nothing loaded | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Calls, other apps, audio focus, ducking | ✓ | ✓ | – ³ | – ³ | – ³ | – ³ |
| Pause when headphones are unplugged | ✓ † | ✓ † | – ⁴ | – ⁴ | – ⁴ | – ⁴ |
| Media services reset | ✓ | – | – | – | – | – |
| Autoplay policy (`AUTOPLAY_BLOCKED`) | – | – | ✓ | ✓ | ✓ | ✓ |
| Apple Watch, Wear OS controls | ✓ † ⁵ | ✓ † | – | – | – | – |
| Visualizer (`audioSample`) | ◐ ⁶ | ✓ | ◐ ⁷ | ◐ ⁷ | ◐ ⁷ | ◐ ⁷ |
| Diagnostics trace | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

1. While the tab lives.
2. Media Session.
3. Browsers have no audio focus.
4. Up to the browser.
5. Through the phone's session.
6. Files and streams; not HLS.
7. Streams RNAP reads and local files.

## Sound effects

`Sound` ([guide](sound.md)): short effects decoded into memory, played with low latency, many at once.

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| `Sound.load()`, `play()` with volume, rate, pan and loop | ✓ ¹ | ✓ ¹ | ✓ | ✓ | ✓ | ✓ |
| Several copies at once, the oldest stopped when all are busy | ✓ ¹ | ✓ ¹ | ✓ | ✓ | ✓ | ✓ |
| Mixes with other audio, no media session or audio focus | ✓ ¹ | ✓ ¹ | ✓ | ✓ | ✓ | ✓ |
| `respectSilentSwitch` | ✓ ¹ | – | – | – | – | – ² |
| Needs a user gesture (`AUTOPLAY_BLOCKED`) | – | – | ✓ | ✓ | ✓ | ✓ |
| Loads a `Blob` or `File` | – | – | ✓ | ✓ | ✓ | ✓ |
| Loads a `require()`d asset | ✓ ¹ | ✓ ¹ | ◐ ³ | ◐ ³ | ◐ ³ | ◐ ³ |

1. Opt-in: a build option (`sound` in the Expo plugin), so apps that play no effects do not ship it. Built and unit-tested; not yet exercised on a device †.
2. The browser decides: iPhone Safari silences Web Audio with the ringer switch.
3. In Expo web and React Native Web, through the bundler's asset URL; not in plain pages (pass a URL).

## Outputs and casting

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| `status.route`, `routeChange` | ✓ | ✓ ¹ | ◐ ² | ◐ ² | ◐ ² | ◐ ² |
| Output picker (`<RoutePicker />`) | ✓ † ³ | ✓ † ⁴ | ◐ † ⁵ | – ⁶ | ✓ † ³ | ✓ † ³ |
| AirPlay | ✓ † | – | – | – | ✓ † | ✓ † |
| Google Cast | ✓ † ⁷ | ✓ † ⁷ | ◐ † ⁸ | – | – | – ⁹ |
| Radio titles while casting | ✓ † | ✓ † | ✓ † | – | – | – |

1. The output in use from Android 13; before it, the best connected one.
2. `unknown` for the device's own output; `cast` (Chromium) and `airplay` (Safari, iPhone, iPad) for a receiver.
3. The AirPlay picker.
4. The system Output Switcher from Android 14; before it, AndroidX's switcher dialog where the device has one, else the Bluetooth settings.
5. Remote Playback; not for streams RNAP reads.
6. The component renders nothing.
7. Opt-in: a build option (`cast` in the Expo plugin), so apps that do not cast do not ship the Cast SDKs.
8. Chrome, on desktop and Android.
9. No Cast SDK in iOS browsers.

See [Casting & AirPlay](routes-and-casting.md).

## Voice and search

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| Catalog search: `setCatalog`, `searchCatalog`, `playFromSearch` | ✓ | ✓ | ✓ ¹ | ✓ ¹ | ✓ ¹ | ✓ ¹ |
| "Play X on MyApp" with the app closed | ✓ † ² | ✓ † ³ | – | – | – | – |
| Siri shortcuts, Spotlight, Shortcuts app, Action button | ✓ † ⁴ | – | – | – | – | – |
| Speech in the page | – | – | ◐ ⁵ | – | ◐ ⁵ | ◐ ⁵ |

1. The same matcher as on the phone, held to [the same test cases](../conformance/catalog/search.json).
2. Siri.
3. Google Assistant and Gemini.
4. iOS 16 and later.
5. Wire the browser's speech recognition to `playFromSearch` ([example](voice.md#on-the-web)). Firefox has none.

See [Voice assistants](voice.md).

## Setup and tooling

| | iOS | Android | Web (every engine) |
|---|---|---|---|
| Expo config plugin | ✓ | ✓ | – (nothing to configure) |
| `npx react-native-anything-player doctor` / `init` | ✓ | ✓ | ◐ stream URL checks (CORS, ICY) |
| TypeScript types | ✓ | ✓ | ✓ |
| Zero runtime JS dependencies | ✓ | ✓ | ✓ (hls.js is optional and yours to add) |
| Size in a release build | not measured yet | about 1.2 MB of a release APK, with R8 ([measured](comparison.md#added-to-a-release-apk)) | about 28 KB of JS on page load ([measured](comparison.md#react-and-plain-web-pages)) |
