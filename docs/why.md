# Why RNAP exists

React Native Anything Player (RNAP) was built by the developer of [animu.moe](https://www.animu.moe), an internet radio app, after two problems landed at the same time.

## The default player went commercial

React Native Track Player (RNTP) was the library most React Native audio apps used. Version 5 ships as a new package, [`@rntp/player`](https://www.npmjs.com/package/@rntp/player) (5.0.0 on npm since May 2026), under a commercial licence. Its [licence text](https://unpkg.com/@rntp/player@5.12.1/license.txt) is free only for personal use by a private individual or for teaching and research at an academic institution:

> Any use that does not strictly and entirely qualify as Personal Use or Educational Use requires a commercial license, including any use within a for-profit company, non-profit organization, or government entity.

A free app published by a radio station, a community project or a non-profit therefore needs a paid licence. The [published prices](https://www.rntp.dev/pricing) are €99 per month or €999 per year for one app. Version 4 stays Apache-2.0, but new work happens in version 5.

## Staying on air took a pile of app code

A radio app meets the same situations every day, and none of the available players handled them without code written by the app:

- **The network goes away.** Wi-Fi drops, or the phone moves between Wi-Fi and mobile data. With RNTP the stream stops and stays stopped ([#686](https://github.com/doublesymmetry/react-native-track-player/issues/686)); on iOS it does not even report an error, so apps combine a pause listener with NetInfo to notice ([#1437](https://github.com/doublesymmetry/react-native-track-player/issues/1437)). Recovering from an errored player is a long-standing feature request ([#1764](https://github.com/doublesymmetry/react-native-track-player/issues/1764)). RNTP 5 exposes `retry()`, and the app decides when to call it.
- **Something else wants the audio.** The listener opens Instagram, takes a phone call or talks to the voice assistant. In RNTP 4, `autoHandleInterruptions` is off by default and apps handle the `RemoteDuck` event themselves ([events docs](https://rntp.dev/docs/api/events)). In expo-audio, a short rebuffer releases audio focus and never takes it back, so playback talks over phone calls ([expo #50072](https://github.com/expo/expo/issues/50072)), and resuming after an interruption can fail ([expo #42709](https://github.com/expo/expo/issues/42709)).
- **JavaScript is not running.** React Native pauses JS timers in the background, so retry loops and stall checks written in JS stop exactly when they are needed.

We read the published source of RNTP 4 and 5, expo-audio, react-native-audio-pro and react-native-video ([how](comparison.md#methodology)). None of them reconnects a dropped stream, watches connectivity or detects a silent stall on its own.

## What RNAP does instead

RNAP puts the whole player in native code: the state machine, recovery, audio focus, interruptions, the lock screen and every timer. A dropped stream, a network switch or a phone call is handled by the engine with no code in your app, and it keeps working while JavaScript is frozen. [Recovery policy](recovery.md) lists every rule and the failure behind it; [Comparison](comparison.md) shows how the other libraries compare.

The licence is [PolyForm Noncommercial 1.0.0](https://github.com/rmotafreitas/react-native-anything-player/blob/main/LICENSE): free for personal, educational, non-profit and other noncommercial use, including apps from charities and public institutions. Commercial use needs a licence ([COMMERCIAL.md](../COMMERCIAL.md)).
