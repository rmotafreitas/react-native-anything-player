# Desktop

RNAP has no native desktop build yet. Desktop apps built on a web view (Electron, Tauri) run its [web engine](web.md), with the same `Player`, events and recovery rules as a browser. Native macOS and Windows are on the [roadmap](roadmap.md#desktop).

| Desktop app | How | Status |
|---|---|---|
| **Electron** (Windows, macOS, Linux) | the web engine in the renderer: `react-native-anything-player/react` or `/web` | ◐ expected to match the Chromium column of the [feature matrix](features.md); not yet tested |
| **Tauri** on Windows | the same, in WebView2 (Chromium) | ◐ as Electron; not yet tested |
| **Tauri** on macOS | the same, in WKWebView (WebKit) | ◐ expected to match the Safari column; not yet tested |
| **Tauri** on Linux | the same, in WebKitGTK | ◐ untested; Media Source support depends on the system's GStreamer |
| **Expo web or React Native Web** inside Electron or Tauri | the exported web app, loaded by the shell | ◐ as above |
| **Mac**, running the iPhone and iPad app (Apple silicon) | the iOS build | – not tested ([roadmap](roadmap.md#desktop)) |
| **Mac Catalyst** | – | – not supported yet ([roadmap](roadmap.md#desktop)) |
| **react-native-macos** | – | – not supported yet ([roadmap](roadmap.md#desktop)) |
| **react-native-windows** | – | – not supported yet ([roadmap](roadmap.md#desktop)) |
| Expo | – | Expo has no desktop target; export for the web and load it in a desktop shell |

## Electron

Import the web entry in the renderer process, exactly as in a browser ([Web](web.md)):

```ts
import { Player } from 'react-native-anything-player/web'; // or /react with React

const player = new Player();
player.on('metadata', (m) => console.log(m.artist, '–', m.title));
await player.load('https://radio.example/stream', { autoplay: true });
```

The main process needs nothing from RNAP. Settings worth knowing in `webPreferences`:

```js
new BrowserWindow({
  webPreferences: {
    // Plays without a click first, so AUTOPLAY_BLOCKED never fires.
    autoplayPolicy: 'no-user-gesture-required',
    // Keeps timers on time while the window is hidden or minimised: recovery,
    // fades and the sleep timer run late otherwise, as in a background tab.
    backgroundThrottling: false,
  },
});
```

What to expect, from the Chromium column:

- **Radio titles, splices, the visualizer**: RNAP reads the stream with `fetch()`, so the stream server must send CORS headers, as on the web. Without them it plays through the `<audio>` element with no titles ([how the web engine picks](web.md)). A page loaded from `file://` has the origin `null`: `Access-Control-Allow-Origin: *` covers it, a list of origins does not.
- **Media keys and the system's media controls**: through the Media Session, which Chromium hands to the Windows media flyout, macOS Now Playing and MPRIS on Linux.
- **Google Cast: not available.** The Cast sender SDK needs Chrome's own media router, which Electron does not include. `castState` stays `unavailable`; hide the Cast button. RNAP still downloads the Cast SDK script before reporting this ([roadmap](roadmap.md#desktop)).
- **Output picker**: Remote Playback in Electron is not tested; treat it as unavailable.

## Tauri

The same imports. Tauri uses the system's web view, so what works depends on the OS: WebView2 on Windows behaves like Chromium, WKWebView on macOS like Safari, and WebKitGTK on Linux like Safari with Media Source only when the distribution's GStreamer provides it. None of them can use Google Cast.

## Native desktop

The engine itself is not tied to a platform: the Swift engine core (`ios/Core`) imports only Foundation and is a Swift package of its own, and the TypeScript twin runs anywhere JavaScript does. What is missing is the layer around it (the player, the media session, the audio session, the build files). The [roadmap](roadmap.md#desktop) lists the work, smallest first.
