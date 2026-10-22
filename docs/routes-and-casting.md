# Casting & AirPlay

Every player reports where its audio goes, the system's output picker is one component away, and Google Cast is a build option: the same player then plays on a TV or a speaker, with the same API, state and recovery.

## Where the audio goes

`status.route` is the player's output, and `routeChange` fires when it changes:

```ts
player.on('routeChange', (route, previous) => {
  console.log(`${previous.kind} → ${route.kind}`, route.name); // "speaker → bluetooth AirPods Pro"
});
```

| `route.kind` | Output |
|---|---|
| `speaker` | the device's speaker (or earpiece) |
| `headphones` | wired headphones or a headset |
| `bluetooth` | Bluetooth headphones, speakers or a car kit |
| `airplay` | an AirPlay receiver (iOS, Safari) |
| `cast` | a Google Cast receiver, which plays the stream itself |
| `car` | CarPlay, or a car's audio over USB |
| `hdmi`, `usb` | HDMI / DisplayPort audio, a USB audio device |
| `other` | an output the platform reports but RNAP does not classify |
| `unknown` | the platform does not say (a browser's own output) |

`route.name` is the device's name when the platform tells it ("Living Room", "AirPods Pro"), else `null`.

## The output picker

```tsx
import { RoutePicker } from 'react-native-anything-player';

<RoutePicker player={player} size={28} color="#888" activeColor="#0a84ff" />
```

| Platform | `<RoutePicker />` shows |
|---|---|
| iOS | the system's own AirPlay button (`AVRoutePickerView`): AirPlay and Bluetooth outputs |
| Android | a button that opens the system Output Switcher (Android 14+ and, through AndroidX, earlier versions), falling back to Bluetooth settings. It lists Cast devices too when [Cast](#google-cast) is built in |
| Safari | AirPlay receivers, when the browser has found any |
| Chrome | Remote Playback (the browser casts the `<audio>` element) for sources played by the element; not for radio read through MSE |
| Firefox | nothing (the component renders `null`) |

Without React (or for a custom button), `showRoutePicker(player?)` opens the same picker and rejects with `ROUTE_PICKER_UNAVAILABLE` where there is none; `isRoutePickerAvailable()` and `addRoutePickerAvailabilityListener()` (or the `useRoutePickerAvailable()` hook) tell whether to show it. On the web, call `showRoutePicker()` from a click: browsers open pickers only inside a user gesture.

## AirPlay

AirPlay is a system output, like Bluetooth: the player keeps playing on the device and iOS sends the audio to the receiver. Nothing changes for the engine. `status.route` becomes `{ kind: 'airplay', name: 'Living Room' }`, and recovery, interruptions and the lock screen work as usual.

In Safari, the element plays to the receiver. Radio read through Media Source Extensions (for ICY titles) stays AirPlay-able: RNAP gives the element the stream's URL as an alternative source, which is what the AirPlay receiver plays.

## Google Cast

Cast is **opt-in**: the Cast SDKs add several megabytes, and a radio app that does not cast should not ship them.

### Enabling it

**Expo**: add the option to the plugin and rebuild the development build:

```json
{
  "expo": {
    "plugins": [["react-native-anything-player", { "cast": true }]]
  }
}
```

`"cast": { "receiverApplicationId": "ABCD1234" }` uses your own [Cast receiver](https://developers.google.com/cast/docs/registration). The default is Google's Default Media Receiver, which needs no registration.

**React Native without Expo**:

- Android: `rnapCast=true` in `android/gradle.properties`. For your own receiver, add `<meta-data android:name="com.anythingplayer.CAST_RECEIVER_ID" android:value="ABCD1234" />` inside `<application>`.
- iOS: install the pods with `RNAP_CAST=1 pod install`. In `Info.plist`, add `NSLocalNetworkUsageDescription` (why the app looks for devices) and `NSBonjourServices` with `_googlecast._tcp` and `_CC1AD845._googlecast._tcp` (your receiver's id instead of `CC1AD845`). For your own receiver, also set `RNAPCastReceiverId`.
- Web (Chrome on desktop and Android): nothing to build. Call `configureCast()` early, for example at startup; it loads Google's Cast SDK. `<CastButton />` does this itself.

### The Cast button

```tsx
import { CastButton, useCastStatus } from 'react-native-anything-player';

<CastButton size={28} color="#888" activeColor="#0a84ff" />
```

It is shown only when Cast devices are found, opens the device chooser, and while casting opens the dialog to stop. Without React: `showCastPicker()`, `stopCasting()`, `getCastStatus()` and `addCastStateListener()`. The state is one of `unavailable` (no Cast here), `initializing`, `noDevices`, `notConnected`, `connecting` and `connected`, with the receiver's name.

### What casting does

When a Cast session starts, the player on the lock screen moves to the receiver. The receiver opens the same source at the same position, or at the live edge for a stream, and keeps playing if it was playing. The player is the same object: `status`, events, `play()`, `pause()`, `seekTo()` and `setVolume()` work as before, and `status.route` is `{ kind: 'cast', name: 'Living Room' }`.

| | While casting |
|---|---|
| Recovery | The engine's policy, against the receiver: a receiver error reconnects with the usual backoff, and so does a receiver that buffers for over 20 s. The phone losing its own network does not reload the receiver, which has its own. |
| Radio titles | The phone keeps reading the stream's ICY metadata on a connection of its own (it discards the audio), so `metadata` events and the lock screen keep updating. Titles arrive a little ahead of what the receiver plays (its buffer). This costs the stream's bandwidth a second time. On iOS the reader stops while the app is suspended in the background, and catches up when it returns. |
| Volume | `setVolume()` sets the receiver's stream volume. The hardware volume buttons change the receiver's own volume (on Android through the media session; on iOS and in Chrome as the Cast SDK does). |
| Calls, other apps, ducking | Do not pause or duck the receiver. |
| Another player starts | The Cast session follows the player on the lock screen: the previous one returns to the phone, paused, and the new one moves to the receiver. |
| Casting ends | The player returns to the phone **paused**, at the receiver's position, so it never suddenly plays from the phone's speaker. |

The receiver fetches the source itself, so:

- it must be reachable from the receiver: an `http(s)` URL. Local files, `content://` URIs, bundled assets and `blob:` URLs stay on the phone, and the player reports a non-fatal `CAST_UNSUPPORTED_SOURCE` error;
- a source's `headers` are not sent (the Default Media Receiver cannot send custom headers);
- the receiver decides what it can decode. MP3, AAC and HLS work on every Cast device.

## Platform support

| | iOS | Android | Web |
|---|---|---|---|
| `status.route` | AVAudioSession route | the selected media output (Android 13+), else the best connected one | `unknown`; `airplay` (Safari), `cast` |
| Output picker | AVRoutePickerView | Output Switcher | AirPlay (Safari), Remote Playback (Chrome) |
| Google Cast | Google Cast SDK (`cast` option) | Media3 Cast (`cast` option) | Cast Web Sender (Chrome) |

Discovery, AirPlay and Cast run on real devices and networks: see the hardware checklist in [Testing](testing.md). CI covers the engine's handoff rules (the shared [conformance suite](../conformance/README.md)) and, in real browsers, the web's Cast handoff against a scripted receiver.
