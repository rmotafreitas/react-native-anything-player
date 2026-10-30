// A video player's page side: the stage (a box holding the `<video>`, the
// one a quality switch prepares behind it, and the subtitle overlay) that
// `attachTo` / `<VideoView>` put on the page; what the engine needs to know
// about it (attached, on screen, its size), fullscreen, Picture in Picture,
// the screen wake lock, and the app's subtitle files drawn over the picture.

import { PlayerError } from '../../errors';
import { activeCues, nextCueChange } from '../../core/subtitles/schedule';
import type { CueSpan, SubtitleCue } from '../../core/subtitles/types';
import type { PlaybackEngine } from '../engine/PlaybackEngine';
import type { EngineStatus } from '../engine/types';
import {
  browser,
  type AbortControllerLike,
  type AudioElementLike,
  type ElementLike,
  type ObserverLike,
  type VideoElementLike,
  type WakeLockSentinelLike,
} from './dom';
import type { SwapStage } from './SwapDriver';

export type ContentFit = 'contain' | 'cover' | 'fill';

/** What the video needs from its controller. */
export interface VideoHost {
  readonly engine: PlaybackEngine;
  /** The `<video>` on screen now. */
  element(): AudioElementLike;
  /** Emits a player event (`cues`). */
  emit(type: string, payload: Record<string, unknown>): void;
}

function unavailable(what: string): PlayerError {
  return new PlayerError({
    code: 'INVALID_ARGUMENT',
    message: `${what} is not available in this browser.`,
    recoverable: false,
    platform: 'web',
  });
}

const FIT: Record<ContentFit, string> = {
  contain: 'contain',
  cover: 'cover',
  fill: 'fill',
};

/** Where a cue sits, as CSS, when it has no position of its own. */
function edgeStyle(cue: SubtitleCue): Record<string, string> {
  const style: Record<string, string> = {
    left: '5%',
    right: '5%',
    textAlign: cue.align,
  };
  if (cue.vertical === 'top') style.top = '5%';
  else if (cue.vertical === 'middle') {
    style.top = '50%';
    style.transform = 'translateY(-50%)';
  } else style.bottom = '7%';
  return style;
}

const SHIFT_X: Record<SubtitleCue['align'], string> = {
  left: '0',
  center: '-50%',
  right: '-100%',
};
const SHIFT_Y: Record<SubtitleCue['vertical'], string> = {
  top: '0',
  middle: '-50%',
  bottom: '-100%',
};

/** A cue anchored at its own point (ASS `\pos`, WebVTT percentages, TTML regions). */
function pointStyle(cue: SubtitleCue): Record<string, string> {
  const x = cue.x ?? 0.5;
  const y = cue.y ?? 0.9;
  return {
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    transform: `translate(${SHIFT_X[cue.align]}, ${SHIFT_Y[cue.vertical]})`,
    textAlign: cue.align,
    maxWidth: '90%',
  };
}

/** A view that showed the picture: when the newest goes, the one before gets it back. */
interface Owner {
  readonly element: ElementLike;
  readonly fit: ContentFit;
  readonly controls: boolean;
}

export class WebVideo implements SwapStage {
  readonly stage: ElementLike;
  private readonly overlay: ElementLike;
  private container: ElementLike | null = null;
  /** The views that asked for the picture, newest last. */
  private owners: Owner[] = [];
  /**
   * Where the stage waits without a view: in the page, out of sight. A
   * media element taken out of the page is paused by the browser, and the
   * sound must go on.
   */
  private parking: ElementLike | null = null;
  /** The document listeners, removed on release. */
  private readonly listeners: AbortControllerLike;
  private visible = false;
  private width = 0;
  private height = 0;
  private fit: ContentFit = 'contain';
  /** The browser's own controls on the picture (`nativeControls`). */
  private controls = false;
  private observers: ObserverLike[] = [];
  private readonly listening = new Set<AudioElementLike>();
  private wakeLock: Promise<WakeLockSentinelLike | null> | null = null;
  // ── Subtitles ──
  private session: string | null = null;
  private readonly cues = new Map<string, SubtitleCue[]>();
  /** The source's own text track's cues on screen now (`track:` ids). */
  private sourceCueList: SubtitleCue[] = [];
  private shownCues: SubtitleCue[] = [];
  private shown: number[] = [];
  private shownTrack: string | null = null;
  private cueTimer: number | null = null;
  private status: EngineStatus | null = null;

  constructor(private readonly host: VideoHost) {
    const document = browser().document!;
    this.stage = document.createElement('div');
    Object.assign(this.stage.style, {
      position: 'relative',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      backgroundColor: 'black',
    });
    this.overlay = document.createElement('div');
    Object.assign(this.overlay.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2',
    });
    this.stage.appendChild(this.overlay);
    this.listeners = new (browser().AbortController)();
    const signal = this.listeners.signal;
    const changed = () => this.fullscreenChanged();
    document.addEventListener('fullscreenchange', changed, { signal });
    document.addEventListener('webkitfullscreenchange', changed, { signal });
  }

  // ── The page ──

  /** Puts the stage in `container` (`null` takes it out of every view). */
  attach(
    container: ElementLike | null,
    fit: ContentFit = this.fit,
    controls = this.controls
  ): void {
    this.owners = this.owners.filter((o) => o.element !== container);
    if (container) this.owners.push({ element: container, fit, controls });
    else this.owners = [];
    this.place(container, fit, controls);
  }

  /**
   * A view goes (`<VideoView>`'s cleanup): the picture leaves `container`
   * only if it is still there, for the newest view left, if any. A newer
   * view keeps it.
   */
  detach(container: ElementLike): void {
    this.owners = this.owners.filter((o) => o.element !== container);
    if (container !== this.container) return;
    const next = this.owners.at(-1);
    if (next) this.place(next.element, next.fit, next.controls);
    else this.place(null, this.fit, this.controls);
  }

  private place(
    container: ElementLike | null,
    fit: ContentFit,
    controls: boolean
  ): void {
    this.fit = fit;
    this.applyFit();
    this.controls = controls;
    const current = this.host.element() as VideoElementLike;
    for (const e of this.listening)
      (e as VideoElementLike).controls = controls && e === current;
    if (container === this.container) return this.report();
    this.disconnect();
    const shown = this.container != null;
    this.container = container;
    if (container) {
      container.appendChild(this.stage);
      this.parking?.remove();
      this.observe();
    } else if (shown) {
      this.park();
    } else {
      // Never in the page: nothing for the browser to pause.
    }
    this.visible = container != null;
    this.report();
  }

  /** Keeps the stage in the page, unseen, at the size it had (the quality cap stays). */
  private park(): void {
    const document = browser().document!;
    const parent = document.body;
    if (!parent) return this.stage.remove();
    const parking = (this.parking ??= document.createElement('div'));
    parking.setAttribute('aria-hidden', 'true');
    Object.assign(parking.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${Math.max(1, this.width)}px`,
      height: `${Math.max(1, this.height)}px`,
      overflow: 'hidden',
      opacity: '0',
      pointerEvents: 'none',
      zIndex: '-1',
    });
    parking.appendChild(this.stage);
    parent.appendChild(parking);
  }

  /** Shows `element` (the one on screen now) and hides the other. */
  show(element: AudioElementLike, hidden: AudioElementLike | null): void {
    for (const e of [element, hidden]) {
      const video = e as VideoElementLike | null;
      if (video == null) continue;
      if (video.parentNode == null) this.stage.appendChild(video);
      Object.assign(video.style, {
        position: 'absolute',
        inset: '0',
        visibility: video === element ? 'visible' : 'hidden',
        zIndex: video === element ? '1' : '0',
      });
      video.controls = this.controls && video === element;
      this.listen(video);
    }
    this.applyFit();
  }

  /** The poster until the first frame (`null`: none). */
  setPoster(poster: string | null): void {
    const video = this.host.element() as VideoElementLike;
    video.poster = poster ?? '';
  }

  release(): void {
    this.disconnect();
    this.listeners.abort();
    this.stage.remove();
    this.parking?.remove();
    this.parking = null;
    this.owners = [];
    this.container = null;
    this.releaseWakeLock();
    this.clearCueTimer();
  }

  private applyFit(): void {
    for (const e of this.listening) {
      (e as VideoElementLike).style.objectFit = FIT[this.fit];
    }
  }

  private observe(): void {
    const g = browser();
    if (g.IntersectionObserver) {
      const io = new g.IntersectionObserver(
        (entries) => {
          const entry = entries.at(-1);
          if (!entry) return;
          this.visible = entry.isIntersecting && entry.intersectionRatio > 0;
          this.report();
        },
        { threshold: [0, 0.01] }
      );
      io.observe(this.stage);
      this.observers.push(io);
    }
    if (g.ResizeObserver) {
      const ro = new g.ResizeObserver((entries) => {
        const rect = entries.at(-1)?.contentRect;
        if (!rect) return;
        this.width = rect.width;
        this.height = rect.height;
        this.overlay.style.fontSize = `${Math.max(14, Math.round(rect.height * 0.05))}px`;
        this.report();
      });
      ro.observe(this.stage);
      this.observers.push(ro);
    }
  }

  private disconnect(): void {
    this.observers.forEach((o) => o.disconnect());
    this.observers = [];
  }

  /** Tells the engine where the picture is (pixels for the quality cap). */
  private report(): void {
    const ratio = browser().devicePixelRatio ?? 1;
    this.host.engine.viewChanged({
      attached: this.container != null,
      visible: this.container != null && this.visible,
      width: Math.round(this.width * ratio),
      height: Math.round(this.height * ratio),
    });
  }

  /** Fullscreen and Picture in Picture events of an element shown on the stage. */
  private listen(video: VideoElementLike): void {
    if (this.listening.has(video)) return;
    this.listening.add(video);
    const signal = this.listeners.signal;
    const on = (type: string, handler: () => void) =>
      video.addEventListener(type, handler, { signal });
    const pip = () => this.pictureInPictureChanged();
    on('enterpictureinpicture', pip);
    on('leavepictureinpicture', pip);
    on('webkitpresentationmodechanged', () => {
      pip();
      this.fullscreenChanged();
    });
    on('webkitbeginfullscreen', () => this.host.engine.fullscreenChanged(true));
    on('webkitendfullscreen', () => this.host.engine.fullscreenChanged(false));
    const cues = () => this.refreshCues();
    on('timeupdate', cues);
    on('seeked', cues);
    on('playing', cues);
  }

  // ── Fullscreen & Picture in Picture ──

  /** Call inside a user gesture: browsers allow both only there. */
  async setFullscreen(active: boolean, lock: string | false): Promise<void> {
    const g = browser();
    const document = g.document!;
    const video = this.host.element() as VideoElementLike;
    if (!active) {
      if (document.fullscreenElement) await document.exitFullscreen?.();
      else if (document.webkitFullscreenElement)
        document.webkitExitFullscreen?.();
      else video.webkitExitFullscreen?.();
      g.screen?.orientation?.unlock?.();
      return;
    }
    if (this.stage.requestFullscreen) await this.stage.requestFullscreen();
    else if (this.stage.webkitRequestFullscreen)
      this.stage.webkitRequestFullscreen();
    // iPhone Safari: only the video itself, in the system player.
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
    else throw unavailable('Fullscreen');
    if (lock) await g.screen?.orientation?.lock?.(lock).catch(() => undefined);
  }

  async setPictureInPicture(active: boolean): Promise<void> {
    const document = browser().document!;
    const video = this.host.element() as VideoElementLike;
    if (!active) {
      if (document.pictureInPictureElement)
        await document.exitPictureInPicture?.();
      else video.webkitSetPresentationMode?.('inline');
      return;
    }
    if (video.requestPictureInPicture) await video.requestPictureInPicture();
    else if (video.webkitSupportsPresentationMode?.('picture-in-picture'))
      video.webkitSetPresentationMode!('picture-in-picture');
    else throw unavailable('Picture in Picture');
  }

  private fullscreenChanged(): void {
    const document = browser().document!;
    const element =
      document.fullscreenElement ?? document.webkitFullscreenElement ?? null;
    const video = this.host.element() as VideoElementLike;
    const active =
      element === this.stage ||
      element === video ||
      video.webkitPresentationMode === 'fullscreen';
    this.host.engine.fullscreenChanged(active);
  }

  private pictureInPictureChanged(): void {
    const document = browser().document!;
    const video = this.host.element() as VideoElementLike;
    const active =
      (document.pictureInPictureElement != null &&
        document.pictureInPictureElement === video) ||
      video.webkitPresentationMode === 'picture-in-picture';
    this.host.engine.pictureInPictureChanged(active);
  }

  // ── The status ──

  /** Every status: the wake lock and the subtitles follow it. */
  statusChanged(status: EngineStatus): void {
    this.status = status;
    if (this.host.engine.wantsScreenAwake) this.holdWakeLock();
    else this.releaseWakeLock();
    this.refreshCues();
  }

  private holdWakeLock(): void {
    if (this.wakeLock != null) return;
    const lock = browser().navigator?.wakeLock;
    this.wakeLock = lock
      ? lock.request('screen').catch(() => null)
      : Promise.resolve(null);
  }

  private releaseWakeLock(): void {
    const lock = this.wakeLock;
    this.wakeLock = null;
    lock?.then((sentinel) => sentinel?.release()).catch(() => undefined);
  }

  // ── Subtitles ──

  /** A new load: its subtitle files are this session's. */
  beginSession(session: string | null): void {
    this.session = session;
    this.cues.clear();
    this.sourceCueList = [];
    this.refreshCues();
  }

  /** An app subtitle file's cues, once loaded (`null` before). */
  cuesFor(trackId: string): SubtitleCue[] | null {
    return this.cues.get(trackId) ?? null;
  }

  /** The source's own text track's active cues (the browser draws none). */
  sourceCues(cues: SubtitleCue[]): void {
    this.sourceCueList = cues;
    this.refreshCues();
  }

  /** An app subtitle file's cues (sorted by start). */
  setCues(session: string, trackId: string, cues: SubtitleCue[]): void {
    if (session !== this.session) return;
    this.cues.set(trackId, cues);
    this.refreshCues();
  }

  /** Draws the cues on screen now and plans the next change. */
  private refreshCues(): void {
    this.clearCueTimer();
    const video = this.status?.video ?? null;
    const track = video?.textTrack ?? null;
    if (track != null && track.startsWith('track:') && !this.cues.has(track)) {
      // The source's own track: its cues as the browser reports them.
      const source = this.sourceCueList;
      if (track !== this.shownTrack || source !== this.shownCues) {
        this.shownTrack = track;
        this.shown = [];
        this.shownCues = source;
        this.draw(source);
        this.host.emit('cues', { cues: source });
      }
      return;
    }
    const cues = (track != null ? this.cues.get(track) : null) ?? [];
    const position = this.host.element().currentTime;
    const delay = video?.subtitleDelay ?? 0;
    const active = activeCues(cues, position, delay);
    if (
      track !== this.shownTrack ||
      !sameIndices(active, this.shown) ||
      this.shownCues.length > 0
    ) {
      this.shownTrack = track;
      this.shown = active;
      this.shownCues = [];
      this.draw(active.map((i) => cues[i]!));
      this.host.emit('cues', { cues: active.map((i) => cues[i]!) });
    }
    const next = nextCueChange(cues, position, delay);
    const element = this.host.element();
    if (next == null || element.paused) return;
    const rate = element.playbackRate || 1;
    this.cueTimer = browser().setTimeout(
      () => this.refreshCues(),
      Math.max(10, ((next - position) / rate) * 1000)
    );
  }

  private clearCueTimer(): void {
    if (this.cueTimer != null) browser().clearTimeout(this.cueTimer);
    this.cueTimer = null;
  }

  private draw(cues: SubtitleCue[]): void {
    const document = browser().document!;
    const boxes = cues.map((cue) => {
      const box = document.createElement('div');
      const place =
        cue.x != null || cue.y != null ? pointStyle(cue) : edgeStyle(cue);
      Object.assign(box.style, {
        position: 'absolute',
        whiteSpace: 'pre-line',
        ...place,
      });
      for (const span of cue.spans) box.appendChild(spanElement(span));
      return box;
    });
    if (this.overlay.replaceChildren) this.overlay.replaceChildren(...boxes);
    else {
      this.overlay.textContent = '';
      boxes.forEach((b) => this.overlay.appendChild(b));
    }
  }
}

function sameIndices(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A styled run, readable on any picture (outlined, on a translucent band). */
function spanElement(span: CueSpan): ElementLike {
  const element = browser().document!.createElement('span');
  element.textContent = span.text;
  Object.assign(element.style, {
    color: span.color ?? '#ffffff',
    fontWeight: span.bold ? 'bold' : 'normal',
    fontStyle: span.italic ? 'italic' : 'normal',
    textDecoration: span.underline ? 'underline' : 'none',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    textShadow: '0 0 3px #000',
    lineHeight: '1.3',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    padding: '0 0.2em',
  });
  return element;
}
