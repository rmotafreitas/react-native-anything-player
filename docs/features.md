# Feature matrix

What works where. **✓** works, **◐** works with the limits in the note, **–** not available there. **†** marks what is built and covered by tests but not yet exercised on real hardware (see [Testing](testing.md)).

## Where RNAP runs

The web column below covers three ways to use the same browser engine. They differ only in how you write your UI:

| | Import | `Player` and app API | Hooks | `<RoutePicker />`, `<CastButton />` |
|---|---|---|---|---|
| **iOS, Android** (React Native, Expo dev builds) | `react-native-anything-player` | ✓ | ✓ | ✓ (native views and buttons) |
| **Expo web, React Native Web** | `react-native-anything-player` | ✓ | ✓ | ✓ (React Native Web buttons) |
| **React** (react-dom: Vite, Next.js, Create React App) | `react-native-anything-player/react` | ✓ | ✓ | ✓ (`<button>`s, `className` and `style`) |
| **Any web page** (no framework) | `react-native-anything-player/web` | ✓ | – | – (call `showRoutePicker()` / `showCastPicker()` from your own button) |
| Expo Go | – | – | – | – (no native code: `new Player()` throws `NATIVE_MODULE_MISSING`; use a development build) |

See [Getting started](getting-started.md) for React Native and Expo, and [Web](web.md) for the three web entries.

## Playback

| | iOS | Android | Web |
|---|---|---|---|
| Files over HTTP(S), seeking | ✓ | ✓ | ✓ |
| Live streams, internet radio | ✓ | ✓ | ✓ |
| HLS (`.m3u8`) | ✓ | ✓ (leave out with `rnapHls=false`) | ◐ Safari natively; other browsers with [hls.js](web.md#hls) (`configureHls`) |
| Local files | ✓ `file://`, paths | ✓ `file://`, paths, `content://` | ✓ `File` / `Blob`, `blob:` and `data:` URLs |
| Bundled assets (`require('./a.mp3')`) | ✓ | ✓ | – pass a URL |
| Request headers on a source | ✓ | ✓ | ◐ when RNAP reads the stream (MSE, hls.js); not on the plain `<audio>` element |
| Volume, mute, rate | ✓ | ✓ | ◐ iOS Safari fixes the volume (`setMuted` works) |
| Several players at once | ✓ | ✓ | ✓ |
| Progress events, `getProgress()` | ✓ | ✓ | ✓ |
| Queue (next / previous, gapless) | – | – | – (planned: [roadmap](roadmap.md)) |

## Internet radio

| | iOS | Android | Web |
|---|---|---|---|
| ICY titles, timed to when they are heard | ✓ | ✓ | ◐ needs CORS headers from the station ([what to send](web.md#what-the-stream-server-must-send)); Firefox through an MP4 repackaging |
| Station name and genre (`icy-name`, `icy-genre`) | ✓ | ✓ | ◐ with CORS |
| A dropped connection replaced without stopping (`discontinuity`) | ✓ | ✓ | ◐ for streams read through MSE |
| `liveOffset` (how far behind live) | ✓ | ✓ | ◐ MSE streams and HLS; `null` on the plain element |
| HLS / ID3 timed metadata | ✓ | ✓ | ◐ through hls.js or Safari |
| One connection per stream, closed on release | ✓ | ✓ | ◐ MSE streams; the plain element manages its own |

## Recovery

| | iOS | Android | Web |
|---|---|---|---|
| Stall and dead-socket detection, backoff, offline probing, live-edge re-open, give-up | ✓ | ✓ | ✓ (one engine, [the same conformance suite](../conformance/README.md)) |
| Wi-Fi ↔ cellular handoff | ✓ | ✓ | ◐ Chromium (Network Information API) |
| Keeps recovering in the background | ✓ (near-silent keepalive) | ✓ (foreground service, locks) | ◐ while the tab plays; a mobile browser may suspend a background tab |

## System integration

| | iOS | Android | Web |
|---|---|---|---|
| Background playback | ✓ | ✓ | ◐ while the tab lives |
| Lock screen, notification, media keys, headsets | ✓ | ✓ | ✓ (Media Session) |
| Next / previous / skip forwarded to JS | ✓ | ✓ | ✓ |
| Play from the lock screen with nothing loaded | ✓ | ✓ | ✓ |
| Calls, other apps, audio focus, ducking | ✓ | ✓ | – (browsers have no audio focus) |
| Pause when headphones are unplugged | ✓ † | ✓ † | – (up to the browser) |
| Media services reset | ✓ | – (iOS only) | – |
| Autoplay policy (`AUTOPLAY_BLOCKED`) | – | – | ✓ |
| Apple Watch, Wear OS controls | ✓ † (through the phone's session) | ✓ † | – |
| Visualizer (`audioSample`) | ✓ files and streams; not HLS | ✓ | ◐ streams read through MSE |
| Diagnostics trace | ✓ | ✓ | ✓ |

## Outputs and casting

| | iOS | Android | Web |
|---|---|---|---|
| `status.route`, `routeChange` | ✓ | ✓ (the selected output on Android 13+) | ◐ `unknown` locally; `airplay`, `cast` |
| Output picker (`<RoutePicker />`) | ✓ AirPlay button † | ✓ Output Switcher † | ◐ AirPlay in Safari †; Remote Playback in Chrome (not for MSE streams) †; none in Firefox |
| AirPlay | ✓ † | – | ◐ Safari † |
| Google Cast | ✓ opt-in † | ✓ opt-in † | ◐ Chrome (desktop, Android) † |
| Radio titles while casting | ✓ † | ✓ † | ✓ † |

Cast is a build option (`cast` in the Expo plugin): apps that do not cast do not ship the Cast SDKs. See [Casting & AirPlay](routes-and-casting.md).

## Voice and search

| | iOS | Android | Web |
|---|---|---|---|
| Catalog search: `setCatalog`, `searchCatalog`, `playFromSearch` | ✓ | ✓ | ✓ (same matcher, [same test cases](../conformance/catalog/search.json)) |
| "Play X on MyApp" with the app closed | ✓ Siri † | ✓ Google Assistant, Gemini † | – |
| Siri shortcuts, Spotlight, Shortcuts app, Action button | ✓ iOS 16+ † | – | – |
| Speech in the page | – | – | ◐ wire the browser's speech recognition to `playFromSearch` ([example](voice.md#on-the-web)) |

See [Voice assistants](voice.md).

## Setup and tooling

| | iOS | Android | Web |
|---|---|---|---|
| Expo config plugin | ✓ | ✓ | – (nothing to configure) |
| `npx react-native-anything-player doctor` / `init` | ✓ | ✓ | ◐ stream URL checks (CORS, ICY) |
| TypeScript types | ✓ | ✓ | ✓ |
| Zero runtime JS dependencies | ✓ | ✓ | ✓ (hls.js is optional and yours to add) |
