# Cars & watches

Cars and watches browse your catalog the way people browse a radio: tabs, folders, a tap to play. RNAP builds that tree from the same [catalog](voice.md#the-catalog) Siri and Google Assistant use. You add a `group` to each item; that is all the app has to say.

| | Browse and play | Needs |
|---|---|---|
| Android Auto | tabs and lists on the car's screen | `car` build option |
| Android Automotive OS (the car's own system) | the same tree | a separate automotive build of your app |
| Wear OS | the tree, on the watch | nothing (it uses the phone's session) |
| CarPlay | a tab bar of lists, Now Playing | `car` build option, Apple's CarPlay audio entitlement |
| Apple Watch | Now Playing and its controls | nothing |
| Web | – (no car or watch screen); `group` still filters `searchCatalog` | nothing |

## The tree

```ts
import { setCatalog } from 'react-native-anything-player';

await setCatalog(
  [
    { id: 'jazz', title: 'Jazz FM', group: 'Music/Jazz', source: { uri: 'https://stream.example/jazz', live: true } },
    { id: 'rock', title: 'Rock Radio', group: 'Music', source: { uri: 'https://stream.example/rock', live: true } },
    { id: 'news', title: 'World News', kind: 'podcast', group: 'Podcasts/Daily', source: 'https://cdn.example/news.mp3' },
    { id: 'misc', title: 'Loose Station', source: 'https://stream.example/misc' },
  ],
  { browse: { recent: true, favorites: ['rock'], rootOrder: ['Podcasts'] } }
);
```

`group` is a path: `"Jazz"`, or `"Podcasts/Daily"` for a folder in a folder. `/` nests. Segments are trimmed and compared exactly (`jazz` and `Jazz` are two groups). The tree above is:

```text
Favorites            rock
Podcasts             Daily/  World News
Music                Jazz/  Jazz FM,  Rock Radio
More                 Loose Station
```

- The top-level groups are the tabs. `rootOrder` puts the ones it names first; the others follow in the order the catalog first mentions them.
- A folder lists its subfolders first, then its own items, in catalog order.
- Items without a group go in a **More** folder. When no item has a group and there are no favorites or recent items, the root is the flat list of items.
- **Favorites** is the ids in `browse.favorites`, in that order. Ids that are not in the catalog are ignored; an empty list hides the folder. `setFavorites(ids)` changes the list without sending the catalog again.
- **Recently played** is the last N items played from the catalog, newest first: by a voice request, `playFromSearch()` or a pick in the car or on the watch. `browse.recent: true` keeps 10; a number keeps that many (up to 50). It is stored on the device and off by default.
- `browse.titles` renames the three folders RNAP adds (`recent`, `favorites`, `more`). They are in English by default.
- A car shows at most four tabs, or the number the browser asks for (Android Auto and Automotive OS can say so in their root hints). When there are more groups, the last tab is **More** and holds the groups that did not fit, then the ungrouped items.
- Item ids must not start with `rnap:`; that prefix is for the tree's own folders (`rnap:group:Jazz`, `rnap:more`…), so an id names a folder or an item, never both. `setCatalog` rejects such an id.

### Long folders

- **Android Auto and Automotive OS** cannot page a list, so they get every child of a folder at once. A folder with more than 100 children is split, in order, into subfolders named by position: `1–100`, `101–200`… (a last one with a single item is just its number). More than 100 of those are split again (`1–10000`…). The groups, the order and the favorites are not changed, only how a long list is cut. The limit is RNAP's own: Android gives no hint for it.
- **Wear OS**, the Assistant and other browsers page the folder as they ask; nothing is split.
- **CarPlay** lists at most `CPListTemplate.maximumItemCount` rows, read at run time. A longer folder ends in a **More…** row (named after the *More* folder) that opens the next page, and so on.

Stations and albums are shown as a grid on Android (Android Auto and Android Automotive OS honor it), when a folder directly holds only those; everything else is a list. CarPlay shows lists only.

Artwork: Android loads `https://` and `http://` artwork. CarPlay also loads a file in the app. A folder shows the artwork of the first item inside.

### Playing from the tree

A pick plays the same way a voice request does: on the player on the lock screen, else the catalog's player (`playerId`), even when the app is not running. The player emits `searchPlay`, with `request.origin` set to `'browse'`:

```ts
player.on('searchPlay', ({ request, item }) => {
  if (request.origin === 'browse') analytics.track('car-pick', { id: item.id });
});
```

`origin` is `'siri'`, `'assistant'`, `'app'` or `'browse'`.

### Searching a group

```ts
await searchCatalog({ query: 'radio', group: 'Music' }); // Music and everything below it
```

`group` only filters; it is never matched as text. It works on every platform, the web included. The tree itself has no web surface.

## Android Auto

Add the build option, then rebuild:

```properties
# android/gradle.properties
rnapCar=true
```

**Expo**: `["react-native-anything-player", { "car": true }]`.

It declares the app as a media app for Android Auto (`<uses name="media"/>` in an `automotive_app_desc` resource, referenced by the `com.google.android.gms.car.application` meta-data). The browse tree is served by the library service RNAP already declares, so there is nothing else to add. Without the option the tree is still served to every other browser (Assistant, Wear OS).

To test without a car, use Android Auto's [Desktop Head Unit](https://developer.android.com/training/cars/testing/dhu). Turn on *Unknown sources* in the Android Auto developer settings for a build that is not from Google Play.

## Android Automotive OS

Cars with Google built in run apps on the car itself, not on a phone. That needs an *automotive* build of the app: a module with the `android.hardware.type.automotive` feature, the `com.android.automotive` meta-data pointing at an `automotive_app_desc` with `<uses name="media"/>`, and no launcher activity. See Google's [guide](https://developer.android.com/training/cars/media/automotive-os). The library service already has the intent filters that build needs, and serves the same tree. RNAP cannot add an automotive module for you.

## Wear OS

A watch lists the phone's media library and controls the phone's session. It needs no option: the browse tree and the controls come from the same `MediaLibraryService` as the phone's notification. This follows how Wear OS media apps work; it has not been tried on a watch. Wear OS apps that play on the watch itself are out of scope.

## CarPlay

CarPlay needs three things Apple controls or the app declares: the **CarPlay audio entitlement**, a **scene** for the car's screen, and RNAP's CarPlay code, which is compiled only on request.

1. **Entitlement.** Request the *CarPlay Audio* entitlement (`com.apple.developer.carplay-audio`) on Apple's [CarPlay request page](https://developer.apple.com/carplay/), then add the capability to your App ID and provisioning profile. Without it a build still runs, but nothing shows in the car.
2. **Build option.** `RNAP_CAR=1 pod install`, or `"rnap.car": "true"` in `ios/Podfile.properties.json`.
3. **Scene.** In the app's `Info.plist`, next to the scene the phone's window already uses:

```xml
<key>UIApplicationSceneManifest</key>
<dict>
  <key>UIApplicationSupportsMultipleScenes</key>
  <true/>
  <key>UISceneConfigurations</key>
  <dict>
    <key>UIWindowSceneSessionRoleApplication</key>
    <array>
      <dict>
        <key>UISceneConfigurationName</key>
        <string>Default Configuration</string>
        <key>UISceneDelegateClassName</key>
        <string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
      </dict>
    </array>
    <key>CPTemplateApplicationSceneSessionRoleApplication</key>
    <array>
      <dict>
        <key>UISceneClassName</key>
        <string>CPTemplateApplicationScene</string>
        <key>UISceneConfigurationName</key>
        <string>RNAP CarPlay</string>
        <key>UISceneDelegateClassName</key>
        <string>RNAPCarPlaySceneDelegate</string>
      </dict>
    </array>
  </dict>
</dict>
```

If your app delegate implements `application(_:configurationForConnecting:options:)` (the iOS 27 scene life cycle asks for it), return CarPlay's configuration for its role, and your window's for the others:

```swift
func application(
  _ application: UIApplication, configurationForConnecting session: UISceneSession,
  options: UIScene.ConnectionOptions
) -> UISceneConfiguration {
  if session.role == .carTemplateApplication {
    let configuration = UISceneConfiguration(name: "RNAP CarPlay", sessionRole: session.role)
    configuration.delegateClass = NSClassFromString("RNAPCarPlaySceneDelegate")
    return configuration
  }
  let configuration = UISceneConfiguration(name: "Default", sessionRole: session.role)
  configuration.delegateClass = SceneDelegate.self
  return configuration
}
```

**Expo**: `["react-native-anything-player", { "car": true }]` sets the build option, adds the entitlement and CarPlay's scene to the manifest, and keeps the window scene your app already has. It warns when the app has no window scene to keep: adopt the scene life cycle first.

What CarPlay shows: a tab bar with one list per tab (the top-level groups, **Recently played**, **Favorites**, **More**), folders that open as lists, and the system *Now Playing* screen with the controls the player already publishes (play, pause, and next, previous and skip when you enabled them in `mediaSession.commands`). A pick starts the player and opens *Now Playing* once audio starts; if it cannot play, an alert says so. The lists follow `setCatalog` and `setFavorites`.

The app does not need to be open. CarPlay can start it in the background; RNAP plays through the catalog's player with no JavaScript, as it does for Siri.

## Apple Watch

RNAP has no watch app, and a watch app of its own is out of scope. What works is what iOS does for every audio app:

- **Now Playing** on the watch shows the title, artist, album and artwork RNAP publishes in `MPNowPlayingInfoCenter`, and plays, pauses and (when enabled in `mediaSession.commands`) skips through `MPRemoteCommandCenter`, while the iPhone plays.
- Volume: the watch's Digital Crown.
- Browsing the catalog and starting a station from the watch is not possible: the system Now Playing screen only controls what is already playing. Start it from the phone or CarPlay.
- Audio played on the watch itself (without the phone) needs a watchOS app. Not supported.

## What was checked

Run `yarn test:android`: the tree builder against [`conformance/catalog/browse.json`](../conformance/catalog/browse.json), the catalog store with recent items and favorites. The Swift twin runs the same file in `swift test`. On the Android 16 emulator, `BrowseTreeLibraryTest` browses the service as a media client does; see [Testing](testing.md#browse-tree). CarPlay, Android Auto on a head unit, Android Automotive OS and Wear OS are not checked on hardware, and the Swift CarPlay code is compiled by CI, not run.
