// A video player's quality, the layer between the fades (EngineFades.ts) and
// the rest of video (EngineVideo.ts): the caps an adaptive source's own ABR
// keeps to; the engine's own ABR over separate files of one video
// (renditions), switched behind the picture under a new generation; and the
// audio-only fallback on a network too slow for any picture. The twins
// (`ios/Core/PlaybackEngine.swift`, `android/.../core/PlaybackEngine.kt`) hold
// the same code in their one type.

import type { PlayerError } from '../../errors';
import { EngineFades } from './EngineFades';
import { RecoveryPolicy } from './RecoveryPolicy';
import {
  engineError,
  type AudioOnlyReason,
  type EngineStats,
  type FallbackPolicy,
  type QualityConstraints,
  type Rendition,
  type SourceDescriptor,
  type VideoInfo,
  type VideoQuality,
  type VideoVariant,
  type ViewState,
} from './types';

/** Heights a view's size is rounded up to before it caps an adaptive source. */
const STANDARD_HEIGHTS = [144, 240, 360, 480, 540, 720, 1080, 1440, 2160, 4320];

interface PendingSwap {
  generation: number;
  rendition: number;
  startedAt: number;
}

function minOf(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

export function notVideoPlayer(): PlayerError {
  return engineError(
    'INVALID_ARGUMENT',
    'This is not a video player (create it with `video`).',
    false
  );
}

export abstract class EngineQuality extends EngineFades {
  // ── What the quality depends on ──
  protected view: ViewState = {
    attached: false,
    visible: false,
    width: 0,
    height: 0,
  };
  protected pictureInPicture = false;
  /** The view's cap when Picture in Picture started: it holds while the window is up. */
  protected pipCap: number | null = null;
  protected metered = false;
  protected saveData = false;
  protected listenOnly = false;
  protected videoInfo: VideoInfo | null = null;
  protected variants: VideoVariant[] = [];
  /** The constraints the driver was last given (an adaptive source). */
  protected appliedQuality: string | null = null;

  // ── Renditions ──
  protected renditions: Rendition[] | null = null;
  protected selectedQuality: string | null = null;
  /** The engine's own pick among the renditions (automatic quality). */
  protected abrLevel: number | null = null;
  protected currentRendition: number | null = null;
  protected pendingSwap: PendingSwap | null = null;
  protected failedUntil = new Map<number, number>();
  /** The last bandwidth reading, kept across loads for the next start. */
  protected bandwidth: number | null = null;
  /** When this load last had a reading. */
  protected bandwidthAt: number | null = null;
  protected stallTimes: number[] = [];
  protected lastSwitchAt = -Infinity;
  /** The bandwidth has been under the current rendition's bitrate since… */
  protected abrLowSince: number | null = null;
  /** …above `ABR_UP_RATIO` × the next one's since. */
  protected abrUpSince: number | null = null;

  // ── The audio-only fallback ──
  protected fallbackActive = false;
  protected fallbackSince: number | null = null;
  /** The bandwidth has been under the fallback's drop ratio since… */
  protected dropSince: number | null = null;
  /** …above its return ratio since. */
  protected returnSince: number | null = null;

  protected counters: EngineStats = {
    startupMs: null,
    rebufferCount: 0,
    rebufferMs: 0,
    qualitySwitches: 0,
    audioOnlySwitches: 0,
  };

  /** The last bandwidth estimate, bits per second (`getStats`). */
  get bandwidthEstimate(): number | null {
    return this.bandwidth;
  }

  /** Why the sound plays alone, if it does (EngineVideo.ts). */
  protected abstract get audioOnlyReason(): AudioOnlyReason | null;
  /** Sends what changed about the picture (EngineVideo.ts). */
  protected abstract applyOutput(cause: string): void;

  // ── Commands ──

  /** Pins a quality (`status.video.qualities[].id`), or `null` for automatic. */
  selectQuality(id: string | null): void {
    this.ensureAlive();
    if (this.options.video == null) throw notVideoPlayer();
    if (id != null && !this.qualityList().some((q) => q.id === id)) {
      throw engineError('INVALID_ARGUMENT', `No quality "${id}".`, false);
    }
    this.selectedQuality = id;
    this.log('quality selected', { id: id ?? 'auto' });
    this.applyQuality('selected');
    this.commit();
  }

  /** The platform read a rendition's height or bitrate from its file. */
  renditionInfo(
    index: number,
    height: number | null,
    bitrate: number | null
  ): void {
    const r = this.renditions?.[index];
    if (this.isReleased || r == null) return;
    if (height != null) r.height = height;
    if (bitrate != null) r.bitrate = bitrate;
    this.commit();
  }

  /** A metered network (cellular caps) and the OS's data saver. */
  networkCostChanged(metered: boolean, saveData: boolean): void {
    if (this.isReleased) return;
    if (metered === this.metered && saveData === this.saveData) return;
    this.metered = metered;
    this.saveData = saveData;
    this.applyQuality('network cost');
    this.commit();
  }

  // ── Driver observations ──

  /** A bandwidth estimate, bits per second (for the current item or a switch's). */
  onBandwidth(generation: number, bitsPerSecond: number): void {
    if (!this.accepts(generation) && !this.isSwapGeneration(generation)) return;
    if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return;
    const t = this.now;
    this.bandwidth = bitsPerSecond;
    this.bandwidthAt = t;
    this.trackBandwidth(t, bitsPerSecond);
  }

  /** An adaptive source's qualities. */
  onVariants(generation: number, variants: VideoVariant[]): void {
    if (!this.accepts(generation)) return this.logStale('variants', generation);
    this.variants = variants.map((v) => ({ ...v }));
    // A pick among renditions stands: each file's variants are not the list.
    const selected = this.selectedQuality;
    if (
      selected != null &&
      this.renditions == null &&
      !this.variants.some((v) => v.id === selected)
    )
      this.selectedQuality = null;
    this.applyQuality('variants');
    this.commit();
  }

  // ── Quality switches (hooks the core calls) ──

  protected isSwapGeneration(generation: number): boolean {
    if (this.isReleased) return false;
    return this.pendingSwap?.generation === generation;
  }

  protected completeSwap(): void {
    const swap = this.pendingSwap;
    if (swap == null) return;
    this.pendingSwap = null;
    this._generation = swap.generation;
    this.currentRendition = swap.rendition;
    this.readyForGeneration = true;
    this.connectionReleased = false;
    this.lastSwitchAt = this.now;
    this.abrLowSince = null;
    this.abrUpSince = null;
    this.counters.qualitySwitches += 1;
    this.log('quality switched', { to: `r${swap.rendition}` });
  }

  protected swapFailed(error: PlayerError): void {
    const swap = this.pendingSwap;
    if (swap != null) this.dropSwap(swap, `failed: ${error.code}`);
  }

  protected swapNote(event: string): void {
    this.log('quality switch', { event });
  }

  protected cancelSwap(reason: string): void {
    const swap = this.pendingSwap;
    if (swap == null) return;
    this.pendingSwap = null;
    this.driver.cancelSwap?.(swap.generation);
    this.log('quality switch cancelled', { reason });
  }

  // ── Internals ──

  /** A new source: the renditions and the quality facts start over. */
  protected resetQuality(): void {
    this.videoInfo = null;
    this.variants = [];
    this.selectedQuality = null;
    this.fallbackActive = false;
    this.fallbackSince = null;
    this.stallTimes = [];
    this.failedUntil.clear();
    this.bandwidthAt = null;
    this.abrLowSince = null;
    this.abrUpSince = null;
    this.dropSince = null;
    this.returnSince = null;
    this.lastSwitchAt = -Infinity;
    this.appliedQuality = null;
    const renditions = this._source?.renditions;
    this.renditions =
      renditions != null && renditions.length > 0
        ? renditions.map((r) => ({ ...r }))
        : null;
    this.abrLevel = this.renditions != null ? this.startLevel() : null;
    this.currentRendition = this.targetRendition();
  }

  /** The quality the status reports as playing. */
  protected currentQualityId(): string | null {
    if (this.renditions == null) return this.videoInfo?.variantId ?? null;
    const index = this.currentRendition;
    return index != null ? `r${index}` : null;
  }

  protected applyQuality(cause: string): void {
    if (this.options.video == null || this._source == null) return;
    if (this.renditions != null) {
      this.retarget(cause);
      return;
    }
    const c = this.constraints();
    const key = `${c.maxHeight}|${c.maxBitrate}|${c.pinned}|${c.audioOnly}`;
    if (key === this.appliedQuality) return;
    this.appliedQuality = key;
    this.driver.setQuality?.(c);
  }

  /** The caps for an adaptive source's ABR (and the allowed renditions). */
  protected constraints(): QualityConstraints {
    const q = this.options.video!.quality;
    let { maxHeight, maxBitrate } = q;
    if (this.metered) {
      maxHeight = minOf(maxHeight, q.cellularMaxHeight);
      maxBitrate = minOf(maxBitrate, q.cellularMaxBitrate);
    }
    if (this.saveData && q.followDataSaver)
      maxHeight = minOf(maxHeight, RecoveryPolicy.DATA_SAVER_MAX_HEIGHT);
    if (q.capToView) maxHeight = minOf(maxHeight, this.viewCap());
    return {
      maxHeight,
      maxBitrate,
      pinned: this.renditions == null ? this.selectedQuality : null,
      audioOnly: this.audioOnlyReason != null,
    };
  }

  /** The picture height the view can show (contain fit), rounded up; `null`: no cap. */
  protected viewCap(): number | null {
    // Picture in Picture keeps the quality it started with: no switch (and
    // no rebuffer) on the way in or back for a window that small.
    if (this.pictureInPicture) return this.pipCap;
    const view = this.view;
    if (!view.attached || view.height <= 0) return null;
    const shown = this.shownHeight(view);
    if (this.renditions == null)
      return STANDARD_HEIGHTS.find((h) => h >= shown) ?? null;
    // The smallest rendition that fills it.
    const heights = this.renditions
      .filter((r) => !r.audioOnly && r.height != null)
      .map((r) => r.height!)
      .filter((h) => h >= shown)
      .sort((a, b) => a - b);
    return heights[0] ?? null;
  }

  /** How many rows of the picture the view shows. */
  protected shownHeight(view: ViewState): number {
    const info = this.videoInfo;
    if (info == null || info.width <= 0 || info.height <= 0) return view.height;
    if (view.width <= 0) return view.height;
    const scale = Math.min(view.width / info.width, view.height / info.height);
    return info.height * scale;
  }

  protected qualityList(): VideoQuality[] {
    const table = this.renditions;
    if (table == null) return this.variants;
    return table.map((r, i) => ({
      id: `r${i}`,
      height: r.height,
      bitrate: r.bitrate,
      audioOnly: r.audioOnly,
      label: r.label,
    }));
  }

  protected renditionSource(index: number): SourceDescriptor {
    const source = this._source!;
    const r = this.renditions![index]!;
    return {
      uri: r.uri,
      headers: r.headers ?? source.headers,
      liveHint: source.liveHint,
      drm: source.drm ?? null,
    };
  }

  /** A rendition's bitrate, or an estimate from its height and a known one. */
  protected bitrateOf(index: number): number | null {
    const table = this.renditions!;
    const r = table[index]!;
    if (r.bitrate != null) return r.bitrate;
    if (r.height == null) return null;
    const known = table.find(
      (k) => !k.audioOnly && k.bitrate != null && k.height != null
    );
    if (known == null) return null;
    return Math.round(known.bitrate! * (r.height / known.height!) ** 2);
  }

  /** The video renditions, lowest first. */
  protected videoOrder(): number[] {
    const table = this.renditions;
    if (table == null) return [];
    const indices: number[] = [];
    table.forEach((r, i) => {
      if (!r.audioOnly) indices.push(i);
    });
    return indices.sort((a, b) => this.compareRenditions(a, b));
  }

  protected compareRenditions(a: number, b: number): number {
    const ba = this.bitrateOf(a);
    const bb = this.bitrateOf(b);
    if (ba != null && bb != null && ba !== bb) return ba - bb;
    const ha = this.renditions![a]!.height;
    const hb = this.renditions![b]!.height;
    if (ha != null && hb != null && ha !== hb) return ha - hb;
    return a - b;
  }

  /** The video renditions the caps allow and none failed of, lowest first. */
  protected allowedOrder(): number[] {
    const order = this.videoOrder();
    if (order.length === 0) return order;
    const t = this.now;
    const usable = order.filter((i) => (this.failedUntil.get(i) ?? 0) <= t);
    const pool = usable.length > 0 ? usable : order;
    const c = this.constraints();
    const allowed = pool.filter((i) => this.withinCaps(i, c));
    return allowed.length > 0 ? allowed : [pool[0]!];
  }

  protected withinCaps(index: number, c: QualityConstraints): boolean {
    const height = this.renditions![index]!.height;
    const bitrate = this.bitrateOf(index);
    if (c.maxHeight != null && height != null && height > c.maxHeight)
      return false;
    return c.maxBitrate == null || bitrate == null || bitrate <= c.maxBitrate;
  }

  protected audioRendition(): number | null {
    const index = this.renditions?.findIndex((r) => r.audioOnly) ?? -1;
    return index >= 0 ? index : null;
  }

  /** The highest rendition that fits a bandwidth, among `order` (lowest first). */
  protected fitting(order: number[], bandwidth: number): number | null {
    let best: number | null = null;
    for (const i of order) {
      const bitrate = this.bitrateOf(i);
      if (
        bitrate != null &&
        bitrate <= RecoveryPolicy.ABR_FIT_RATIO * bandwidth
      )
        best = i;
    }
    return best;
  }

  protected startLevel(): number | null {
    const order = this.allowedOrder();
    if (order.length === 0) return null;
    const start = this.options.video!.quality.startQuality;
    if (start === 'lowest') return order[0]!;
    if (start === 'highest') return order.at(-1)!;
    if (typeof start === 'number') return this.tallestUpTo(order, start);
    if (this.bandwidth != null)
      return this.fitting(order, this.bandwidth) ?? order[0]!;
    return this.automaticStart(order);
  }

  /** The tallest rendition no taller than `height`, or the lowest. */
  protected tallestUpTo(order: number[], height: number): number {
    let pick = order[0]!;
    for (const i of order) {
      const h = this.renditions![i]!.height;
      if (h != null && h <= height) pick = i;
    }
    return pick;
  }

  /** No bandwidth reading yet: the lowest at least 480p (or the tallest under it). */
  protected automaticStart(order: number[]): number {
    const table = this.renditions!;
    const tall = order.find((i) => {
      const h = table[i]!.height;
      return h != null && h >= RecoveryPolicy.START_MIN_HEIGHT;
    });
    if (tall != null) return tall;
    const allKnown = order.every((i) => table[i]!.height != null);
    return allKnown ? order.at(-1)! : order[0]!;
  }

  /** Which rendition should play now. */
  protected targetRendition(): number | null {
    if (this.renditions == null) return null;
    const audio = this.audioRendition();
    if (this.audioOnlyReason != null && audio != null) return audio;
    const selected = this.selectedQuality;
    if (selected != null) {
      const index = Number(selected.slice(1));
      const failed = (this.failedUntil.get(index) ?? 0) > this.now;
      return failed ? this.currentRendition : index;
    }
    const order = this.allowedOrder();
    if (order.length === 0) return this.currentRendition;
    const level = this.abrLevel;
    if (level == null) return order[0]!;
    if (order.includes(level)) return level;
    // Not allowed any more (caps, a failure): the highest allowed below it.
    const all = this.videoOrder();
    const position = all.indexOf(level);
    const below = order.filter((i) => all.indexOf(i) < position);
    return below.length > 0 ? below.at(-1)! : order[0]!;
  }

  /** Moves to the target rendition if it changed. */
  protected retarget(cause: string): void {
    const target = this.targetRendition();
    if (target == null) return;
    const swap = this.pendingSwap;
    if (swap?.rendition === target) return;
    if (swap != null) this.cancelSwap('retarget');
    if (target !== this.currentRendition) this.moveTo(target, cause);
  }

  protected moveTo(target: number, cause: string): void {
    const open = this.readyForGeneration && !this.connectionReleased;
    const flowing = this._state === 'playing' || this._state === 'buffering';
    // A Cast receiver plays one item: it re-opens in place.
    if (flowing && open && this._playWhenReady && !this.remote)
      return this.startSwap(target, cause);
    this.currentRendition = target;
    // Stopped, ended, failed or reconnecting: the next open uses it.
    const reopens =
      this._state === 'loading' ||
      (open && (flowing || this._state === 'paused'));
    if (!reopens) return;
    // A load still opening keeps its start position.
    if (open && !this.isLive) this.rememberPosition();
    this.reopen(`quality: ${cause}`);
  }

  protected startSwap(target: number, cause: string): void {
    const position = this.isLive ? null : this.driver.sample().position;
    const generation = this.issueGeneration();
    this.pendingSwap = { generation, rendition: target, startedAt: this.now };
    this.log('quality switch', { to: `r${target}`, cause });
    this.driver.open({
      generation,
      source: this.renditionSource(target),
      startPosition: position,
      playWhenReady: true,
      allowReconnect: this.options.reconnect,
      swap: true,
      rendition: target,
    });
  }

  /** A switch that failed or timed out: its file sits out a while. */
  protected dropSwap(swap: PendingSwap, reason: string): void {
    this.failedUntil.set(
      swap.rendition,
      this.now + RecoveryPolicy.FAILED_RENDITION_MS
    );
    if (this.abrLevel === swap.rendition) this.abrLevel = this.currentRendition;
    this.cancelSwap(reason);
  }

  protected trackBandwidth(t: number, bps: number): void {
    this.trackFallbackBandwidth(t, bps);
    if (this.options.video == null || this.renditions == null) return;
    const level = this.abrLevel ?? this.currentRendition;
    const bitrate = level != null ? this.videoBitrateOf(level) : null;
    if (bitrate != null && bps < bitrate) this.abrLowSince ??= t;
    else this.abrLowSince = null;
    const next = level != null ? this.nextAllowed(level) : null;
    const nextBitrate = next != null ? this.bitrateOf(next) : null;
    if (nextBitrate != null && bps > RecoveryPolicy.ABR_UP_RATIO * nextBitrate)
      this.abrUpSince ??= t;
    else this.abrUpSince = null;
  }

  /** A video rendition's bitrate (`null` for the audio-only one). */
  protected videoBitrateOf(index: number): number | null {
    return this.renditions![index]!.audioOnly ? null : this.bitrateOf(index);
  }

  /** The allowed rendition above `index`, if any. */
  protected nextAllowed(index: number): number | null {
    const order = this.allowedOrder();
    const position = order.indexOf(index);
    if (position < 0) return null;
    return order[position + 1] ?? null;
  }

  protected trackFallbackBandwidth(t: number, bps: number): void {
    const f = this.options.video?.fallback;
    const lowest = this.lowestVideoBitrate();
    if (f == null || lowest == null) return;
    if (bps < f.dropBelowRatio * lowest) this.dropSince ??= t;
    else this.dropSince = null;
    if (bps > f.returnAboveRatio * lowest) this.returnSince ??= t;
    else this.returnSince = null;
  }

  protected lowestVideoBitrate(): number | null {
    if (this.renditions != null) {
      const order = this.videoOrder();
      return order.length > 0 ? this.bitrateOf(order[0]!) : null;
    }
    const bitrates = this.variants
      .filter((v) => !v.audioOnly && v.bitrate != null)
      .map((v) => v.bitrate!);
    return bitrates.length > 0 ? Math.min(...bitrates) : null;
  }

  protected hasAudioOption(): boolean {
    if (this.renditions != null) return this.audioRendition() != null;
    return this.variants.some((v) => v.audioOnly);
  }

  protected stallsWithin(t: number, windowMs: number): number {
    return this.stallTimes.filter((s) => t - s < windowMs).length;
  }

  /** The bandwidth reading of this load, if it had one. */
  protected get currentBandwidth(): number | null {
    return this.bandwidthAt != null ? this.bandwidth : null;
  }

  /** The engine picks among the renditions itself (none pinned, the picture on). */
  protected get automaticRenditions(): boolean {
    return (
      this.renditions != null &&
      this.selectedQuality == null &&
      this.audioOnlyReason == null
    );
  }

  /** The engine's own ABR over the renditions (automatic quality only). */
  protected evaluateAbr(t: number, stalled: boolean): void {
    if (!this.automaticRenditions) return;
    const order = this.allowedOrder();
    // The engine's pick, whether or not its switch has landed yet.
    const level = this.abrLevel ?? this.currentRendition;
    if (order.length === 0 || level == null) return;
    const position = Math.max(0, order.indexOf(level));
    const next = stalled
      ? this.stallStep(order, position, t)
      : this.bandwidthStep(order, position, t);
    if (next === position && order[position] === this.abrLevel) return;
    this.abrLevel = order[next]!;
    this.abrLowSince = null;
    this.abrUpSince = null;
    this.retarget(stalled ? 'stall' : 'bandwidth');
  }

  /** A stall steps down: to what the bandwidth fits, or one step without a reading. */
  protected stallStep(order: number[], position: number, t: number): number {
    if (position === 0) return 0;
    const bw = this.currentBandwidth;
    const bitrate = this.bitrateOf(order[position]!);
    const repeated =
      this.stallsWithin(t, RecoveryPolicy.ABR_STALL_WINDOW_MS) >= 2;
    const slow =
      bw != null &&
      bitrate != null &&
      bw < RecoveryPolicy.ABR_STALL_RATIO * bitrate;
    if (!repeated && !slow) return position;
    if (bw == null) return position - 1;
    const fit = this.fitting(order.slice(0, position), bw);
    return fit != null ? order.indexOf(fit) : 0;
  }

  /** Sustained low bandwidth steps down; sustained headroom steps up. */
  protected bandwidthStep(
    order: number[],
    position: number,
    t: number
  ): number {
    const low = this.abrLowSince;
    if (position > 0 && low != null && t - low >= RecoveryPolicy.ABR_LOW_MS)
      return position - 1;
    if (position < order.length - 1 && this.canStepUp(t)) return position + 1;
    return position;
  }

  protected canStepUp(t: number): boolean {
    const up = this.abrUpSince;
    if (up == null || t - up < RecoveryPolicy.ABR_UP_MS) return false;
    if (t - this.lastSwitchAt < RecoveryPolicy.ABR_UP_MS) return false;
    return this.stallsWithin(t, RecoveryPolicy.ABR_UP_MS) === 0;
  }

  /** The audio-only fallback (`fallbackToAudio`). */
  protected evaluateFallback(t: number, stalled: boolean): void {
    const f = this.options.video?.fallback;
    if (f == null || this.listenOnly) return;
    if (!this.hasAudioOption()) {
      if (this.fallbackActive) this.endFallback('no audio-only option');
      return;
    }
    if (this.fallbackActive) {
      this.checkFallbackReturn(t, f);
      return;
    }
    const cause = this.fallbackCause(t, stalled, f);
    if (cause != null) this.startFallback(t, cause);
  }

  /** Why the picture should go now, or `null`. */
  protected fallbackCause(
    t: number,
    stalled: boolean,
    f: FallbackPolicy
  ): string | null {
    // The renditions step down first; audio is the step below the lowest.
    if (!this.atLowestRendition) return null;
    const drop = this.dropSince;
    if (drop != null && t - drop >= f.dropAfterMs) return 'slow network';
    if (stalled && this.stallsWithin(t, f.stallWindowMs) >= f.dropAfterStalls)
      return 'stalls';
    return null;
  }

  protected get atLowestRendition(): boolean {
    if (this.renditions == null || this.selectedQuality != null) return true;
    const order = this.allowedOrder();
    return order.length === 0 || this.currentRendition === order[0];
  }

  protected startFallback(t: number, cause: string): void {
    this.fallbackActive = true;
    this.fallbackSince = t;
    this.stallTimes = [];
    this.dropSince = null;
    this.returnSince = null;
    this.applyOutput(cause);
  }

  protected checkFallbackReturn(t: number, f: FallbackPolicy): void {
    const since = this.fallbackSince ?? t;
    const back = this.returnSince;
    if (back != null && t - back >= f.returnAfterMs) {
      this.endFallback('network recovered');
      return;
    }
    // No reading since the drop: try the picture again after a quiet minute.
    const measured = this.bandwidthAt != null && this.bandwidthAt >= since;
    if (measured || t - since < RecoveryPolicy.FALLBACK_PROBE_MS) return;
    if (this.stallsWithin(t, RecoveryPolicy.FALLBACK_PROBE_MS) === 0)
      this.endFallback('probe');
  }

  protected endFallback(cause: string): void {
    this.fallbackActive = false;
    this.fallbackSince = null;
    this.dropSince = null;
    this.returnSince = null;
    this.stallTimes = [];
    this.applyOutput(cause);
  }
}
