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

The catalog is stored on the device, so an assistant finds it when the app is not running. Call `setCatalog` again whenever the list changes; `[]` clears it. Each item has an `id` (unique, and not starting with `rnap:`, which the [browse tree](cars-and-watches.md#the-tree) keeps for its folders; `setCatalog` rejects it), a `title`, a `source` (anything `load()` accepts except a `Blob` or `File`: an item needs a URL), and optionally `artist`, `album`, `genre`, `artwork`, `keywords` (other names people say) and a `kind` (`station` by default, or `song`, `album`, `podcast`, `audiobook`, `other`). The lock screen shows the item's title, artist, album and artwork unless the source has its own `metadata`.

An item whose source has `renditions` can say the `quality` it starts at (a rendition id, or `'auto'`), as `load(source, { quality })` does: a player that native code creates for a request, with no JavaScript running, has no pick of its own. Asking for what is already loaded (the same file, or the same renditions) plays on instead of opening it again: no gap, and the app's `updateNowPlaying` stays; `searchPlay` is still emitted. The loaded source's headers and DRM stay too.

### A catalog the app bundles

The catalog exists once the app has called `setCatalog`. On a fresh install, before the app was opened, a voice request or a car would find nothing. Bundle one for that time: a JSON file (say `catalog.json`, next to `app.json`) with what the app passes to `setCatalog`.

```json
{
  "playerId": "main",
  "items": [
    { "id": "jazz", "title": "Jazz FM", "artwork": "https://cdn.example/jazz.png",
      "source": { "uri": "https://stream.example/jazz", "live": true } }
  ]
}
```

**Expo**: `["react-native-anything-player", { "catalog": "./catalog.json" }]`. The prebuild checks it with `setCatalog`'s own rules (sources and artwork are URLs here: a JSON file has no `require()`) and fails on what `setCatalog` would reject. **Bare**: write the same file's stored form, `require('react-native-anything-player/plugin/catalogSeed').catalogSeed(json)`, to `android/app/src/main/assets/rnap/catalog-seed.json`, and add it to the iOS app target as `rnap-catalog-seed.json`.

The bundled catalog is used until the app calls `setCatalog`, which replaces it for good. Until then, an app update that bundles a different one replaces the one in use (what played and the favorites stay, for the items still there), and removing the option leaves none. With the Expo plugin, the option owns the bundled file: a prebuild without it empties one written by hand.

An item can also have a `group` (`"Jazz"`, or `"Podcasts/Daily"`), which files it in the browse tree that [cars and watches](cars-and-watches.md) show; `setCatalog`'s `browse` option and `setFavorites(ids)` add "Recently played" and "Favorites" folders. `searchCatalog({ query, group })` and `playFromSearch({ query, group })` search one group (and its subgroups) only. A pick in the car plays like a voice request and emits `searchPlay` with `origin: 'browse'`.

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

## Siri shortcuts (App Intents)

On iOS 16 and later the catalog also becomes **App Shortcuts**: things people can say with no setup, which also show in Spotlight and the Shortcuts app, and which they can put on the Action button or in their own shortcuts.

- "Play Jazz FM in MyRadio", "Play Jazz FM on MyRadio", "Listen to Jazz FM on MyRadio", "Put on Jazz FM in MyRadio": an item, by its title.
- "Play MyRadio", "Play something on MyRadio", "Listen to MyRadio", "Start MyRadio": the last item played, else the first.

They play the way a Siri request does: natively, even when the app is not running, on the lock-screen player or else the catalog's player, and the player emits `searchPlay` with `origin: 'siri'`. Siri learns phrases for the first 50 items of the catalog; the *Play* action in the Shortcuts app searches all of them, with the same search. iOS relearns the phrases whenever `setCatalog` changes the catalog.

iOS reads App Intents from the app's own code, not from a library, so RNAP ships them as a file the app compiles: [`ios/AppIntents/RNAPAppIntents.swift`](../ios/AppIntents/RNAPAppIntents.swift). It needs no Siri capability, permission or `Info.plist` key, and the app can still support iOS 15 (the file is iOS 16+ only).

**Expo**: `"siri": true` adds it to the app target. To leave it out: `["react-native-anything-player", { "siri": { "appIntents": false } }]` (then `expo prebuild --clean`).

**React Native without Expo**: in Xcode, add `node_modules/react-native-anything-player/ios/AppIntents/RNAPAppIntents.swift` to the app target (*File → Add Files*, target membership: the app). Copy the file instead of referencing it to change its phrases. An Objective-C app gets Xcode's offer of a bridging header: accept it.

An app has one App Shortcuts provider. If yours already has one, move the two `AppShortcut`s from the file into it and delete `RNAPShortcuts`.

Both Siri paths stay on, and play the same item the same way: the App Shortcuts answer catalog titles, the extension any request the search finds (and the search handler). App Shortcuts also work in apps that adopt the scene life cycle; the extension's hand-off to the app relies on an app delegate method Apple lists for iOS 11–14 (see the [hardware checklist](testing.md)).

Native code in the app (the file above, the app's own intents, a CarPlay template) reaches the catalog through `RNAPVoice`, from Swift or Objective-C, with no JavaScript running:

```swift
import AnythingPlayer

let items = RNAPVoice.catalogItems() // [RNAPCatalogItem]: id, title, artist, album, genre, kind, keywords, artwork
let matches = RNAPVoice.search("jazz") // best first
let item = RNAPVoice.item(withId: "jazz")
let outcome = await RNAPVoice.play(itemId: "jazz") // .playing once audio starts (≤ 8 s), .failed or .noMatch
_ = await RNAPVoice.play(query: "") // the last item played, else the first
// Posted after setCatalog changes the catalog:
NotificationCenter.default.addObserver(forName: RNAPVoice.catalogDidChangeNotification, object: nil, queue: .main) { _ in }
```

## Google Assistant and Gemini

Android's assistants, Google Assistant and Gemini, reach media apps two ways, and RNAP answers both:

- the app's media session and media library (Media3), which is how they find the catalog and play from it, even when the app is not running;
- a `MEDIA_PLAY_FROM_SEARCH` intent to the app's activity.

An intent that comes before the app can answer it (a fresh install it opens: no catalog, no search handler) waits: it plays once the app's JavaScript calls `setCatalog` or `setSearchHandler` (when the handler has no answer, the catalog's match plays if the catalog came meanwhile), unless something was loaded meanwhile (the user's choice wins). It is dropped if that JavaScript goes away first, a reload included. A [bundled catalog](#a-catalog-the-app-bundles) answers it at once, with no JavaScript.

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
