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
| **Desktop apps on a web view** (Electron, Tauri) | `react-native-anything-player/react` or `/web` | ◐ ¹ | ◐ ¹ | ◐ ¹ (no Google Cast) |
| Native desktop (macOS, Windows) | – | – | – | – (on the [roadmap](roadmap.md#desktop)) |
| Expo Go | – | – | – | – (no native code: `new Player()` throws `NATIVE_MODULE_MISSING`; use a development build) |

1. The web engine, with the column of the web view's engine below: Chromium in Electron and in Tauri on Windows, Safari in Tauri on macOS. Expected, not yet tested; see [Desktop](desktop.md).

See [Getting started](getting-started.md) for React Native and Expo, [Web](web.md) for the three web entries and [Desktop](desktop.md) for Electron and Tauri.

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
| **Chromium** | Blink | Chrome, Edge, Opera, Samsung Internet and most Android browsers; Electron and Tauri on Windows (no Google Cast) | ✓ (Playwright Chromium) |
| **Firefox** | Gecko | Firefox on desktop and Android | ✓ (Playwright Firefox) |
| **Safari** | WebKit on macOS | Safari on the Mac; Tauri on macOS | ✓ (Playwright WebKit) |
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
| Sleep timer (`sleep`, `status.sleepAt`) | ✓ | ✓ | ◐ ⁷ | ◐ ⁷ | ◐ ⁷ | ◐ ⁷ |
| Fades on play, pause and stop, `fadeTo` | ✓ | ✓ | ◐ ⁷ | ◐ ⁷ | ◐ ⁷ | – ⁶ |
| Separate quality files (`renditions`) switched with no gap, a pick that holds across loads | ✓ † ⁸ | ✓ † ⁸ | ✓ ⁸ | ✓ ⁸ | ✓ ⁸ | ✓ † ⁸ |
| Queue (next / previous, gapless) | – | – | – | – | – | – |

1. Leave it out with `rnapHls=false`.
2. The browser's own HLS where it has one (Chrome on Android), else [hls.js](web.md#hls), registered with `configureHls`.
3. `file://` URLs and paths; Android also takes `content://`.
4. `File` / `Blob`, `blob:` and `data:` URLs.
5. When RNAP reads the stream itself (MSE, hls.js), not on the plain `<audio>` element. On iPhone and iPad, from iOS 17.1.
6. The system fixes the volume: `setVolume` has no effect, `setMuted` works. Fades have no effect either; the sleep timer pauses without one.
7. In a hidden tab the browser runs timers less often: fades move in larger steps and the sleep timer can fire late.
8. Live streams (Icecast mounts at different bitrates): Android lines the switch up with what is heard, so it neither repeats nor skips; iOS and the web switch at once, and repeat or skip by the difference of the mounts' connect bursts ([#82](https://github.com/rmotafreitas/react-native-anything-player/issues/82)).

A queue is planned: see the [roadmap](roadmap.md).

## Internet radio

In browsers, RNAP reads a stream itself (Media Source Extensions) when the station sends CORS headers ([what to send](web.md#what-the-stream-server-must-send)); without them the stream plays on the plain `<audio>` element, with no titles. On iPhone and iPad that needs iOS 17.1 (Managed Media Source).

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| ICY titles, timed to when they are heard | ✓ | ✓ | ◐ ¹ | ◐ ¹ ² | ◐ ¹ | ◐ ¹ |
| Station name and genre (`icy-name`, `icy-genre`) | ✓ | ✓ | ◐ ¹ | ◐ ¹ | ◐ ¹ | ◐ ¹ |
| A dropped connection replaced without stopping (`discontinuity`) | ✓ | ✓ | ◐ ¹ | ◐ ¹ | ◐ ¹ | ◐ ¹ |
| `liveOffset` (how far behind live) | ✓ | ✓ | ◐ ¹ ³ | ◐ ¹ ³ | ◐ ¹ | ◐ ¹ |
| HLS / ID3 timed metadata | ✓ | ✓ | ◐ ³ | ◐ ³ | – ⁴ | – ⁴ |
| One connection per stream, closed on release | ✓ | ✓ | ◐ ¹ | ◐ ¹ | ◐ ¹ | ◐ ¹ |

1. For streams RNAP reads (with CORS); the plain element has no titles, no `liveOffset`, and manages its own connections.
2. Firefox takes MP3 and AAC only inside MP4: RNAP repackages the stream as it arrives ([how](web.md#mp3-and-aac-in-mp4-firefox)).
3. Through hls.js.
4. Safari plays HLS itself and hands its ID3 tags to no page.

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

## Video

A `Player` with a picture ([guide](video.md), [subtitles](subtitles.md)).

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| `<VideoView>` / `attachTo`, files and HLS | ✓ ² | ✓ ¹ | ✓ ³ | ✓ ³ | ✓ | ✓ † |
| DASH | ◐ ² ⁶ | ✓ ¹ | ✓ ⁷ | ✓ ⁷ | ✓ ⁷ | ✓ ⁷ † |
| Matroska, WebM and MPEG-TS (files and live channels), their audio languages and subtitles | ✓ ² ⁸ | ✓ ¹ | ✓ ⁸ | ✓ ⁸ | ✓ ⁸ | ✓ ⁸ † |
| Quality caps (the view, metered networks, Data Saver) and `selectQuality` | ✓ ² | ◐ ¹ ¹⁴ | ✓ ³ | ✓ ³ | ◐ ⁴ | ◐ ⁴ † |
| Separate quality files switched behind the picture | ✓ ² | ✓ ¹ | ✓ | ✓ | ✓ | ✓ † |
| The source's audio languages and subtitles | ✓ ² | ✓ ¹ | ✓ ³ | ✓ ³ | ✓ | ✓ † |
| Subtitle files (SubRip, WebVTT, TTML, ASS) in one overlay, `useCues()` | ✓ ² | ✓ ¹ | ✓ | ✓ | ✓ | ✓ † |
| The OS's caption style | ✓ ² | ✓ ¹ | – | – | – | – |
| Fullscreen | ✓ ² | ✓ ¹ | ✓ | ✓ | ✓ | ◐ ⁵ † |
| Picture in Picture, `whenBackgrounded: 'pip'` | ✓ ² | ✓ ¹ | ✓ | – | ✓ | ✓ † |
| `nativeControls` | ✓ ² (AVKit's) | ✓ ¹ (RNAP's) | ✓ | ✓ | ✓ | ✓ † |
| On a Cast receiver, with the app's subtitle files | ✓ ² † | ✓ ¹ † | ✓ † | – | – | – |
| Software decoders for codecs the device lacks (Dolby, DTS and MPEG audio, VP9, AV1) | – | ✓ ¹ ¹² | – | – | – | – |
| A video's sound it cannot decode: the picture plays, a non-fatal error names the codec | ◐ ² ¹³ | ✓ ¹ | ✓ | ✓ | ✓ | ✓ † |
| DRM: license servers, Clear Key keys in the source, or the app's `getLicense` | ◐ ² ⁹ | ✓ ¹ ¹⁰ | ✓ ¹¹ | ✓ ¹¹ | ◐ ⁹ † | ◐ ⁹ † |

1. Opt-in: a build option (`video` in the Expo plugin, `npx rnap add video`). Tried on the Android emulator (a file, separate quality files with SubRip, HLS with two audio languages and WebVTT subtitles, Picture in Picture, fullscreen, controls); not yet on a device †.
2. Opt-in, as on Android. Written and compiled in CI; not yet run on a simulator or device †.
3. HLS with hls.js ([`configureHls`](web.md#hls)); a video player takes it over Chromium's own HLS, which lists no tracks or qualities.
4. Safari's own HLS picks its quality itself: no caps or pins there. Separate quality files are RNAP's to switch, under every cap.
5. iPhone Safari's fullscreen is the system player, with its own controls and captions.
6. CMAF DASH (fragmented MP4 segments), rewritten as HLS for AVPlayer; a manifest addressed by byte ranges (`SegmentBase`) is refused.
7. With Shaka Player ([`configureShaka`](web.md#dash)).
8. Remuxed (nothing is decoded): the platform needs the codecs, and on the web the server needs CORS. Chromium takes no MP3 inside these; AC-3 and E-AC-3 play on Apple devices only ([Video](video.md#matroska-webm-and-mpeg-ts)).
9. FairPlay only, with HLS ([DRM](video.md#drm)).
10. Widevine, PlayReady or Clear Key, whichever the device has; Clear Key tried on the emulator.
11. Widevine, PlayReady or Clear Key, whichever the browser has, through Media Source Extensions (HLS with hls.js, DASH with Shaka); Clear Key in CI.
12. A build option (`videoDecoders` in the Expo plugin, `npx rnap add video-decoders`), used only for what the device cannot decode. The sound decoders were tried on the emulator; the VP9 and AV1 pictures render wrongly on emulators and are not yet tried on a device †.
13. The picture plays without the sound, but no error says why yet.
14. A cap that changes which HLS or DASH variants ExoPlayer may pick can make it drop what it buffered and rebuffer briefly.

### Audio features on a video player

A video `Player` is the same player with a picture: the engine's rules hold for it too. What differs from an audio player:

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| Rate, volume, mute, loop | ✓ † | ✓ | ✓ | ✓ | ✓ | ◐ ¹ † |
| Sleep timer, fades | ✓ † | ✓ | ◐ ² | ◐ ² | ◐ ² | ◐ ¹ ² † |
| Recovery (stalls, reconnects, give-up), refresh of expiring URLs | ✓ † | ✓ | ✓ | ✓ | ✓ | ✓ † |
| Lock screen, notification, media keys | ✓ ³ † | ✓ ³ | ✓ ³ | ✓ ³ | ✓ ³ | ✓ ³ † |
| Audio focus, calls, ducking | ✓ ⁴ † | ✓ ⁴ | – | – | – | – |
| Background playback | ◐ ⁵ † | ◐ ⁵ | ◐ ⁶ | ◐ ⁶ | ◐ ⁶ | ◐ ⁶ † |
| HLS / ID3 timed metadata | ✓ † | ✓ | ✓ ⁷ | ✓ ⁷ | – ¹¹ | – ¹¹ |
| ICY titles of an internet radio stream | – ⁸ | ✓ | – ⁸ | – ⁸ | – ⁸ | – ⁸ |
| Visualizer (`audioSample`) | ◐ ⁹ † | ✓ | – ¹⁰ | – ¹⁰ | – ¹⁰ | – ¹⁰ |

1. The system fixes the volume: `setVolume` and fades have no effect; the sleep timer pauses without a fade.
2. In a hidden tab the browser runs timers less often: fades move in larger steps and the sleep timer can fire late.
3. Play, pause and, on demand, seeking. Skips reach your app when you ask for them (`mediaSession.commands`). A muted or `ambient` player shows none (`focusWhenMuted`).
4. A muted video takes no focus, so it never pauses other apps' audio (`focusWhenMuted`).
5. `whenBackgrounded`: `pause` (the default), `audio` (the sound goes on, the picture stops) or `pip`.
6. `whenBackgrounded` defaults to `audio` on the web: a hidden tab plays on while it lives.
7. Through hls.js.
8. A video player reads no ICY titles: play radio with an audio `Player`, which has them everywhere.
9. Files; not streams or HLS.
10. A `<video>` is never routed through Web Audio.
11. Safari plays HLS itself and hands its ID3 tags to no page.

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

## Cars and watches

| | iOS | Android | Chromium | Firefox | Safari | iPhone, iPad |
|---|---|---|---|---|---|---|
| Groups in the catalog; `searchCatalog` by `group` | ✓ | ✓ | ✓ ¹ | ✓ ¹ | ✓ ¹ | ✓ ¹ |
| Browse tree in the car: CarPlay, Android Auto, Android Automotive OS | ✓ † ² | ✓ † ³ | – | – | – | – |
| Browse tree on a watch | – ⁴ | ✓ † ⁵ | – | – | – | – |
| Recently played, favorites in the tree | ✓ † | ✓ † | – | – | – | – |
| Playing from the tree reported to JS (`searchPlay`, `origin: 'browse'`) | ✓ † | ✓ † | – | – | – | – |
| Now Playing on the watch | ✓ † ⁶ | ✓ † ⁵ | – | – | – | – |

1. The same matcher and the same group rules as on the phone ([test cases](../conformance/catalog/browse.json)). The web keeps the groups and favorites; it has no car or watch screen.
2. CarPlay: opt-in (`car` in the Expo plugin, `RNAP_CAR=1`), and it needs Apple's CarPlay audio entitlement.
3. Android Auto: opt-in (`car`, `rnapCar=true`). Android Automotive OS needs an automotive build of the app. The tree is the same.
4. Apple Watch has no media browser for another app's audio; start the station from the phone or CarPlay.
5. Wear OS uses the phone's media library and session. Not tried on a watch.
6. Through the phone's Now Playing.

See [Cars & watches](cars-and-watches.md).

## Setup and tooling

| | iOS | Android | Web (every engine) |
|---|---|---|---|
| Expo config plugin | ✓ | ✓ | – (nothing to configure) |
| `npx rnap doctor` / `init` | ✓ | ✓ | ◐ stream URL checks (CORS, ICY) |
| `npx rnap add` / `remove` (build modules) | ✓ | ✓ | – (a page downloads Cast, HLS and the MP4 remuxer only when it uses them) |
| TypeScript types | ✓ | ✓ | ✓ |
| Zero runtime JS dependencies | ✓ | ✓ | ✓ (hls.js is optional and yours to add) |
| Size in a release build | not measured yet | about 1.2 MB of a release APK, with R8 ([measured](comparison.md#added-to-a-release-apk)) | about 56 KB of JS on page load ([measured](comparison.md#react-and-plain-web-pages)) |
