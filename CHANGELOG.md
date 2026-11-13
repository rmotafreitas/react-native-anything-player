# Changelog

All notable changes to React Native Anything Player (RNAP) are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/): see
[Versioning and releases](docs/releases.md) for what counts as a breaking
change and how releases are made. Changes not released yet are listed in the
open release pull request.

## [1.6.0](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.5.1...v1.6.0) (2026-11-13)


### Added

* a native queue: next/previous, repeat, shuffle, gapless next item, skip on item errors ([9e9ba66](https://github.com/rmotafreitas/react-native-anything-player/commit/9e9ba66780cd8423691fb04b946524dc70f6b0b3))
* **android:** the media cache: Media3 cache read and written as items play, preload, downloads kept for offline (files, HLS, DASH; one quality) ([c610f5a](https://github.com/rmotafreitas/react-native-anything-player/commit/c610f5a73125643698ac3d7b1f320ccd10577b06))
* boundary events (where a live item really starts, from the audio around its ICY title), the first item of a connection found in its opening audio, Android sample windows timed on the player's clock; a native queue (next/previous, repeat, shuffle, gapless, M3U/PLS/XSPF); the media cache (preload, downloads, offline replay) on Android, iOS and web; and fixes across subtitles, HLS/DASH, downloads and live offsets ([1b4ca81](https://github.com/rmotafreitas/react-native-anything-player/commit/1b4ca818074f67ae8b65eb504c6e4e5a7a11bba7))
* Cache exported on every entry; CACHE_UNAVAILABLE ([d54988b](https://github.com/rmotafreitas/react-native-anything-player/commit/d54988b5c17c471d56d557ab754e9c930201fdb2))
* **ios:** the media cache: the stream proxy serves held ranges from disk and writes what it relays, complete files and HLS downloads open from disk, preload, downloads (files, HLS) ([70f6d58](https://github.com/rmotafreitas/react-native-anything-player/commit/70f6d5874f3826773221f6c3cd07332b0c075a9f))
* **live:** a tune-in finds its item's start in the audio the connection opens with; Android times sample windows on the player's clock ([f8f3cbb](https://github.com/rmotafreitas/react-native-anything-player/commit/f8f3cbb5042f876bcc5e1462ac7123039cf07d67))
* **live:** audioSample reaches its listeners while boundary detection samples too ([11ee1f3](https://github.com/rmotafreitas/react-native-anything-player/commit/11ee1f3317e049c83a9a68943f9926b1afee6c6b))
* **live:** boundary events: where a live item really starts, read from the audio around its ICY title ([e98fa62](https://github.com/rmotafreitas/react-native-anything-player/commit/e98fa620f7840ea80ad1ce37a760606342c6a240))
* playlist files (M3U, PLS, XSPF) for the queue; load() of a station's .pls plays its stream ([14c4843](https://github.com/rmotafreitas/react-native-anything-player/commit/14c48437997fbaab3b2837e6a48283b38a7963c5))
* **web:** ICY titles from a cross-origin server that does not expose icy-metaint ([47474cc](https://github.com/rmotafreitas/react-native-anything-player/commit/47474cca3b588b7efa4e752884d440869412a58e))
* **web:** the media cache: Cache API (configure, preload, download, info, usage, clear), Cache Storage on the web, complete files played from their stored bytes ([01d02af](https://github.com/rmotafreitas/react-native-anything-player/commit/01d02af89a7ad626c099ad5dcb7926295b7e2fe1))


### Fixed

* a file's own tags reach player.metadata on both platforms: Android read none (they come with the track's format, not as timed metadata), iOS skipped Vorbis comments (FLAC, Ogg, Opus have no common keys) ([f97bc36](https://github.com/rmotafreitas/react-native-anything-player/commit/f97bc36bd2bec0742fa68fa034a9f836b40f5035))
* a getLicense written as a method keeps its `this` ([8fdb23b](https://github.com/rmotafreitas/react-native-anything-player/commit/8fdb23be4c8f6f0ae13f70fed2042eb25d1d2b4e))
* a refresh written as a method keeps its `this` ([5181e62](https://github.com/rmotafreitas/react-native-anything-player/commit/5181e62c4a2bd480d7373e3b9a9f567f657b306c))
* **android:** a whole-file preload is no longer cancelled before its first byte: CacheWriter reports no length before the request, so only a length still missing once bytes arrive means a stream with no end (what that first block wrote goes) ([081bb9b](https://github.com/rmotafreitas/react-native-anything-player/commit/081bb9bb93280346514898030633bf7f58aff378))
* **android:** an HLS or DASH playlist at a URL without an extension plays: ExoPlayer read it as a file (UNSUPPORTED_FORMAT); after that failure, and only then, its first bytes are read and it opens again as a playlist (iOS and the web already went by its Content-Type) ([853da48](https://github.com/rmotafreitas/react-native-anything-player/commit/853da481a9f8b1606fccc9c8982fc48053e35b18))
* **android:** council cache round 1 (Sonnet): downloaded HLS/DASH plays its kept quality, variants counted as Media3 does and the best one's audio group, manifests never in the play cache, a source with no length is not filled, one download per id and file, the index read before commands, no failure told for a removed download, downloads out of Auto Backup, a pool for cache commands ([df9df6a](https://github.com/rmotafreitas/react-native-anything-player/commit/df9df6a54f87375bab533413e5df4db27f0f23d5))
* **android:** the cache works while it is turned on: FLAG_IGNORE_CACHE_FOR_UNSET_LENGTH_REQUESTS bypassed it for every request a player makes (they have no length), so nothing was cached as it played and a preloaded file did not play offline; a response with no length is now left out by the cache writer instead ([a1760ac](https://github.com/rmotafreitas/react-native-anything-player/commit/a1760ace8751636ff64acada7282154db34e200a))
* **android:** the playlist sniff names the byte-order mark as \uFEFF: Android lint fails a raw BOM in the middle of a file ([e78f045](https://github.com/rmotafreitas/react-native-anything-player/commit/e78f0456ff1eeb501e2977372d8b43a1b5735adc))
* council cache review (DeepSeek): iOS files keep their container's extension, a gone HLS package fails its download, a resumed HLS task can be removed, Android attaches before a first command and clears interrupts left by cancels, removals fall back to the key; docs: HLS offline needs a download, design aligned ([114bbc6](https://github.com/rmotafreitas/react-native-anything-player/commit/114bbc6549adf0f38ccbe856f0490b19a9f854a6))
* council cache round 2 (Sonnet): a failed Android download goes on from what it has and a replaced one is removed before the new one starts (removals on their own thread), a stream that never ends keeps nothing, the iOS proxy lets go of an entry whose file is gone, iOS failures say why and an HLS download the system lost fails; no-store test; docs ([0922344](https://github.com/rmotafreitas/react-native-anything-player/commit/0922344d8a1543787844b556bf2d36391af357d0))
* council cache round 3 (Haiku, DeepSeek): one blob URL per web file, a running download stays downloading, one page fetches a file at a time, removals elsewhere seen; Android removals wait for the old task and never fetch a manifest; a downloaded file whose bytes vanished fails (Android, iOS); docs ([769b08b](https://github.com/rmotafreitas/react-native-anything-player/commit/769b08bd968760d5dd736e7c682c35041410acea))
* council cache round 3 (Sonnet): a dying web fill no longer frees a newer one's key, ghost entries leave the stored index, a no-length Android download keeps nothing however its cancel surfaces, a removed Android download never starts, an iOS HLS download that finished away is not failed and a recovered one carries no error, iOS files of no type keep an MP3 extension ([a882f39](https://github.com/rmotafreitas/react-native-anything-player/commit/a882f394d4a8f9d7d2959c04bd0afdf31380baba))
* council round 1 (GLM): a cancel ExoPlayer outran still advances the engine, quality caps on the prepared AVPlayer, model twins agree on a missing current item ([fca23c1](https://github.com/rmotafreitas/react-native-anything-player/commit/fca23c12eaa293aca70d7b31bd1cb73c901c4eb4))
* council round 1 (Haiku): playlist headers stay on their host, stale playlist loads dropped, parser hardening, repeat all with one item loops, skip streak per queue ([708d570](https://github.com/rmotafreitas/react-native-anything-player/commit/708d570da8ff113a5a61624a15958b87823deaad))
* council round 1 (Sonnet): hooks kept across load and add, Cast hand-back for queue items, prepared-item errors on Android, seek to a prepared item, WebKit unlock only with a queue ([e8c52c0](https://github.com/rmotafreitas/react-native-anything-player/commit/e8c52c0bd3783e0c9c021cf207450bacf5a285f0))
* council round 2: a prepared item's network error found by its request on Android, repeat's loop ends with the queue, linear XSPF fields, the intent decided before a Cast hand-back, next at the queue's end goes to the app ([5ba02f4](https://github.com/rmotafreitas/react-native-anything-player/commit/5ba02f4dcb108386a366e7f069447c67f20aedb5))
* council round 3 (Haiku, GLM): the loaded source's id is checked before it joins, Android tells the current item's failures from a prepared item's with the same or a resolved URL, empty logos are none ([43035a2](https://github.com/rmotafreitas/react-native-anything-player/commit/43035a2e95b81df030236a2ab6e94572c928c31c))
* council round 3 (Sonnet): XSPF offsets hold after an İ; Android finds a prepared item's failures beside its manifest and its unrecognised files ([1536b04](https://github.com/rmotafreitas/react-native-anything-player/commit/1536b04f5062e271ea501ba8a8469b55ce59b0be))
* council round 4 (Haiku): a request beside both manifests is not taken for the prepared item's ([2964d53](https://github.com/rmotafreitas/react-native-anything-player/commit/2964d5311bcb303c2894c472cfe3a6131dfe2960))
* council round 4 (Sonnet): a restarted Android download's removal waits for its new task, a vanished download is found by its stored length, a page's stale entry never goes over a file another page stored whole ([e7b5101](https://github.com/rmotafreitas/react-native-anything-player/commit/e7b5101eca4bc9bcfc035f5bdf7bbc8c654c3c4f))
* council round 4 (Sonnet): exact URL matches decide before the beside-the-manifest rule ([6f2bc7d](https://github.com/rmotafreitas/react-native-anything-player/commit/6f2bc7db48d75d3ad57109ed79c7e49633a0461b))
* council round 5 (Haiku): a fetch outrun by another page's whole file is not a failure, adopted downloads are told, an Android task removes only its own running entry ([970e67f](https://github.com/rmotafreitas/react-native-anything-player/commit/970e67ffca9991565b2763e4cecd76c0ad477522))
* **example-expo:** a development build on Android loads its bundle: Expo serves it from 127.0.0.1, which the test-server cleartext policy left out (Unable to load script) ([be39e66](https://github.com/rmotafreitas/react-native-anything-player/commit/be39e66c05e9364e7968727f9022e108942c3a48))
* **ios:** a live MPEG-TS channel is cut in 1 s segments, not 4 s: AVPlayer waits for several before it starts, so radio over TS took 8-10 s to play (now ~2.3 s; a video channel is bound by its keyframes) ([b3752bc](https://github.com/rmotafreitas/react-native-anything-player/commit/b3752bc17d0f0d5ca3b0cad5d5e26bf70dc1a47d))
* **ios:** a new download's key is the local one, not a call through it (the first Xcode build of the cache code failed here) ([f6ab0c0](https://github.com/rmotafreitas/react-native-anything-player/commit/f6ab0c0f0b17a9955634844deb0c8bc719e4e183))
* **ios:** a preload honours Cache-Control: no-store as the proxy does (it wrote the file before; downloads still keep what they are asked for) ([cc84c40](https://github.com/rmotafreitas/react-native-anything-player/commit/cc84c408a00aaae4f8391cd666c50aae7a67ee64))
* **ios:** a source in a codec the device cannot play fails as UNSUPPORTED_FORMAT instead of reconnecting forever: AVFoundation's incompatibleAsset (VP9 or AV1 through the remuxer) and Core Audio's 'fmt?'/'typ?' under an unknown error (Ogg Vorbis) were recoverable NATIVE_PLAYER_ERRORs ([1e2b904](https://github.com/rmotafreitas/react-native-anything-player/commit/1e2b904bc4b429a8d7c6b5411e0374867055ea9d))
* **ios:** a stream's sample windows each carry their own time, and none is skipped ([345308c](https://github.com/rmotafreitas/react-native-anything-player/commit/345308c3158b3c60af54b270316d44a4e11c9909))
* **ios:** a title after a reconnect is timed where it is, not up to a metadata block late ([39f9c73](https://github.com/rmotafreitas/react-native-anything-player/commit/39f9c73eb0a326c1dddf3d27463b23b82380f086))
* **ios:** council cache round 1 (Sonnet): hashed file names with a fixed extension, a missing file is not served, recently opened files kept from eviction, downloads cancelled by their own task and idempotent, a download killed after its last byte is done, no length refused, identity encoding, a preload stops at its budget, the proxy stores nothing after a chunk it dropped and honours no-store ([45311b1](https://github.com/rmotafreitas/react-native-anything-player/commit/45311b196b4e840231982a1bbbbb5afb5fac9677))
* **ios:** DASH no longer lists a closed-captions track that shows nothing: its HLS says CLOSED-CAPTIONS=NONE unless the manifest declares CEA-608/708 captions ([96ee27a](https://github.com/rmotafreitas/react-native-anything-player/commit/96ee27af18dda2613490611ae1bd71221e786af1))
* **ios:** downloaded HLS plays offline and is removed: the package is kept by its path in the container (the system names it /.nofollow/…, so the stored path never resolved, the download read as gone and removal left the package); a download is saved as going, so after a relaunch it reads so and one the system lost fails; a package that arrives for a removed or replaced download goes; Cache.info drops an entry whose file the system cleared ([c01b47e](https://github.com/rmotafreitas/react-native-anything-player/commit/c01b47ecfe28e834caf39b15ef9d68488bf2c58c))
* **ios:** Matroska subtitles show on iOS: a window's WebVTT held only the cues that start in it, read from its first keyframe, so a cue still on screen from before (or subtitles turned on mid-file) showed nothing; it now holds every cue on screen in it, reading up to 30 s back for one that began earlier ([fa79fa8](https://github.com/rmotafreitas/react-native-anything-player/commit/fa79fa8620f10e2e26073673eddf9747b24382d8))
* **ios:** MediaCache locals no longer shadow what they call ([4519a92](https://github.com/rmotafreitas/react-native-anything-player/commit/4519a921e8954c29f214836cd8f7d6631920b8f5))
* **ios:** presentFullscreen no longer ends an app that does not allow the locked orientation: UIKit raised when a landscape lock met a portrait-only app; the lock now keeps within the app's orientations ([d5c811e](https://github.com/rmotafreitas/react-native-anything-player/commit/d5c811e0b843bae061262060e6749e6cfe0be0f6))
* **live:** a connection still opening gives no liveOffset: a slow (re)open no longer leaves it seconds too high for a minute ([92b3d0b](https://github.com/rmotafreitas/react-native-anything-player/commit/92b3d0b5dace4cf97fb00e58caa67a7fa0698bf5))
* **live:** a connection's first title names the item its audio begins with, not the live one ([4383df4](https://github.com/rmotafreitas/react-native-anything-player/commit/4383df49dbadd100f6e611b1855b7fbd42784261))
* **live:** a start around a connection's first title is a candidate, marked `first` and left for the next title ([8af6c58](https://github.com/rmotafreitas/react-native-anything-player/commit/8af6c5864ca777433c354e836f62a7f985701ac7))
* **live:** a title is a connection's first only when heard inside its opening audio ([14ab66e](https://github.com/rmotafreitas/react-native-anything-player/commit/14ab66e7ce810eb08c1b82eaf451f015c64826d4))
* **live:** a title superseded while it only shares a first title's start keeps its own time ([fffb785](https://github.com/rmotafreitas/react-native-anything-player/commit/fffb785045675ba6c279a963d62e32019581d41b))
* **live:** a title superseded with a start only half heard keeps its own time ([49566c7](https://github.com/rmotafreitas/react-native-anything-player/commit/49566c7ce6780b67a752ec6f8c5841631c1c6958))
* **live:** a tune-in's item starts at the last gap of the audio its connection opens with, searched as far as the lag grows ([1b9042b](https://github.com/rmotafreitas/react-native-anything-player/commit/1b9042b5d2ef588eb4f5f2ffd8cda95eee695f49))
* **live:** after a reconnect the item playing keeps its title, and the next title is a change ([d29b0c5](https://github.com/rmotafreitas/react-native-anything-player/commit/d29b0c520aaa07062b530a7c946b921caba11279))
* **live:** the silence a connection's audio begins with is not taken for an item's start ([0f61b10](https://github.com/rmotafreitas/react-native-anything-player/commit/0f61b1005ca1e9543bc4d83c31fd3d81d0983638))
* **live:** the title after a connection's first takes the later start when its window shows two ([4b67f0f](https://github.com/rmotafreitas/react-native-anything-player/commit/4b67f0f20e965366e5abacb9bce7887349bdc4a6))
* main's new gates on the queue and cache code: a queue item's refresh and getLicense keep their this, type-aware findings cleared, EngineCore under its line limit, the unused resetWebCache gone; the design doc says what was built ([49d41aa](https://github.com/rmotafreitas/react-native-anything-player/commit/49d41aa85d4c2837337c4cee7b40a4d33512d90b))
* subtitle files load in a React Native development build whose package sits outside the app's folder (a monorepo, the example apps): the parsers are bundled on native instead of lazily imported (Metro could not serve that lazy bundle: SUBTITLE_LOAD_FAILED) ([42a0363](https://github.com/rmotafreitas/react-native-anything-player/commit/42a0363e5fca18f74e2158387a938a77dfc6b88c))
* subtitle parsers come from the React Native host, not a .native file: the extensionless import that a platform file needs broke the plain-web build (a browser loading lib/module cannot resolve it) ([fa07f46](https://github.com/rmotafreitas/react-native-anything-player/commit/fa07f460517ba0188332844cfef57e02bc2a630a))
* **web:** a page waiting on another page's fetch of a file waits for it, then takes the file it stored whole (it stayed queued until its next index write, which may never come; Safari two-tab check); a page writes its index before it lets the file's lock go ([2dcd93c](https://github.com/rmotafreitas/react-native-anything-player/commit/2dcd93cc2419e2072b9edf4d0bd9661178c96a30))
* **web:** a page waits for its own earlier fetch of a file (one being removed) instead of skipping it ([843dd06](https://github.com/rmotafreitas/react-native-anything-player/commit/843dd06b33aa1dbf869f860623442bf61a0c342c))
* **web:** a sample window is timed from its first sample, not its last ([90c0241](https://github.com/rmotafreitas/react-native-anything-player/commit/90c0241ee91cc597bcb24d554c007f9d3fa6a089))
* **web:** council cache round 1 (Haiku): one record per file, a page reads its index before answering, an entry without bytes goes, pages merge their index, files players hold are not evicted, removals stop their fetch, no fetch for a skipped item or a file past the cache's size, progress counted without a second copy; docs say what the web cannot resume ([640ca35](https://github.com/rmotafreitas/react-native-anything-player/commit/640ca35e3db4dee5e07db9a41bac6a22d6aee260))
* **web:** council cache round 1 (Sonnet): no length refused, a part preload stops at its budget, no-store honoured, headers kept for downloads only; docs say what each platform fetches again ([ae30e4b](https://github.com/rmotafreitas/react-native-anything-player/commit/ae30e4bd805d7412d61fc807a2cb21dd269e44e2))
* **web:** council cache round 2 (Haiku): pages write only their own changes to the index and never bring back a removed file, a download with no length fails and says why, a held file is not fetched again (cold page, preload, download), blob URLs stay until their file goes, a cross-origin part has no total, a removal frees the key for a new download; docs ([2da3682](https://github.com/rmotafreitas/react-native-anything-player/commit/2da368284e06e8147c18fd25c16ada731f6cda8a))
* **web:** council round 5 (Sonnet): a removal stays in deleted when the key is asked for again, so the old complete entry goes before the fresh one is written ([0389197](https://github.com/rmotafreitas/react-native-anything-player/commit/038919743a34ae0943487f218cbab7b50a070963))
* **web:** HLS that the browser's own player says it plays but never does goes to hls.js: Chrome on Android fires playing for packed-audio HLS, its clock never moves, then it fails as a network error; native HLS now counts as played once its clock moves, and that failure before it is retried with hls.js ([4cb9038](https://github.com/rmotafreitas/react-native-anything-player/commit/4cb9038ff96e688501fee2c48356df4d2f8a0d9b))


### Changed

* **web:** removals and evictions of independent files run together (React Doctor gate) ([522f8e3](https://github.com/rmotafreitas/react-native-anything-player/commit/522f8e3dc321ca2cd6565998c13f52bbf37a40e4))

## [1.5.1](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.5.0...v1.5.1) (2026-11-04)

A fix for the `jump` a live quality switch reports, and corrected docs and notes after 1.5.0. Nothing is removed or renamed; upgrading needs no change.

### Fixed

- **A switch's `jump` is `null` when a connection jumped first.** A live quality switch that could not be lined up because a connection was replaced or jumped reported, as its `discontinuity`'s `jump`, a gap measured before that jump: a precise-looking wrong number. It is now `null` (not known). The same applies to a switch already given up for another reason when a connection jumps before it takes over. On iOS, Android and the web.
- **The docs describe 1.5.0's rule everywhere.** The `discontinuity` TSDoc, [Events](docs/events.md) and [Internet radio](docs/internet-radio.md) say that any live switch while the app holds a pick can go ahead with a `discontinuity`. [Playback](docs/playback.md)'s WebKit measurement says it was taken under 1.4.0's refusal rule. 1.5.0's notes now say why it is a minor, that a pick goes ahead once lining it up is given up (within 30 s), and that `QUALITY_SWITCH_FAILED` has other causes too ([Errors](docs/errors.md)).

## [1.5.0](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.4.0...v1.5.0) (2026-11-04)

A live quality pick that cannot be lined up goes ahead instead of being refused, and an app that keeps its own place in the station's timeline hears of the jump before the title. Nothing is removed or renamed. One documented live-stream behaviour changes: see **Upgrading**. By [what a version number promises](docs/releases.md#what-a-version-number-promises) that would call for a major; it is a minor because 1.4.0 had been out for a few hours, the change only lets a pick through that was refused, and an app that follows 1.4.0's advice needs no change.

### Added

- **A live quality pick that cannot be lined up goes ahead.** A live switch the app picked with `selectQuality` used to be refused (`QUALITY_SWITCH_FAILED`) when it could not be lined up with what is heard, and tried again a minute later. A pick that can never be lined up, such as a new connection behind what is heard on iOS (AVPlayer cannot run a live stream faster), then never landed. While the app holds a pick, a live switch is now lined up when it can be, and otherwise goes ahead with a `discontinuity` (`reason: 'switch'`) once lining it up is given up (within 30 s), as a switch the player needs already did. Automatic quality (a step up) still waits for one that can be lined up. See [Live renditions](docs/playback.md#live-renditions) ([a4f6ac5](https://github.com/rmotafreitas/react-native-anything-player/commit/a4f6ac5c1254566cbee33d3ca3ca41d4421e861a)).

### Fixed

- **A switch that went ahead without being lined up reports its `discontinuity` before the title the new connection reached.** The title came first, so an app that places its song again on `discontinuity` took it for a song change heard at the song's start. Now the title told after the `discontinuity` is known to be partway into its song. On iOS, Android and the web ([2c7e5f9](https://github.com/rmotafreitas/react-native-anything-player/commit/2c7e5f9feef5946f4f6d3a4a0b847994b7f3a554)).

### Upgrading

- **A pick is no longer refused when it cannot be lined up.** It goes ahead with a `discontinuity` instead. An app that re-opened the source on `QUALITY_SWITCH_FAILED` to force its pick through can stop doing so, and should place its position again on `discontinuity`, as 1.4.0 already advised. `QUALITY_SWITCH_FAILED` no longer comes from a pick that could not be lined up; it still comes from a switch whose new connection fails or is not ready in time (it sits out a minute and is tried again), and from an automatic step up that was refused. See [Errors](docs/errors.md).

## [1.4.0](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.3.1...v1.4.0) (2026-11-03)

Live quality switches that line up with what is heard, and voice and car playback on a fresh install. Nothing is removed or renamed. A few live-stream behaviours change, and an app that handled them itself may need to stop doing so: see **Upgrading**.

### Added

- **Live quality switches line up with what is heard.** A switch between live `renditions` (Icecast mounts at different bitrates, HLS or DASH renditions with program dates, live MPEG-TS sound channels) no longer repeats or skips audio. The new connection is played muted, a little faster or slower, until it reaches the same point in the program, then takes over: within about 0.3 s in Chromium, Firefox, WebKit and on Android, where switches used to land up to 18 s off. Sources that can never be lined up switch as before: a browser's plain `<audio>` (a stream without CORS), a live TS channel with a picture in a browser, and every live TS channel on iOS. iOS has the code for the rest but has not been recorded on a device yet. See [Live renditions](docs/playback.md#live-renditions).
- **`liveOffset` is the whole delay behind live**: the server's burst, the buffer and the decoder. On a progressive stream (ICY, plain HTTP, live TS) it is measured from what has arrived, so it holds steady while audio plays, grows while paused or stalled, and carries on across a lined-up switch. HLS and DASH report their own clock.
- **`liveOffsetSettled`** (on `getProgress()` and `progress`) turns `true` once the connect burst has arrived and `liveOffset` has held for 3 s, so a delay shown to the user, or lyrics placed against it, does not move. It turns `false` again after a `discontinuity` or a new load.
- **`programDate`**: the epoch milliseconds that the stream's own clock gives what plays now (HLS `EXT-X-PROGRAM-DATE-TIME`, DASH), `null` without one. On iOS, DASH converted for AVPlayer now carries program dates too.
- **`discontinuity` says why and by how much**: `reason` (`'reconnect'` or `'switch'`) and `jump` (seconds skipped, or heard again when negative; `null` when unknown).
- **A catalog the app bundles**, for voice assistants and cars on a fresh install that was never opened. With Expo: `["react-native-anything-player", { "catalog": "./catalog.json" }]`, checked at prebuild with `setCatalog`'s rules. Bare apps write the same file into their assets. See [Voice assistants](docs/voice.md#a-catalog-the-app-bundles) ([#80](https://github.com/rmotafreitas/react-native-anything-player/issues/80)).
- **A voice request or car pick for what is already loaded plays on**: no gap, and the app's `updateNowPlaying` fields, headers and DRM stay. A catalog item can set the `quality` it starts at.
- **Cars for one platform**: the plugin's `car: { ios: false }` sets up Android Auto alone, and `{ android: false }` sets up CarPlay alone. CarPlay's scene is added in any plugin order, including with expo-build-properties' `ios.enableSceneSupport`.

### Fixed

- **A player released and created again with the same id is a new one.** A remount in the same tick used to attach to the player being released, which then ended it ("The player was released" on the next command). A released player's late commands, events and status never reach the new one either ([#90](https://github.com/rmotafreitas/react-native-anything-player/issues/90)).
- After a JavaScript reload, the old runtime's late release can no longer end the new runtime's player.
- On Android, an assistant request that opens a fresh install before the app has a catalog now waits for `setCatalog` and plays then, instead of opening the app idle ([#79](https://github.com/rmotafreitas/react-native-anything-player/issues/79)).
- On Safari for iPhone and iPad, a live stream plays through MSE again. It had fallen back to the plain element, which meant no ICY titles and no visualizer.
- The visualizer works for streams in Safari and every iOS browser. It used to draw a flat line, because WebKit reads silence from a stream played through MSE.

### Upgrading

- **A live switch that cannot be lined up is refused when it is optional.** A quality pick or an automatic step up that cannot be lined up (for example, the new mount has not settled) keeps the current quality and reports a non-fatal `QUALITY_SWITCH_FAILED`. Do not re-open the source when you get it: that brings back the gap this release removes. A switch the player needs, because the current connection stalled, still goes ahead and reports a `discontinuity` with `reason: 'switch'`.
- **A lined-up switch reports no `discontinuity`, and positions carry on.** An app that keeps its own place in the station's timeline (a song's progress, lyrics) should place it again on `discontinuity`, not on every change of `status.quality`.
- **`liveOffset` reads larger than before** on progressive streams (it now includes the whole delay) and can be `null` until there is something to measure. Wait for `liveOffsetSettled` before showing it.
- **TypeScript**: progress readings gain `liveOffsetSettled` and `programDate`, and `discontinuity` gains `reason` and `jump`. Code that only reads them needs no change. A test fake that builds these objects needs the new fields.

## [1.3.1](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.3.0...v1.3.1) (2026-10-30)

Quality switching for audio players. This release adds features, so by Semantic Versioning it should have been 1.4.0: the release tool missed the commits that added them. Nothing is removed or renamed, so upgrading is safe.

### Added

- **Audio renditions.** An audio `Player` takes `renditions`, separate files of one sound (e.g. MP3 at 320 and 192 kbps and AAC+ at 64 kbps), and switches between them with no gap, as video does. On iOS and Android this needs no video module; the second player is made only at the first switch. On the web, AirPlay and the visualizer follow the file that is playing. See [Qualities](docs/playback.md#qualities).
- **Automatic quality for audio players.** Every player now reports its bandwidth. An audio player starts at the highest quality (a file starts at what the last reading fits), and two stalls within 30 s step it down. A live stream steps up again after 120 s without a stall; a step up that stalls again waits twice as long next time.
- **A quality pick that holds.** `selectQuality(id)` and the new `load(source, { quality })` are kept for the next loads, matched by id; `'auto'` clears the pick. `Rendition.id` gives stable ids (default `r<index>`). JavaScript refuses an unknown or duplicate id, and `'auto'`, before anything changes.
- **A failed switch is reported**: a non-fatal `error` with the new `QUALITY_SWITCH_FAILED` code and the new file's own failure in `cause`. The current file plays on. See [Errors](docs/errors.md).

### Fixed

- `selectQuality('auto')` lets go of a kept pick even when the current source has nothing to pick from.
- On Safari with AirPlay (as on Cast), a quality switch re-opens the item in place instead of moving to an element the receiver isn't playing.
- The background, listen-only mode and the audio fallback never lower an audio player's quality.

## [1.3.0](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.2.1...v1.3.0) (2026-10-30)

Video, on every platform, as an opt-in part of the same player. Audio apps get the fixes below; the only change to plan for is the JavaScript size (see **Upgrading**).

### Added

- **Video.** `new Player({ video: true })` plays a picture with the same engine, recovery, events and lock-screen integration as audio. `<VideoView player={player} />` shows it in React Native, React Native Web, Expo web and React DOM, and `player.attachTo(element)` on any web page; a player outlives its views, and moving it between views has no gap. Files, HLS and DASH (Shaka on the web, rewritten as HLS for AVPlayer on iOS); renditions (one file per quality) switched behind the picture without a gap; quality caps for the view's size, metered networks and Data Saver; fullscreen, Picture in Picture and `whenBackgrounded` (`pause`, `audio`, `pip`); `nativeControls`; posters, thumbnails, `seekTo(t, { exact })`, loop and playback stats. The qualities to pick from are on the status itself (`status.qualities`, `status.quality`, `status.selectedQuality`), for `selectQuality()`. Opt-in on iOS and Android with the Expo plugin's `video` option (`npx rnap add video`, `rnapVideo=true` / `RNAP_VIDEO=1` without Expo); always available on the web. See [Video](docs/video.md).
- **Matroska, WebM and MPEG-TS everywhere**, files and live IPTV channels, with their audio languages and subtitles. Nothing is transcoded: ExoPlayer reads them, and RNAP remuxes them for AVPlayer and for browsers (on the web the server must allow CORS).
- **Subtitles and tracks.** SubRip, WebVTT, TTML and basic ASS files, encoding detection, a source's own audio languages and subtitles, one overlay that follows the OS caption style, `useCues()`, `subtitleDelay`, and an automatic choice from the OS languages and accessibility settings. See [Subtitles](docs/subtitles.md).
- **DRM.** FairPlay, Widevine, PlayReady and Clear Key: license servers with headers, Clear Key keys in the source, or the app's own `getLicense` exchange. FairPlay is not yet tried on hardware.
- **Video over Google Cast and AirPlay**, with the app's subtitle files on Cast receivers.
- **Android software decoders** (`npx rnap add video-decoders`, `rnapVideoDecoders=true`): FFmpeg for Dolby, DTS and MPEG audio, libvpx and dav1d for VP9 and AV1, used only for what the device cannot decode. They are built in CI from pinned sources and downloaded from this repository's releases, checked against pinned checksums.
- A feature matrix of what audio features do on a video player, per OS and browser engine ([Features](docs/features.md)).

### Fixed

- **A playback rate holds across loads.** On the web, a new source (or hls.js and Shaka attaching later) reset it to 1x while `status.rate` kept the old one; on iOS, a load could start at the default rate; on Android, the rate did not follow the audio to a Cast receiver and back. A Cast receiver now plays the rate set, between 0.5x and 2x, on every platform ([#49](https://github.com/rmotafreitas/react-native-anything-player/issues/49)).
- **The duration and seek range follow what the platform learns.** A fragmented MP4 that reports 18 s at first, then 600 s, no longer keeps seeks clamped to 18 s, and a start position past an early duration waits for the longer one; a Cast receiver's later duration reaches the player too, and an unknown one taken for live becomes a file once known ([#50](https://github.com/rmotafreitas/react-native-anything-player/issues/50)).
- **A stall in the last frame of a file ends it.** WebKitGTK could stop a few milliseconds before the end without `ended`; the engine re-opened the item at its end every few seconds, forever, so a queue or a sleep-at-end never moved on. All three engines now end (or loop) the item ([#59](https://github.com/rmotafreitas/react-native-anything-player/issues/59)).
- **A transient media-pipeline failure is retried.** On the web, a `MediaError` 4 from an element that hls.js, the remuxer or MSE feeds, after its metadata loaded, was reported as a fatal `UNSUPPORTED_FORMAT`; on iOS and Android, a decode or parse failure after the item was ready was fatal too. It is now a recoverable `DECODER_ERROR`, and the engine re-opens the item ([#58](https://github.com/rmotafreitas/react-native-anything-player/issues/58)).
- A player that plays without saying so (WebKitGTK at `readyState` 2) is treated as playing once its playhead runs, instead of being re-opened as a dead stall.
- Android reports no duration for a live stream (the live window's length changed on every refresh), as iOS and the web do.

### Changed

- **A start position costs no wasted request.** hls.js starts loading at the segment that holds it, and iOS seeks the item before it reaches the player, instead of fetching the first segment first ([#57](https://github.com/rmotafreitas/react-native-anything-player/issues/57)).

### Upgrading

- **More JavaScript.** The React Native entry is about 16 KB gzipped (6 KB before), and a web page loads about 56–57 KB (31 KB before), because the video API, the engine's video rules and the subtitle parsers' entry points are part of the main entries, even for an app that plays only audio. Native code for video is only built when you turn it on. See [Comparison](docs/comparison.md).
- Nothing else changes for audio apps: no API was removed or renamed.

## [1.2.1](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.2.0...v1.2.1) (2026-10-24)

Reliability fixes across the three engines and the iOS, Android and web hosts. Late callbacks, timeouts, stalls and `reconnect: false` now behave the same everywhere (22 new conformance scenarios, 127 in all). Three behaviours are stricter (see **Upgrading**).

### Fixed

- **Engine (iOS, Android, web)**
  - A late end or failure from an item that was stopped, failed or released no longer turns the player into `ended` or `error`. An item that ends during a stop's fade-out stays `stopped`, and a repeated end is reported once.
  - `load()` without autoplay (or paused while loading, or refused audio focus) times out after 12 s instead of waiting forever.
  - A silent stall (the playhead freezes while the native player says it is playing) ends as soon as audio moves again, instead of being re-opened from the start. A re-opened file resumes where the playhead got to.
  - `recovery.reconnect: false` is honoured everywhere. Stalls, network changes, returning to the foreground, media-services resets and the drivers' own connection splicing no longer re-open on their own.
  - A source loaded with `live: false` ends at its end even when its duration is unknown, instead of reconnecting.
  - Returning to the foreground at the same moment as a network restore no longer aborts the fresh connection.
  - A sleep timer or fade longer than 24 h is rejected instead of crashing (iOS) or firing at once (Android).
  - ICY: whitespace between fields (`StreamTitle='…'; StreamUrl='…';`) no longer leaks into the title, and the artwork URL is read.
- **iOS**
  - HLS streams whose URL does not end in `.m3u8` play: the stream proxy hands the playlist to AVFoundation instead of breaking its relative segment URLs.
  - A file served without `Content-Length` and loaded with `live: false` ends instead of starting over.
  - The Sound API no longer switches a Player's audio session to `ambient`, which would make the Player obey the silent switch and lose background audio. A Player restores its category when something changed it.
  - The visualizer no longer works on the audio render thread, and it stops with its item.
- **Android:** the Cast title reader keeps asking for ICY metadata, even when the source's headers say `Icy-MetaData: 0`.
- **Web**
  - A play refused by the browser's autoplay policy (from a media key, for instance) no longer makes the next, unrelated command reject with `AUTOPLAY_BLOCKED`.
  - Releasing a player closes its visualizer's `AudioContext` (browsers limit how many a page may have).
  - Google Cast tries to load its SDK again after a failure (offline at page load, for instance).
  - A stream whose buffer stays full is ended and recovered, instead of silently skipping audio.
- **Packaging:** tarballs packed with Yarn include the Codegen specs (`src/native`), and the `exports` map lists `./app.plugin.js`.
- **Expo plugin:** a project name containing a backslash or a quote no longer breaks the App Intents entry in the Xcode project.

### Upgrading

- **`reconnect: false` is now strict.** A stall or a lost connection ends in a fatal `NETWORK_ERROR` instead of recovering; call `play()` to retry. With `reconnect` left on (the default) nothing changes.
- **`load()` with `autoplay: false` can reject with `TIMEOUT`** when the source does not answer within 12 s.
- **Durations over 24 h** in `sleep()`, `fadeTo()` and `fade` reject with `INVALID_ARGUMENT`.
- Files served without `Content-Length`: load them with `live: false` so they end at their end (iOS used to treat them as radio).

## [1.2.0](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.1.1...v1.2.0) (2026-10-23)

Short sounds, cars and watches, a sleep timer, and a CLI that sets up the optional parts. Everything is additive except one rule for catalog ids (see **Upgrading**).

### Added

- **Sound API** (`react-native-anything-player/sound`): short sounds for UI clicks and games, preloaded into memory and played with low latency. Several voices at once (the oldest is stolen when all are busy), per-play volume, rate, pan and loop, a handle per voice, and `stopAll()`. It mixes with other audio and has no media session. iOS on AVAudioEngine, Android on one shared SoundPool (32 voices), the web on Web Audio. Opt-in on iOS and Android with the Expo plugin's `sound` option (`rnapSound=true` / `RNAP_SOUND=1` without Expo); always available on the web. New error code `SOUND_UNAVAILABLE`. See [Sound](docs/sound.md).
- **Cars and watches.** Catalog items take a `group` (`"Jazz"`, `"Podcasts/Daily"`), and the catalog becomes a browse tree in CarPlay, Android Auto, Android Automotive OS and Wear OS, with "Recently played" and favorites (`setCatalog(items, { browse })`, `setFavorites(ids)`). A pick plays through the same path as a voice request and is reported as `searchPlay` with `request.origin: 'browse'`. Long folders are split for car screens, and `searchCatalog` / `playFromSearch` filter by group. CarPlay and Android Auto are opt-in with the plugin's `car` option (`rnapCar` / `RNAP_CAR` without Expo); Wear OS needs nothing. See [Cars & watches](docs/cars-and-watches.md).
- **Sleep timer and fades.** `player.sleep({ after, fadeOut })` pauses after a delay, fading out first; `sleep(null)` cancels it, `status.sleepAt` and a `sleep` event report it, and `useSleepTimer()` counts down. Opt-in fades on play, pause and stop (`new Player({ fade: { in, out } })`, `setFade()`), and `fadeTo(volume, seconds)`. The native engine runs them, so they keep working while JavaScript is frozen in the background. 25 new conformance scenarios, passed by all three engines. See [Playback](docs/playback.md#sleep-timer-and-fades).
- **CLI: modules, size, info, migrate.** `npx rnap` is the documented name. `rnap modules`, `rnap add` and `rnap remove` turn the optional parts on and off (HLS, Cast, Siri, Assistant, the iOS background mode, the Sound API, cars) by writing `gradle.properties`, `Podfile.properties.json` or the Expo plugin's options, after showing the diff. `rnap size` shows what each costs in a release APK and a web page. `rnap info` prints a report to paste into a bug report. `rnap migrate` rewrites react-native-track-player, expo-audio and expo-av code to RNAP where the mapping is mechanical, and marks the rest. A write is atomic and refused if the file changed after its diff was shown. `doctor` reports module settings that disagree. See [CLI](docs/cli.md).

### Changed

- **Web: less JavaScript on page load.** The hls.js glue loads when hls.js is registered (`configureHls`), and Google Cast's driver and Firefox's MP4 repackaging only when they are used: about 8 KB a page without them never loads. The Sound API is its own entry, so a page that only streams does not load it.
- The API reference has a `player` and a `sound` section; links to its old paths redirect.

### Upgrading

- **Catalog ids starting with `rnap:` are rejected** with `INVALID_ARGUMENT`, because the browse tree names its folders with that prefix. Rename such ids before upgrading. No other change is needed.

## [1.1.1](https://github.com/rmotafreitas/react-native-anything-player/compare/v1.1.0...v1.1.1) (2026-10-22)


### Fixed

* **android:** no crash when the network is reported as the runtime starts ([f23a5bb](https://github.com/rmotafreitas/react-native-anything-player/commit/f23a5bb981a9dc1816ea5d0f84b8339baab725be))
* **package:** ship only what apps use ([bcefa0f](https://github.com/rmotafreitas/react-native-anything-player/commit/bcefa0f8967fce8760d3bbd35e3272d4679a8d62))
* **package:** ship the Codegen specs and the autolinking config ([877047c](https://github.com/rmotafreitas/react-native-anything-player/commit/877047c86a4fe05ace640225d81915cbc8d4da74))


### Changed

* **android:** leave out of R8-shrunk apps what RNAP does not use ([5f98caf](https://github.com/rmotafreitas/react-native-anything-player/commit/5f98caf130e5e5cf05c9241a1cdf8b9d94e1ecac))
* **web:** load Google Cast and the MP4 repackaging only when used ([808f335](https://github.com/rmotafreitas/react-native-anything-player/commit/808f3350d43b805be613d9136ab75551aa3af959))

## [1.1.0] — 2026-10-22

The player leaves the phone: the same `Player` on the web (Expo web, React Native Web, React DOM, plain pages), on AirPlay and Google Cast receivers, and behind Siri, Google Assistant and Gemini. Every addition is backwards compatible.

### Added

- **Web.** The `Player` API on the web, in Expo web and React Native Web (picked by the bundler, nothing to configure) and in plain pages through `react-native-anything-player/web`, with no React or React Native dependency. The engine is a TypeScript twin of the Swift and Kotlin engines and passes the same conformance scenarios and ICY cases. Live streams are read with `fetch()` into Media Source Extensions: ICY metadata timed to when it is heard, connections closed on release, and a dropped connection that stayed up ≥ 3 s spliced in without stopping (reported as a `discontinuity`). Streams without CORS, or in codecs MSE cannot take, play on the `<audio>` element. Plus the Media Session (lock screen, media keys), a Web Audio visualizer, and recovery fed by connectivity, Network Information and page-visibility events.
- **Web: Firefox reads MP3 and AAC radio through MSE.** Firefox takes them only inside MP4 (`audio/mp4; codecs="mp3"` / `"mp4a.40.2"`), so RNAP wraps the frames in fragmented MP4 with a built-in muxer where the browser does not take the raw type. ICY titles, splices, the visualizer and `liveOffset` now work there as in Chromium and Safari.
- **Web: HLS with hls.js.** `configureHls(Hls)` (or a global `Hls`) registers the optional [hls.js](https://github.com/video-dev/hls.js); browsers without native HLS then play `.m3u8` sources through it, with ID3 titles as `metadata`, source headers, and recovery under the engine's backoff. Without it, HLS fails with `UNSUPPORTED_FORMAT` and a message that says what to install. A no-op on iOS and Android.
- **React without React Native.** `react-native-anything-player/react`: the `Player`, the hooks and `<button>` versions of `<RoutePicker />` / `<CastButton />` for react-dom apps (Vite, Next.js, Create React App); safe to import while rendering on a server. `react` and `react-native` are now optional peer dependencies, so a web-only app does not install React Native. `example-react/` (Vite) runs in the end-to-end suite.
- **Feature matrix** ([docs/features.md](docs/features.md)): what works where, across iOS, Android and the web entries.
- **Siri shortcuts (App Intents, iOS 16+).** "Play ⟨station⟩ in MyApp", Spotlight, the Shortcuts app and the Action button, on the same catalog, alongside the Siri media extension. The Expo plugin's `siri` option adds the template to the app (`{ "siri": { "appIntents": false } }` opts out); `RNAPVoice` is the native API behind it.
- **CLI.** `npx react-native-anything-player doctor` (`rnap doctor` once installed) checks the project setup, the native build and, with `--url`, stream URLs (cleartext rules, ICY, CORS for the web, Cast codecs); `init` applies the safe fixes, each shown as a diff and confirmed. No dependencies.
- **Migration guides** from react-native-track-player 4 and 5, expo-audio and expo-av.
- **Web: local files.** `player.load(file)` takes a `Blob` or `File` (RNAP makes the object URL and revokes it), and `blob:` and `data:` URLs are accepted. Native still rejects them with `INVALID_SOURCE`. New type `BlobInput`.
- `AUTOPLAY_BLOCKED` error code and `interruption.reason: 'autoplay-blocked'`: the browser refused audible playback without a user gesture.
- **Outputs.** `status.route` (`speaker`, `headphones`, `bluetooth`, `airplay`, `cast`, `car`, …, with the device's name) and a `routeChange` event on every platform. `<RoutePicker />` and `showRoutePicker()`: iOS's AirPlay button, Android's Output Switcher, AirPlay in Safari, Remote Playback in Chrome.
- **Google Cast**, opt-in with the plugin's `cast` option (`rnapCast` / `RNAP_CAST=1` without Expo; Chrome on the web): the engine hands the player on the lock screen to a Cast receiver at the same position and keeps its intent, recovers against the receiver with the usual policy, and brings it back paused when casting ends. Radio titles keep flowing from a metadata-only connection on the phone. `<CastButton />`, `showCastPicker()`, `stopCasting()`, `getCastStatus()`, `useCastStatus()`.
- **Voice assistants.** `setCatalog()` stores what the app can play on the device, so "Hey Siri / Hey Google, play X on MyApp" works even with the app closed (Siri through an Intents extension the plugin adds with `siri: true`; Google Assistant and Gemini through Media3's media library and `MEDIA_PLAY_FROM_SEARCH`). One search, specified by shared test cases, on iOS, Android and the web; `searchCatalog()`, `playFromSearch()`, `setSearchHandler()` and a `searchPlay` event.
- `PlayerOptions.id`: a player with an id outlives the JavaScript that created it, and `new Player({ id })` attaches to it (a player Siri started, or one that kept playing across a reload).
- Error codes `ROUTE_PICKER_UNAVAILABLE`, `CAST_UNAVAILABLE`, `CAST_UNSUPPORTED_SOURCE`.
- `NATIVE_MODULE_MISSING` error code: `new Player()` in Expo Go (or in a binary built before installing RNAP) throws it with the development-build steps, instead of the module lookup crashing on import.
- `example-web/`, a plain-web example, and `yarn test:web`: Playwright in Chromium, Firefox and WebKit against the test radio, including the integration scenarios on the Expo example's web export. The test radio sends CORS headers (`?noCors=1` omits them).
- An API reference on the docs site, generated by TypeDoc from the TSDoc on every public export. CI fails when an export, field or method has no doc comment.

### Changed

- The TurboModule is looked up with `TurboModuleRegistry.get`, so importing the package never throws; a missing module is reported when a player is created.
- `react` and `react-native` are optional peer dependencies: a web-only app (React DOM, plain pages) does not install React Native.
- The engine conformance suite grew from 59 to 80 scenarios (output handoffs), run against three engines (Swift, Kotlin, TypeScript), plus 51 catalog-search cases.

## [1.0.0] — 2026-10-20

The first stable release: the version the [Rádio Animu](https://www.animu.moe) app shipped in its v4.0.1 (October 21, 2026), after running it in production. Earlier development versions (named `react-native-airwave`) are not listed.

### Upgrading from react-native-airwave

The package was renamed to React Native Anything Player (RNAP). Update these names:

| Before | After |
|---|---|
| npm package `react-native-airwave` | `react-native-anything-player` |
| Expo plugin `"react-native-airwave"` | `"react-native-anything-player"` |
| CocoaPod `Airwave` | `AnythingPlayer` (run `pod install`) |
| Android namespace `com.radioanimu.airwave` | `com.anythingplayer` |
| Manifest meta-data `com.radioanimu.airwave.FOREGROUND_TIMEOUT_MS` | `com.anythingplayer.FOREGROUND_TIMEOUT_MS` |
| Gradle `airwaveHls`, `airwaveMedia3Version` | `rnapHls`, `rnapMedia3Version` |
| iOS log subsystem `com.radioanimu.airwave` | `com.anythingplayer` |
| logcat tag `Airwave` | `RNAP` |

The JavaScript API (`Player`, hooks, events, errors) is unchanged.

### Added

- `Player` with `load` / `play` / `pause` / `toggle` / `stop` / `reset` / `seekTo` / `setVolume` / `setMuted` / `setRate` / `updateNowPlaying` / `release`, sequence-numbered status snapshots, synchronous `getProgress()`, and typed events (`status`, `stateChange`, `metadata`, `error`, `ended`, `remoteCommand`, `diagnostic`).
- React hooks: `usePlayerStatus`, `usePlaybackState`, `useProgress`, `useStreamMetadata`, `usePlayerEvent`.
- Native playback engine (Swift and Kotlin twins, one shared conformance suite): play-intent state machine, generation-based stale-event rejection, stall / silent-stall / dead-socket detection, jittered backoff, offline probing, network-handoff awareness, live-edge drift policy, paused-stream connection release, give-up limit.
- iOS: AVPlayer driver; app-owned HTTP connections through an in-process loopback proxy (deterministic connection teardown, late requests refused, parallel AVFoundation requests coalesced onto one connection, dropped live connections spliced into the same response with ICY re-framing); audio-session coordinator (interruptions, route loss, media-services reset); Now Playing and remote commands; background keepalive during recovery.
- Android: ExoPlayer (Media3 1.11.1) driver with gapless live continuations; HTTP through Media3's OkHttp data source, with every call cancelled when its item is torn down (dead sockets close at once, no pooled idle connections); Media3 session service with an engine-backed session player; app-wide audio-focus coordinator (incl. Android 15 background rules); network monitor; recovery wake/Wi-Fi locks.
- ICY metadata normalization shared by both platforms (UTF-8 / Windows-1252, mojibake repair, robust field parsing, configurable title format).
- Normalized `PlayerError` codes preserving native error chains.
- Expo config plugin.
- Example apps (bare React Native and Expo), a controllable ICY test server, on-device integration scenarios, and a soak monitor.
- `player.setAudioSampling()` and the `audioSample` event: decoded-audio windows for visualizers. Android: an ExoPlayer audio-sink tap. iOS: an audio tap for files, and for live streams a parallel AudioToolbox decode of the proxied bytes, released against the item's clock.
- `updateNowPlaying({ duration, elapsed })`: song progress on the lock screen / notification for live streams, advanced natively only while audio plays.
- `updateNowPlaying({ live })`: turns the lock screen / notification "live" badge off (or on) regardless of the stream, for a radio between songs.
- The `discontinuity` event: a live stream's audio jumped because playback moved onto a fresh connection of the same source with no state change (Android: a queued continuation or a reload from a new connection; iOS: a spliced upstream). A new Icecast / Shoutcast connection replays the server's burst of recent audio. Reported when the jump becomes audible (once the new connection's audio plays, also after an outage longer than the buffer), with the progress snapshot already on the new connection; on iOS it needs `progressInterval`.
- `progressInterval` option and the `progress` event: readings from a native timer while playing, which also run JS where the app's timers are frozen (Android background).
- System controls answer as soon as a player with a media session exists, even with nothing loaded. A `play` / `togglePlayPause` that finds nothing loaded is forwarded to JS as `remoteCommand`, so an app iOS relaunched from Control Center can load its source and play.

### Fixed

- iOS: `liveOffset` for live HTTP streams, measured from the audio the stream proxy has handed AVPlayer. `bufferedAhead` alone under-read the delay right after connecting (it covers what AVPlayer has parsed, not the whole connect burst): 11.6 s instead of the 17 s actually heard on a 64 kbps AAC+ station, so anything placed on the station's timeline at tune-in ran 5 s ahead.
- iOS: play stuck in loading after a long paused suspension. iOS reclaims a suspended app's sockets, and the stream proxy kept handing AVPlayer its dead listener: every open timed out and reconnected to the same dead port. The listener is now health-checked (a request through it, ~1 ms) before every open and on return to the foreground. A dead one is replaced, on the same port when possible.
- iOS: the audio session is activated on every play. The system deactivates a suspended app's session (`.appWasSuspended`, or silently), and the cached "active" flag skipped re-activation.
- Android: local (`file://`) artwork is now published as image bytes. The system media controls load an artwork URI themselves, cross-process, and could not open the app's private file (`ENOENT`), so the cover was missing.

[1.1.0]: https://github.com/rmotafreitas/react-native-anything-player/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/rmotafreitas/react-native-anything-player/releases/tag/v1.0.0
