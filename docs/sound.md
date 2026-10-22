# Sound effects

`Player` plays music, radio and podcasts: one long source, a media session, the lock screen, audio focus. A tap, a shot, a coin or a notification chime needs the opposite: start in a few milliseconds, many at once, and stay out of the way of whatever else the device is playing. That is `Sound`, a separate entry point:

```ts
import { Sound } from 'react-native-anything-player/sound';

const shot = await Sound.load(require('./laser.wav'), { voices: 6 });

const voice = shot.play({ volume: 0.8, pan: -0.5, rate: 1.2 });
voice.setPan(0.5); // while it plays
voice.stop();

shot.stop(); // every copy of this sound
await shot.unload(); // free its memory
Sound.stopAll();
```

It works on iOS, Android, Expo web, React Native Web, React DOM and plain pages, with the same code. The same import works in the browser (`react-native-anything-player/web` and `/react` export `Sound` too).

| | `Player` | `Sound` |
|---|---|---|
| For | music, radio, podcasts, audiobooks | effects of a few seconds |
| Source | a file or stream, played as it loads | decoded into memory by `load()` |
| Copies at once | one source per player | up to `voices` per sound |
| Media session, lock screen, audio focus | yes | none |
| Other apps' audio | per player (`mixWithOthers`) | always mixed |

## Loading

`Sound.load(input, options?)` decodes the sound and resolves with a `SoundClip` once it is ready to play with no delay.

| `input` | Where |
|---|---|
| `require('./laser.wav')` | a bundled asset, resolved the way `Player` resolves it |
| `'https://…'` | downloaded (on iOS and Android to a temporary file, deleted after decoding), then decoded |
| `'file:///…'` or an absolute path | a local file (iOS and Android; on the web a `blob:` URL) |
| `content://…` | Android only |
| a `Blob` or `File` | the web only |

`options.voices` (1–32, default 4) is how many copies of this sound can play at once. When all are busy, the next `play()` stops the one that started first and takes its voice, so the newest sound always plays.

The whole decoded sound stays in memory until `unload()`: use it for effects of a few seconds, not for songs (iOS rejects a sound over 48 MB decoded with `INVALID_SOURCE`; Android documents about 1 MB per sound, so keep them to a few seconds).

Formats are the platform's: WAV and MP3 everywhere; AAC/M4A everywhere; Ogg Vorbis on Android, Chromium and Firefox (not on iOS); FLAC on iOS, Android and most browsers. A file the platform cannot decode rejects with `UNSUPPORTED_FORMAT`. WAV is the safest choice for effects: nothing to decode.

`clip.duration` is the length in seconds (`null` where the platform does not say).

## Playing

`clip.play(options?)` starts a copy now and returns a `SoundVoice`. Numbers out of range are clamped.

| Option | Range | Default | |
|---|---|---|---|
| `volume` | 0–1 | 1 | |
| `rate` | 0.5–2 | 1 | speed; the pitch follows |
| `pan` | -1 (left) to 1 (right) | 0 | |
| `loop` | | `false` | repeats until stopped |

The handle has `stop()`, `setVolume()`, `setRate()` and `setPan()`, and the current values as `volume`, `rate` and `pan`. Using a handle after its sound ended, or after its voice was taken by a newer `play()`, does nothing.

`Sound.setEnabled(false)` is a "sound effects" switch: `play()` does nothing (and returns an inert handle) and the sounds playing stop. `Sound.stopAll()` stops everything.

## How it mixes with other audio

Sounds mix with whatever else plays: your `Player`, another app's music, a call's audio. They take no audio focus, create no media session and show nothing on the lock screen, so they never pause or duck anything.

| | What happens |
|---|---|
| iOS | An `AVAudioEngine` with a pool of player nodes per sound. The audio session is set to `.playback` with `mixWithOthers` on the first `play()`, only if the app still has iOS's default category. If `Player` (or you) already set a category, it is used as is and never changed or deactivated by `Sound`. The engine stops 10 s after the last sound ended and starts again on the next one; it survives interruptions, route changes and media services resets |
| Android | A `SoundPool` per sound, with `USAGE_GAME` audio attributes and no focus request |
| Web | Web Audio: one shared `AudioContext`, each voice a source node through a gain and a stereo panner |

### The silent switch (iOS)

By default, sounds play with the ringer switch on silent, as `Player` does. Games usually want the opposite: effects that obey the switch.

```ts
await Sound.configure({ respectSilentSwitch: true });
```

`respectSilentSwitch: true` uses the `ambient` category on iOS, which the ringer switch silences. It applies when `Sound` sets the category itself (see above): while `Player` has set `.playback`, sounds follow the player's session. Android has no such switch; on the web the browser decides (iPhone Safari silences Web Audio with the switch).

## The web

There is no build option on the web: Web Audio is always there. Browsers keep audio off until the page had a user gesture. RNAP starts the audio context on the first tap, click or key press by itself, so a sound played from a handler of one just works. `play()` before any gesture throws `AUTOPLAY_BLOCKED` (recoverable: try again after one), and `await Sound.unlock()` from a handler gets the output ready ahead of time. On iOS and Android `unlock()` resolves at once.

A page fetching a sound from another origin needs CORS headers on it, as for `Player` ([what to send](web.md#what-the-stream-server-must-send)).

## Enabling it

On iOS and Android `Sound` is a build option, like Cast, so apps that do not play effects ship none of it:

| Where | Option |
|---|---|
| `android/gradle.properties` | `rnapSound=true` |
| `pod install` | `RNAP_SOUND=1` (or `"rnap.sound": "true"` in `ios/Podfile.properties.json`) |
| Expo config plugin | `["react-native-anything-player", { "sound": true }]` |

Without it, `Sound.load()` and `Sound.configure()` reject with `SOUND_UNAVAILABLE` (the message says how to turn it on), and `Sound.isAvailable()` returns `false`. The web has no such step.

## Errors

| Code | When |
|---|---|
| `SOUND_UNAVAILABLE` | the app was built without the `sound` option |
| `INVALID_SOURCE`, `SOURCE_NOT_FOUND`, `HTTP_ERROR`, `NETWORK_ERROR` | the input is not usable, missing, or could not be downloaded |
| `UNSUPPORTED_FORMAT` | the platform cannot decode it |
| `INVALID_ARGUMENT` | `voices` out of range, or a non-number volume, rate or pan |
| `AUTOPLAY_BLOCKED` | web: `play()` or `unlock()` before a user gesture |

See [Errors](errors.md).
