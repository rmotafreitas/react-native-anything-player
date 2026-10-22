# Voice assistants

"Hey Siri, play Jazz FM on MyRadio." "Hey Google, play the news on MyRadio." Tell RNAP what the app can play, and Siri, Google Assistant and Gemini can start it, even when the app is not running. The same search powers `playFromSearch()`, so a search box or the web's speech recognition finds the same results.

Transport commands ("pause", "next", "resume") need nothing: they go through the [media session](background-and-system.md#lock-screen-notification-and-hardware-controls) like any headset button.

## The catalog

```ts
import { setCatalog } from 'react-native-anything-player';

await setCatalog(
  [
    {
      id: 'jazz',
      title: 'Jazz FM',
      genre: 'Jazz',
      artwork: 'https://cdn.example/jazz.png',
      keywords: ['Jazz Radio'],
      source: { uri: 'https://stream.example/jazz', live: true },
    },
    { id: 'news', title: 'World News', kind: 'podcast', source: 'https://cdn.example/news.mp3' },
  ],
  { playerId: 'main', playerOptions: { mediaSession: { commands: ['next', 'previous'] } } }
);
```

The catalog is stored on the device, so an assistant finds it when the app is not running. Call `setCatalog` again whenever the list changes; `[]` clears it. Each item has an `id`, a `title`, a `source` (anything `load()` accepts), and optionally `artist`, `album`, `genre`, `artwork`, `keywords` (other names people say) and a `kind` (`station` by default, or `song`, `album`, `podcast`, `audiobook`, `other`). The lock screen shows the item's title, artist, album and artwork unless the source has its own `metadata`.

## Playing a request

A request plays on the player on the lock screen. When there is none, it plays on the catalog's player (`playerId`, default `'default'`), which native creates with `playerOptions`. That is how a request works when JavaScript is not running. The app reaches that player with the same id:

```ts
const player = new Player({ id: 'main' }); // attaches if Siri already started it
player.on('searchPlay', ({ request, item }) => analytics.track('voice', { query: request.query, id: item.id }));
```

A player with an `id` outlives the JavaScript that created it, and `new Player({ id })` attaches to it: same source, same state, same options. Two live `Player` objects cannot share an id.

What gets picked:

- The best match in the catalog. Matching ignores case and accents, drops filler words ("play", "listen to", "the" at the start, "radio" or "station" at the end, unless they are part of a name), and forgives one typo in a long word. Titles and keywords weigh most, then artist, album and genre. The assistant's own understanding of the request (an artist, a genre, "a podcast") narrows the results when it matches.
- "Play something on MyRadio" (nothing but filler): the last item played from the catalog, else the first. With no JavaScript running (Android can start the playback service on its own), a bare Play from a headset, the lock screen or an assistant does the same when nothing is loaded; with JavaScript running it is forwarded as a `remoteCommand`, as always.
- Nothing matches: your search handler, if the app is running.

```ts
setSearchHandler(async ({ query }) => {
  const station = await api.searchStations(query); // the app's own search
  return station ? { id: station.id, title: station.name, source: station.url } : null;
});
```

The handler must answer within 5 seconds.

From the app (a search box, a deep link, a speech recognizer):

```ts
const item = await playFromSearch('jazz radio'); // the item playing, or null
const results = await searchCatalog({ query: 'news', focus: 'podcast' });
```

The search is the same on iOS, Android and the web: three implementations held to the same [test cases](../conformance/catalog/search.json).

## Siri

iOS starts a media request in a small **Intents extension**, which hands it to the app ("handle in app"): iOS launches the app in the background, and RNAP plays the request there. The extension needs no code of yours.

**Expo**: `["react-native-anything-player", { "siri": true }]`, then rebuild. The plugin adds the extension, the Siri capability and the usage description. Siri asks the user's permission the first time.

**React Native without Expo**: in Xcode, add an *Intents Extension* target named `RNAPIntents` (no UI). Replace its `IntentHandler.swift` with `node_modules/react-native-anything-player/ios/IntentsExtension/IntentHandler.swift`, and set its `Info.plist` `NSExtension → NSExtensionAttributes → IntentsSupported` to `INPlayMediaIntent`. In the app target, add the *Siri* capability, `NSSiriUsageDescription` and `NSUserActivityTypes` = `[INPlayMediaIntent]` to `Info.plist`.

Siri learns the catalog's titles and keywords as vocabulary. Say the app's name ("…on MyRadio"): Siri sends requests without it to Apple Music.

## Google Assistant & Gemini

Android's assistants, Google Assistant and Gemini, reach media apps two ways, and RNAP answers both:

- the app's media session and media library (Media3), which is how they find the catalog and play from it, even when the app is not running;
- a `MEDIA_PLAY_FROM_SEARCH` intent to the app's activity.

**Expo**: nothing to configure (turn it off with `"assistant": false`). The plugin adds the intent filter and the two lines below.

**React Native without Expo**: add the intent filter to the main activity in `AndroidManifest.xml`:

```xml
<intent-filter>
  <action android:name="android.media.action.MEDIA_PLAY_FROM_SEARCH" />
  <category android:name="android.intent.category.DEFAULT" />
</intent-filter>
```

and hand the intents to RNAP in `MainActivity.kt`:

```kotlin
import android.content.Intent
import android.os.Bundle
import com.anythingplayer.AnythingPlayer

override fun onCreate(savedInstanceState: Bundle?) {
  super.onCreate(savedInstanceState)
  AnythingPlayer.handleIntent(this, intent)
}

override fun onNewIntent(intent: Intent) {
  super.onNewIntent(intent)
  AnythingPlayer.handleIntent(this, intent)
}
```

Whether an assistant routes a request to your app depends on the assistant, the device and its language. Test on a device (the [hardware checklist](testing.md) lists what to try).

## On the web

There is no voice assistant on the web, but the same catalog and search are there: `setCatalog`, `searchCatalog` and `playFromSearch` work in Expo web, React Native Web and plain pages (`react-native-anything-player/web`). Wire them to a search box, or to the browser's speech recognition where it exists (Chrome, Edge, Safari):

```js
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
micButton.onclick = () => {
  const recognition = new Recognition();
  recognition.onresult = (e) => playFromSearch(e.results[0][0].transcript);
  recognition.start();
};
```

The catalog lives in the page's memory: call `setCatalog` when the page loads. [`example-web/`](../example-web/main.js) has a search box and a microphone button.
