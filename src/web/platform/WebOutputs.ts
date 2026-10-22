// Where the audio goes, page-wide: the browser's own output pickers (AirPlay in
// Safari, Remote Playback in Chrome) and Google Cast. Cast follows the player
// on the lock screen: a session hands that player to the receiver, and ending
// the session (or another player becoming the active one) hands it back.
// Twin of the native output coordinators.

import { PlayerError } from '../../errors';
import type { SourceDescriptor } from '../engine/types';
import { castableUrl } from './CastDriver';
import { CastTitles } from './CastTitles';
import type { CastDevice, CastServiceDelegate } from './CastService';
import type { RuntimeListener, WebRuntime } from './WebRuntime';
import type { WebPlayerController } from './WebPlayerController';

function pickerUnavailable(message: string): PlayerError {
  return new PlayerError({
    code: 'ROUTE_PICKER_UNAVAILABLE',
    message,
    recoverable: false,
    platform: 'web',
  });
}

function unsupportedSource(uri: string): PlayerError {
  return new PlayerError({
    code: 'CAST_UNSUPPORTED_SOURCE',
    message: `A Cast receiver cannot reach ${uri.split(':')[0]}: sources; the player stays on this device.`,
    recoverable: false,
    platform: 'web',
  });
}

export class WebOutputs implements CastServiceDelegate, RuntimeListener {
  private readonly titles = new CastTitles();
  /** The player whose audio is on the receiver, and which output that is. */
  private casting: WebPlayerController | null = null;
  private castOutput = '';
  /** The Cast session in progress, as a device; `null` without one. */
  private device: CastDevice | null = null;
  private pickerAvailable = false;
  private announcedCast = '';
  /** The source last refused for Cast, so the error comes once. */
  private refused: { controller: WebPlayerController; loadId: number } | null =
    null;

  constructor(
    private readonly runtime: WebRuntime,
    private readonly emit: (event: object) => void
  ) {
    runtime.listener = this;
    runtime.cast.delegate = this;
  }

  // ── Output picker ──

  isRoutePickerAvailable(): boolean {
    return this.pickerPlayer()?.pickerAvailable() ?? false;
  }

  /** Opens the picker of `playerId` (else the active player). Synchronous up to the browser's call. */
  showRoutePicker(playerId: string | null): Promise<void> {
    const controller =
      playerId == null
        ? this.pickerPlayer()
        : this.runtime.players.get(playerId);
    if (!controller)
      return Promise.reject(pickerUnavailable('There is no player to route.'));
    return controller.showPicker();
  }

  private pickerPlayer(): WebPlayerController | null {
    const last = [...this.runtime.players.values()].pop();
    return this.runtime.activePlayer ?? last ?? null;
  }

  private refreshAvailability(): void {
    const available = this.isRoutePickerAvailable();
    if (available === this.pickerAvailable) return;
    this.pickerAvailable = available;
    this.emit({ type: 'routePickerAvailability', available });
  }

  // ── Cast ──

  getCastState(): { state: string; device: string | null } {
    const { state, device } = this.runtime.cast;
    return { state, device: device?.name ?? null };
  }

  castStateChanged(): void {
    const status = this.getCastState();
    const key = `${status.state}|${status.device ?? ''}`;
    if (key === this.announcedCast) return;
    this.announcedCast = key;
    this.emit({ type: 'castState', ...status });
  }

  castSessionStarted(device: CastDevice): void {
    this.device = device;
    this.follow(this.runtime.activePlayer);
  }

  castSessionEnded(): void {
    this.device = null;
    this.follow(null);
  }

  /** Makes `target` the one player on the receiver (`null`: none). */
  private follow(target: WebPlayerController | null): void {
    const device = this.device;
    if (this.casting && (this.casting !== target || !device))
      this.handBack(this.casting);
    if (!target || !device) return;
    if (!this.castable(target, target.engine.source, target.status.loadId))
      return;
    const output = `cast:${device.id}`;
    // The same device again (a resumed session): the engine only updates the route.
    if (this.casting === target && this.castOutput === output) return;
    this.handTo(target, device);
  }

  /** Whether `source` (load number `loadId`) can go to a receiver; reports it (once) when not. */
  private castable(
    controller: WebPlayerController,
    source: SourceDescriptor | null,
    loadId: number
  ): boolean {
    if (!source || castableUrl(source.uri)) return true;
    const again =
      this.refused?.controller === controller && this.refused.loadId === loadId;
    if (!again) {
      this.refused = { controller, loadId };
      controller.engineError(unsupportedSource(source.uri), false);
    }
    return false;
  }

  private handTo(controller: WebPlayerController, device: CastDevice): void {
    this.casting = controller;
    this.castOutput = `cast:${device.id}`;
    controller.engine.handoff(
      { kind: 'cast', name: device.name },
      this.castOutput,
      true
    );
    this.titles.update(controller, true);
  }

  /** Back to this device, paused: a hand-back never plays from the phone on its own. */
  private handBack(controller: WebPlayerController): void {
    if (this.casting === controller) this.casting = null;
    this.titles.update(controller, false);
    controller.engine.handoff(controller.currentLocalRoute, 'local', false);
  }

  /**
   * Moves a player that is about to load, before it opens anything: the new
   * item then starts on its final output, with no stop-over on the old one.
   */
  beforeLoad(
    controller: WebPlayerController,
    source: SourceDescriptor,
    autoplay: boolean | null
  ): void {
    const device = this.device;
    if (!device) return;
    const reachable = castableUrl(source.uri) != null;
    if (controller === this.casting) {
      if (reachable) return;
      // The receiver cannot take it: the player returns to this device first.
      this.quiet(controller);
      this.handBack(controller);
      this.castable(controller, source, controller.status.loadId + 1);
      return;
    }
    const wanted = autoplay ?? controller.engine.playWhenReady;
    const active =
      controller === this.runtime.activePlayer ||
      (wanted && controller.options.mediaSession);
    if (!reachable || !active) return;
    if (this.casting) this.handBack(this.casting);
    this.quiet(controller);
    this.handTo(controller, device);
  }

  /** Stops a loaded item, so a handoff only switches the output (nothing opens). */
  private quiet(controller: WebPlayerController): void {
    if (controller.engine.source) controller.engine.stop();
  }

  // ── Runtime ──

  onActiveChanged(
    _previous: WebPlayerController | null,
    next: WebPlayerController | null
  ): void {
    this.follow(next);
    this.refreshAvailability();
  }

  onControllerStatus(controller: WebPlayerController): void {
    this.titles.update(controller, controller === this.casting);
    this.refreshAvailability();
  }

  onControllerAdded(): void {
    this.refreshAvailability();
  }

  onControllerRemoved(controller: WebPlayerController): void {
    this.titles.stop(controller);
    if (this.casting === controller) this.casting = null;
    this.refreshAvailability();
  }

  onOutputsChanged(): void {
    this.refreshAvailability();
  }
}
