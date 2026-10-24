// Video, the layer between the quality (EngineQuality.ts) and the system
// inputs (PlaybackEngine.ts): what a video player does in the background and
// off screen, when the picture is decoded, its audio focus and media session,
// keeping the screen on, refreshing a signed source, and the
// quality-of-experience counters. The twins (`ios/Core/PlaybackEngine.swift`,
// `android/.../core/PlaybackEngine.kt`) hold the same code in their one type.
//
// Everything here runs on the engine's own wake-ups and heartbeat, so it keeps
// working while JavaScript is frozen; an audio player (`options.video` null)
// only gets the refresh, the counters and `loop`.

import type { PlayerError } from '../../errors';
import { EngineQuality, notVideoPlayer } from './EngineQuality';
import { RecoveryPolicy } from './RecoveryPolicy';
import type {
  AudioOnlyReason,
  EngineStats,
  EngineVideoStatus,
  PlaybackState,
  SourceDescriptor,
  VideoEngineOptions,
  VideoInfo,
  ViewState,
} from './types';

/** States in which the screen stays on for a visible video player. */
const AWAKE_STATES: ReadonlySet<PlaybackState> = new Set<PlaybackState>([
  'loading',
  'buffering',
  'playing',
  'reconnecting',
]);

/** States a rebuffer goes on through (the user is still waiting). */
const REBUFFER_STATES: ReadonlySet<PlaybackState> = new Set<PlaybackState>([
  'buffering',
  'reconnecting',
  'loading',
]);

interface PendingRefresh {
  reason: 'unauthorized' | 'expiring';
  deadline: number;
  /** The failure that asked for it (`unauthorized`). */
  error: PlayerError | null;
}

export abstract class EngineVideo extends EngineQuality {
  // ── Surroundings ──
  protected backgrounded = false;
  /** No view since this instant: the picture goes off `VIEW_DETACH_GRACE_MS` later. */
  protected detachedSince: number | null = null;
  /** In the background without Picture in Picture: pause at this instant. */
  protected pipDecisionAt: number | null = null;

  // ── The picture ──
  protected firstFrame = false;
  /** What the driver was last told (`null`: nothing yet; drivers start with the picture on). */
  protected appliedVideoEnabled: boolean | null = null;
  protected lastAudioOnly: AudioOnlyReason | null = null;

  // ── Refresh ──
  protected pendingRefresh: PendingRefresh | null = null;
  protected refreshAskAt: number | null = null;
  /** Bumped by every `sourceRefreshed`; `openedRevision` is its value at the last open. */
  protected sourceRevision = 0;
  protected openedRevision = 0;

  // ── Stats ──
  protected loadStartedAt: number | null = null;
  protected rebufferSince: number | null = null;

  // ── Queries ──

  /** The player should own a media session (lock screen, notification). */
  get wantsMediaSession(): boolean {
    const v = this.options.video;
    if (v == null) return true;
    return !(v.ambient || (this.muted && !v.focusWhenMuted));
  }

  /** Keep the screen on: a video playing in a visible view. */
  get wantsScreenAwake(): boolean {
    const v = this.options.video;
    if (v == null || !v.keepAwake || v.ambient) return false;
    if (!this.view.attached || !this.view.visible || this.backgrounded)
      return false;
    return this._playWhenReady && AWAKE_STATES.has(this._state);
  }

  /** Start-up, rebuffers and switches since the last `load()`. */
  get stats(): EngineStats {
    const since = this.rebufferSince;
    const ongoing = since != null ? this.now - since : 0;
    return { ...this.counters, rebufferMs: this.counters.rebufferMs + ongoing };
  }

  protected get focusExempt(): boolean {
    const v = this.options.video;
    if (v == null) return false;
    return v.ambient || (this.muted && !v.focusWhenMuted);
  }

  // ── Commands ──

  /** Plays the sound alone (an audio-only variant or rendition where there is one). */
  setListenOnly(value: boolean): void {
    this.ensureAlive();
    if (this.options.video == null) throw notVideoPlayer();
    this.listenOnly = value;
    this.applyOutput('listen-only');
    this.commit();
  }

  /** The app's new source for `loadId` (after `engineRequestsSourceRefresh`). */
  sourceRefreshed(loadId: number, next: SourceDescriptor): void {
    if (this.isReleased) return;
    if (loadId !== this._loadId || this._source == null) {
      this.log('refresh ignored', { loadId: `${loadId}` });
      return;
    }
    const pending = this.pendingRefresh;
    this.pendingRefresh = null;
    this._source = { ...next, refreshable: true };
    if (next.renditions != null && this.renditions != null)
      this.renditions = next.renditions.map((r) => ({ ...r }));
    this.sourceRevision += 1;
    this.armExpiry();
    this.log('source refreshed', { reason: pending?.reason ?? 'none' });
    if (pending?.reason === 'unauthorized') this.useRefreshedSource();
    this.commit();
  }

  /** The app could not make a new source for `loadId`. */
  sourceRefreshFailed(loadId: number): void {
    if (this.isReleased || loadId !== this._loadId) return;
    const pending = this.pendingRefresh;
    this.pendingRefresh = null;
    this.log('refresh failed', { reason: pending?.reason ?? 'none' });
    const error = pending?.reason === 'unauthorized' ? pending.error : null;
    if (error != null) {
      this.settlePendingLoad({ kind: 'failed', error });
      this.fail(error);
    }
    this.commit();
  }

  // ── System inputs ──

  /** The app went to the background (`whenBackgrounded`). */
  appBackgrounded(): void {
    if (this.isReleased || this.backgrounded) return;
    this.backgrounded = true;
    const v = this.options.video;
    if (v != null && !this.pictureOnAnotherScreen) {
      this.backgroundPolicy(v);
      this.applyOutput('background');
    }
    this.commit();
  }

  /** The view showing the player changed (mounted, scrolled, resized). */
  viewChanged(next: ViewState): void {
    if (this.isReleased) return;
    const previous = this.view;
    this.view = { ...next };
    const v = this.options.video;
    if (v == null) return;
    if (next.attached) this.detachedSince = null;
    else if (previous.attached) this.detachedSince = this.now;
    else this.detachedSince ??= this.now;
    if (v.ambient) this.ambientCheck();
    this.applyOutput('view');
    this.commit();
  }

  pictureInPictureChanged(active: boolean): void {
    if (this.isReleased || active === this.pictureInPicture) return;
    this.pictureInPicture = active;
    this.log('picture in picture', { active: `${active}` });
    if (active) this.pipDecisionAt = null;
    else this.pictureInPictureClosed();
    this.applyOutput('picture in picture');
    this.commit();
  }

  // ── Driver observations ──

  onVideoInfo(generation: number, info: VideoInfo): void {
    if (!this.accepts(generation))
      return this.logStale('video info', generation);
    this.videoInfo = { ...info };
    const index = this.currentRendition;
    const r = index != null ? this.renditions?.[index] : null;
    if (r?.height == null && r != null && info.height > 0)
      r.height = info.height;
    this.applyQuality('video info');
    this.commit();
  }

  onFirstFrame(generation: number): void {
    if (!this.accepts(generation))
      return this.logStale('first frame', generation);
    this.firstFrame = true;
    this.commit();
  }

  // ── Hooks the core calls ──

  protected videoStatus(): EngineVideoStatus | null {
    if (this.options.video == null) return null;
    const info = this.videoInfo;
    return {
      width: info?.width ?? null,
      height: info?.height ?? null,
      hdr: info?.hdr ?? false,
      firstFrame: this.firstFrame,
      audioOnly: this.audioOnlyReason,
      pictureInPicture: this.pictureInPicture,
      qualities: this.qualityList(),
      quality: this.currentQualityId(),
      selectedQuality: this.selectedQuality,
    };
  }

  protected videoLoad(): void {
    this.loadStartedAt = this.now;
    this.counters = {
      startupMs: null,
      rebufferCount: 0,
      rebufferMs: 0,
      qualitySwitches: 0,
      audioOnlySwitches: 0,
    };
    this.rebufferSince = null;
    this.pendingRefresh = null;
    this.sourceRevision = 0;
    this.openedRevision = 0;
    this.armExpiry();
    const v = this.options.video;
    if (v == null) return;
    this.firstFrame = false;
    this.resetQuality();
    if (!this.view.attached) this.detachedSince ??= this.now;
    this.lastAudioOnly = this.audioOnlyReason;
    if (v.ambient && !this.shown && this._playWhenReady) {
      // Not on screen: it starts when its view is (nothing is open to pause).
      this._playWhenReady = false;
      this._interruption = {
        reason: this.backgrounded ? 'background' : 'offscreen',
        resumable: true,
        since: this.clock.wallMs,
      };
    }
  }

  protected openTarget(source: SourceDescriptor): {
    source: SourceDescriptor;
    rendition: number | null;
  } {
    const index = this.currentRendition;
    if (this.renditions == null || index == null)
      return { source, rendition: null };
    return { source: this.renditionSource(index), rendition: index };
  }

  protected videoOpened(): void {
    this.openedRevision = this.sourceRevision;
    if (this.options.video == null || this.renditions != null) return;
    // A new item starts from the driver's defaults: tell it the caps again.
    this.appliedQuality = null;
    this.applyQuality('open');
  }

  protected completeSwap(): void {
    super.completeSwap();
    this.openedRevision = this.sourceRevision;
  }

  protected refreshOnFailure(error: PlayerError): boolean {
    if (this._source?.refreshable !== true) return false;
    if (error.httpStatus !== 401 && error.httpStatus !== 403) return false;
    if (this.sourceRevision > this.openedRevision) {
      // A new source came in ahead (`expiresAt`): use it now.
      this.log('refreshed source', { note: 'already here' });
      this.useRefreshedSource();
      return true;
    }
    if (this.pendingRefresh?.reason === 'unauthorized') return true;
    this.lastError = error;
    this.requestRefresh('unauthorized', error);
    if (this._playWhenReady) {
      if (!this.isLive) this.rememberPosition();
      this.recoveringSince ??= this.now;
      this.nextAttemptAt = null;
      this.reconnectReason = 'refresh';
      this.setState('reconnecting', 'waiting for a new source');
    }
    return true;
  }

  protected videoPlaying(t: number): void {
    const started = this.loadStartedAt;
    if (this.counters.startupMs == null && started != null)
      this.counters.startupMs = t - started;
    this.endRebuffer(t);
  }

  protected stallPublished(t: number): void {
    this.counters.rebufferCount += 1;
    this.rebufferSince ??= t;
    if (this.options.video == null || this.remote) return;
    if (this.audioOnlyReason == null) {
      this.stallTimes.push(t);
      this.stallTimes = this.stallTimes.filter(
        (s) => t - s < RecoveryPolicy.FALLBACK_PROBE_MS
      );
    }
    this.evaluateAbr(t, true);
    this.evaluateFallback(t, true);
  }

  protected stateChanged(next: PlaybackState): void {
    if (this.rebufferSince != null && !REBUFFER_STATES.has(next))
      this.endRebuffer(this.now);
  }

  protected unmuted(): void {
    const v = this.options.video;
    if (v == null || v.ambient || v.focusWhenMuted) return;
    if (this.remote || !this._playWhenReady) return;
    // A muted video took no focus: it asks now, and a refusal pauses it.
    const focus = this.delegate?.engineRequestsAudioFocus() ?? 'granted';
    if (focus === 'granted') return;
    const delayed = focus === 'delayed';
    this.systemPause(
      delayed ? 'audio-focus-delayed' : 'audio-focus-denied',
      delayed
    );
  }

  protected videoWakeup(t: number): void {
    const pip = this.pipDecisionAt;
    if (pip != null && pip <= t) this.pipDecision();
    const detached = this.detachedSince;
    const grace = RecoveryPolicy.VIEW_DETACH_GRACE_MS;
    if (detached != null && t - detached >= grace) this.noViewDue();
    const refresh = this.pendingRefresh;
    if (refresh != null && refresh.deadline <= t) this.refreshTimedOut(refresh);
    const ask = this.refreshAskAt;
    if (ask != null && ask <= t) this.expiryDue();
    const swap = this.pendingSwap;
    if (swap != null && t - swap.startedAt >= RecoveryPolicy.SWAP_TIMEOUT_MS)
      this.dropSwap(swap, 'timeout');
  }

  protected videoWakeups(candidates: number[]): void {
    if (this.pipDecisionAt != null) candidates.push(this.pipDecisionAt);
    const detached = this.detachedSince;
    if (detached != null && this.pictureMayGoOff)
      candidates.push(detached + RecoveryPolicy.VIEW_DETACH_GRACE_MS);
    if (this.pendingRefresh != null)
      candidates.push(this.pendingRefresh.deadline);
    if (this.refreshAskAt != null) candidates.push(this.refreshAskAt);
    const swap = this.pendingSwap;
    if (swap != null)
      candidates.push(swap.startedAt + RecoveryPolicy.SWAP_TIMEOUT_MS);
  }

  /** The app came back (`appForegrounded`). */
  protected videoForegrounded(): void {
    if (!this.backgrounded) return;
    this.backgrounded = false;
    this.pipDecisionAt = null;
    const v = this.options.video;
    if (v == null) return;
    if (v.ambient) {
      this.ambientCheck();
    } else if (this.pausedFor('background')) {
      this._interruption = null;
      this.startPlayback('foreground');
    } else {
      // Paused for good (`whenBackgrounded: 'pause'`), or never paused.
    }
    this.applyOutput('foreground');
  }

  /** The watchdog's tick, while playback is wanted. */
  protected videoHeartbeat(t: number): void {
    if (this.options.video == null || this.remote) return;
    if (this._state !== 'playing') return;
    // A switch a seek or a pause cancelled is tried again.
    if (this.renditions != null && this.pendingSwap == null)
      this.retarget('resume switch');
    this.evaluateAbr(t, false);
    this.evaluateFallback(t, false);
  }

  // ── Internals ──

  /** The picture is on another screen (Cast, AirPlay): the app's state does not matter. */
  protected get pictureOnAnotherScreen(): boolean {
    return this.remote || this.route.kind === 'airplay';
  }

  /** The view is attached, visible, and the app in the foreground. */
  protected get shown(): boolean {
    return this.view.attached && this.view.visible && !this.backgrounded;
  }

  protected get audioOnlyReason(): AudioOnlyReason | null {
    if (this.options.video == null) return null;
    if (this.listenOnly) return 'listen';
    if (this.backgroundAudio) return 'background';
    if (this.fallbackActive) return 'fallback';
    return null;
  }

  /** `whenBackgrounded: 'audio'` applies now. */
  protected get backgroundAudio(): boolean {
    const v = this.options.video;
    if (v == null || v.ambient || !this.backgrounded) return false;
    if (this.pictureInPicture || this.pictureOnAnotherScreen) return false;
    return v.whenBackgrounded === 'audio';
  }

  /** Decode the picture: something shows it, or a view went away only just now. */
  protected get wantsPicture(): boolean {
    if (this.audioOnlyReason != null) return false;
    if (this.pictureInPicture || this.view.attached || this.remote) return true;
    const since = this.detachedSince;
    if (since == null) return true;
    return this.now - since < RecoveryPolicy.VIEW_DETACH_GRACE_MS;
  }

  /** The no-view grace can still turn the picture off. */
  protected get pictureMayGoOff(): boolean {
    if (this.options.video == null || this._source == null) return false;
    return this.appliedVideoEnabled !== false;
  }

  /** The system paused it for `reason` and may resume it. */
  protected pausedFor(reason: 'background' | 'offscreen'): boolean {
    const i = this._interruption;
    return i != null && i.resumable && i.reason === reason;
  }

  protected backgroundPolicy(v: VideoEngineOptions): void {
    if (v.ambient) return this.ambientCheck();
    if (this.pictureInPicture) return;
    if (v.whenBackgrounded === 'pip') {
      // Picture in Picture may start a moment after the app leaves.
      this.pipDecisionAt = this.now + RecoveryPolicy.PIP_GRACE_MS;
      return;
    }
    if (v.whenBackgrounded === 'pause' && this._playWhenReady)
      this.systemPause('background', false);
  }

  /**
   * Closing Picture in Picture from the background pauses, unless the app
   * comes back ("back to app" brings the app forward right after).
   */
  protected pictureInPictureClosed(): void {
    const v = this.options.video;
    if (v == null || v.ambient || !this.backgrounded) return;
    if (v.whenBackgrounded !== 'audio')
      this.pipDecisionAt = this.now + RecoveryPolicy.PIP_GRACE_MS;
  }

  /** The Picture in Picture grace ran out in the background. */
  protected pipDecision(): void {
    this.pipDecisionAt = null;
    if (!this.backgrounded || this.pictureInPicture) return;
    if (this._playWhenReady) this.systemPause('background', false);
  }

  protected noViewDue(): void {
    if (this.appliedVideoEnabled !== false) this.applyOutput('no view');
  }

  protected expiryDue(): void {
    this.refreshAskAt = null;
    if (this.pendingRefresh == null) this.requestRefresh('expiring', null);
  }

  /** An ambient player plays only when shown, and resumes when shown again. */
  protected ambientCheck(): void {
    if (!this.shown) {
      if (this._playWhenReady)
        this.systemPause(this.backgrounded ? 'background' : 'offscreen', true);
      return;
    }
    const waiting = this.pausedFor('background') || this.pausedFor('offscreen');
    if (waiting && this._source != null) {
      this._interruption = null;
      this.startPlayback('on screen');
    }
  }

  /** Sends what changed about the picture: on or off, audio only, the quality. */
  protected applyOutput(cause: string): void {
    if (this.options.video == null || this._source == null) return;
    const reason = this.audioOnlyReason;
    if (reason !== this.lastAudioOnly) {
      if (this.lastAudioOnly == null) this.counters.audioOnlySwitches += 1;
      this.log('audio only', { reason: reason ?? 'off', cause });
      this.lastAudioOnly = reason;
    }
    const on = this.wantsPicture;
    if (on !== (this.appliedVideoEnabled ?? true)) {
      this.appliedVideoEnabled = on;
      this.driver.setVideoEnabled?.(on);
      this.log('picture', { on: `${on}`, cause });
    }
    this.applyQuality(cause);
  }

  protected endRebuffer(t: number): void {
    const since = this.rebufferSince;
    if (since == null) return;
    this.counters.rebufferMs += t - since;
    this.rebufferSince = null;
  }

  /** A 401/403 met a source the app already replaced, or the app's answer came. */
  protected useRefreshedSource(): void {
    const opening = this._playWhenReady || this.pendingLoadId != null;
    if (opening || this._state === 'loading') {
      if (!this.isLive && this.readyForGeneration) this.rememberPosition();
      this.reopen('refreshed source');
    } else {
      this.connectionReleased = true;
    }
  }

  protected armExpiry(): void {
    const source = this._source;
    const expires = source?.expiresAt;
    if (source?.refreshable !== true || expires == null) {
      this.refreshAskAt = null;
      return;
    }
    const left = expires - this.clock.wallMs - RecoveryPolicy.REFRESH_AHEAD_MS;
    this.refreshAskAt = this.now + Math.max(0, left);
  }

  protected requestRefresh(
    reason: 'unauthorized' | 'expiring',
    error: PlayerError | null
  ): void {
    this.pendingRefresh = {
      reason,
      deadline: this.now + RecoveryPolicy.REFRESH_TIMEOUT_MS,
      error,
    };
    this.log('refresh requested', { reason });
    this.delegate?.engineRequestsSourceRefresh?.(this._loadId, reason);
  }

  /** The app did not answer in time (JavaScript frozen, a slow token server). */
  protected refreshTimedOut(refresh: PendingRefresh): void {
    this.pendingRefresh = null;
    this.log('refresh timed out', { reason: refresh.reason });
    const error = refresh.error;
    if (refresh.reason !== 'unauthorized' || error == null) return;
    this.settlePendingLoad({ kind: 'failed', error });
    if (this._playWhenReady && this.options.reconnect) {
      // Try the old source again in the backoff; a 401/403 asks again.
      this.pendingEvents.push(() => this.delegate?.engineError(error, false));
      this.scheduleReconnect('refresh timed out');
    } else {
      this.fail(error);
    }
  }
}
