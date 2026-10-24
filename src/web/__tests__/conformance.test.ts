/// <reference types="node" />
// Runs every scenario in the `conformance` JSON files against the web engine.
// Twin of `android/src/test/.../ConformanceTest.kt` and
// `ios/Tests/AnythingPlayerCoreTests/ConformanceTests.swift`.

import fs from 'node:fs';
import path from 'node:path';
import type { AudioRouteKind, PlayerErrorCode } from '../../types';
import {
  DEFAULT_ENGINE_OPTIONS,
  DEFAULT_FALLBACK_POLICY,
  DEFAULT_VIDEO_OPTIONS,
  type EngineOptions,
} from '../engine/RecoveryPolicy';
import {
  engineError,
  type EngineVideoStatus,
  type InterruptionReason,
  type NetworkState,
  type Rendition,
  type VideoEngineOptions,
  type VideoVariant,
} from '../engine/types';
import { EngineHarness, WALL_BASE, type Motion } from './EngineHarness';

type Step = Record<string, unknown>;
interface Scenario {
  name: string;
  options?: Record<string, unknown>;
  steps: Step[];
}

const DIR = path.resolve(__dirname, '../../../conformance');
const FILES = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

const scenarios: Array<[string, Scenario]> = FILES.flatMap((file) =>
  (JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as Scenario[]).map(
    (s): [string, Scenario] => [`${file} › ${s.name}`, s]
  )
);

function engineOptions(o: Record<string, unknown> = {}): EngineOptions {
  const options = { ...DEFAULT_ENGINE_OPTIONS };
  if ('giveUpAfterMs' in o)
    options.giveUpAfterMs = o.giveUpAfterMs as number | null;
  if ('reconnect' in o) options.reconnect = o.reconnect as boolean;
  if ('autoResumeAfterInterruption' in o) {
    options.autoResumeAfterInterruption =
      o.autoResumeAfterInterruption as boolean;
  }
  if ('liveMaxDriftMs' in o)
    options.liveMaxDriftMs = o.liveMaxDriftMs as number;
  if ('fadeInMs' in o) options.fadeInMs = o.fadeInMs as number;
  if ('fadeOutMs' in o) options.fadeOutMs = o.fadeOutMs as number;
  if ('video' in o) options.video = videoOptions(o.video);
  return options;
}

/** `"video": true` or partial `VideoEngineOptions` (`"fallback": true` takes its defaults). */
function videoOptions(value: unknown): VideoEngineOptions {
  if (value === true) return DEFAULT_VIDEO_OPTIONS;
  const o = value as Record<string, unknown>;
  const fallback = o.fallback;
  return {
    ...DEFAULT_VIDEO_OPTIONS,
    ...(o as Partial<VideoEngineOptions>),
    quality: {
      ...DEFAULT_VIDEO_OPTIONS.quality,
      ...((o.quality as object | undefined) ?? {}),
    },
    fallback:
      fallback === true
        ? DEFAULT_FALLBACK_POLICY
        : fallback == null || fallback === false
          ? null
          : { ...DEFAULT_FALLBACK_POLICY, ...(fallback as object) },
  };
}

function renditions(value: unknown): Rendition[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((r: Record<string, unknown>) => ({
    uri: r.uri as string,
    headers: null,
    height: (r.height as number | undefined) ?? null,
    bitrate: (r.bitrate as number | undefined) ?? null,
    label: null,
    audioOnly: r.audioOnly === true,
  }));
}

function variants(value: unknown): VideoVariant[] {
  return (value as Array<Record<string, unknown>>).map((v) => ({
    id: v.id as string,
    height: (v.height as number | undefined) ?? null,
    bitrate: (v.bitrate as number | undefined) ?? null,
    audioOnly: v.audioOnly === true,
    label: null,
  }));
}

function perform(call: string, step: Step, h: EngineHarness): void {
  const value = (step.value as number | undefined) ?? 0;
  switch (call) {
    case 'load':
      h.engine.load(
        {
          uri: step.uri as string,
          headers: {},
          liveHint: (step.live as boolean | undefined) ?? null,
          renditions: renditions(step.renditions),
          refreshable: step.refreshable === true,
          expiresAt:
            step.expiresIn != null
              ? h.clock.wallMs + (step.expiresIn as number)
              : null,
        },
        (step.autoplay as boolean | undefined) ?? null,
        (step.start as number | undefined) ?? null
      );
      break;
    case 'background':
      return h.engine.appBackgrounded();
    case 'selectQuality':
      return h.engine.selectQuality((step.id as string | null) ?? null);
    case 'listenOnly':
      return h.engine.setListenOnly(step.value === true);
    case 'loop':
      return h.engine.setLoop(step.value === true);
    case 'sourceRefreshed':
      return h.engine.sourceRefreshed(h.engine.loadId, {
        uri: step.uri as string,
        headers: {},
        liveHint: (step.live as boolean | undefined) ?? null,
        renditions: renditions(step.renditions),
        expiresAt:
          step.expiresIn != null
            ? h.clock.wallMs + (step.expiresIn as number)
            : null,
      });
    case 'sourceRefreshFailed':
      return h.engine.sourceRefreshFailed(h.engine.loadId);
    case 'play':
      return h.engine.play();
    case 'pause':
      return h.engine.pause();
    case 'stop':
      return h.engine.stop();
    case 'reset':
      return h.engine.reset();
    case 'release':
      return h.engine.release();
    case 'seek':
      return h.engine.seek(value, step.exact === true);
    case 'volume':
      return h.engine.setVolume(value);
    case 'muted':
      return h.engine.setMuted(step.value === true);
    case 'rate':
      return h.engine.setRate(value);
    case 'duck':
      return h.engine.setDucked(step.value === true);
    case 'fadeTo':
      return h.engine.fadeTo(value, step.ms as number, () => {
        h.recorder.fades += 1;
      });
    case 'sleep':
      return h.engine.sleep(
        (step.after as number | null | undefined) ?? null,
        (step.fadeOut as number | undefined) ?? null
      );
    case 'setFades':
      return h.engine.setFades(step.in as number, step.out as number);
    case 'foreground':
      return h.engine.appForegrounded();
    case 'handoff':
      return h.engine.handoff(
        {
          kind: step.route as AudioRouteKind,
          name: (step.name as string | undefined) ?? null,
        },
        step.output as string,
        step.resume === true
      );
    default:
      throw new Error(`unknown call ${call}`);
  }
}

function native(step: Step, h: EngineHarness): void {
  let gen = h.engine.generation;
  if ('gen' in step)
    gen = step.gen === 'prev' ? h.engine.generation - 1 : (step.gen as number);
  const accepted = h.engine.accepts(gen);
  const move = (motion: Motion) => {
    if (accepted) h.driver.setMotion(motion);
  };
  if (step.native === 'playing' && gen === h.driver.swapGeneration) {
    h.driver.completeSwap();
    return h.engine.onPlaying(gen);
  }
  switch (step.native) {
    case 'ready':
      return h.engine.onReady(gen, {
        duration: (step.duration as number | undefined) ?? null,
        isLive: step.live === true,
        seekable: step.seekable === true,
      });
    case 'playing':
      move('flowing');
      return h.engine.onPlaying(gen);
    case 'buffering':
      move('frozen');
      return h.engine.onBuffering(gen);
    case 'ended':
      move('frozen');
      return h.engine.onEnded(gen);
    case 'failed':
      move('frozen');
      return h.engine.onFailed(
        gen,
        engineError(
          step.code as PlayerErrorCode,
          'test',
          step.recoverable === true,
          step.httpStatus != null
            ? { httpStatus: step.httpStatus as number }
            : {}
        )
      );
    case 'bandwidth':
      return h.engine.onBandwidth(gen, step.bps as number);
    case 'variants':
      return h.engine.onVariants(gen, variants(step.variants));
    case 'videoInfo':
      return h.engine.onVideoInfo(gen, {
        width: step.width as number,
        height: step.height as number,
        hdr: step.hdr === true,
        variantId: (step.variant as string | undefined) ?? null,
      });
    case 'firstFrame':
      return h.engine.onFirstFrame(gen);
    case 'renditionInfo':
      return h.engine.renditionInfo(
        step.index as number,
        (step.height as number | undefined) ?? null,
        (step.bitrate as number | undefined) ?? null
      );
    case 'pausedExternally':
      return h.engine.onPausedExternally(
        gen,
        ((step.reason as string | undefined) ?? 'system') as InterruptionReason
      );
    default:
      throw new Error(`unknown native step ${String(step.native)}`);
  }
}

function driver(step: Step, h: EngineHarness): void {
  switch (step.driver) {
    case 'flowing':
    case 'frozen':
    case 'trickle':
      return h.driver.setMotion(step.driver);
    case 'reentrant':
      h.driver.reentrant = true;
      return;
    case 'position':
      return h.driver.setPosition((step.value as number | undefined) ?? 0);
    default:
      throw new Error(`unknown driver step ${String(step.driver)}`);
  }
}

function check(
  expect: Record<string, unknown>,
  h: EngineHarness,
  at: string
): void {
  const s = h.engine.status;
  for (const [key, v] of Object.entries(expect)) {
    const label = `${at}: ${key}`;
    switch (key) {
      case 'state':
        expect_(label, s.state, v);
        break;
      case 'playWhenReady':
        expect_(label, s.playWhenReady, v);
        break;
      case 'isLive':
        expect_(label, s.isLive, v);
        break;
      case 'seekable':
        expect_(label, s.seekable, v);
        break;
      case 'duration':
        expect_(label, s.duration, v);
        break;
      case 'interruption':
        expect_(label, s.interruption?.reason ?? null, v);
        break;
      case 'interruptionResumable':
        expect_(label, s.interruption?.resumable ?? null, v);
        break;
      case 'error':
        expect_(label, s.error?.code ?? null, v);
        break;
      case 'route':
        expect_(label, s.route.kind, v);
        break;
      case 'routeName':
        expect_(label, s.route.name, v);
        break;
      case 'reconnectAttempt':
        expect_(label, s.reconnect?.attempt ?? null, v);
        break;
      case 'commands':
        expect_(label, h.driver.commands, v);
        break;
      case 'loads':
        expect_(label, h.recorder.loads, v);
        break;
      case 'errors':
        expect_(label, h.recorder.errors, v);
        break;
      case 'ended':
        expect_(label, h.recorder.ended, v);
        break;
      case 'wantsKeepalive':
        expect_(label, h.engine.wantsKeepalive, v);
        break;
      case 'needsAudioFocus':
        expect_(label, h.engine.needsAudioFocus, v);
        break;
      case 'volume':
        expect_(label, s.volume, v);
        break;
      case 'sleepAt':
        expect_(label, s.sleepAt == null ? null : s.sleepAt - WALL_BASE, v);
        break;
      case 'sleeps':
        expect_(label, h.recorder.sleeps, v);
        break;
      case 'fades':
        expect_(label, h.recorder.fades, v);
        break;
      case 'orderedCommands':
        orderedCommands_(label, v as string[], h.driver.commands);
        break;
      case 'video':
        videoExpect_(label, s.video, v as Record<string, unknown>);
        break;
      case 'wantsMediaSession':
        expect_(label, h.engine.wantsMediaSession, v);
        break;
      case 'wantsScreenAwake':
        expect_(label, h.engine.wantsScreenAwake, v);
        break;
      case 'refreshes':
        expect_(label, h.recorder.refreshes, v);
        break;
      case 'gen':
        expect_(label, h.engine.generation, v);
        break;
      case 'stats': {
        const stats = h.engine.stats as unknown as Record<string, unknown>;
        for (const [k, want] of Object.entries(v as Record<string, unknown>))
          expect_(`${label}.${k}`, stats[k], want);
        break;
      }
      default:
        throw new Error(`${at}: unknown expectation ${key}`);
    }
  }
  h.driver.commands = [];
  h.recorder.loads = [];
  h.recorder.errors = [];
  h.recorder.ended = 0;
  h.recorder.sleeps = 0;
  h.recorder.fades = 0;
  h.recorder.refreshes = [];
}

/** Compares the listed `status.video` fields (`qualities` as their ids). */
function videoExpect_(
  label: string,
  video: EngineVideoStatus | null,
  expected: Record<string, unknown> | null
): void {
  if (expected == null) return expect_(label, video, null);
  if (video == null) throw new Error(`${label}: no status.video`);
  const fields = video as unknown as Record<string, unknown>;
  for (const [k, want] of Object.entries(expected)) {
    const actual =
      k === 'qualities' ? video.qualities.map((q) => q.id) : fields[k];
    expect_(`${label}.${k}`, actual, want);
  }
}

function expect_(label: string, actual: unknown, expected: unknown): void {
  try {
    expect(actual).toEqual(expected);
  } catch (error) {
    throw new Error(`${label}\n${(error as Error).message}`);
  }
}

/**
 * Ordered commands: each entry must match (as a string prefix) a recorded
 * command at or after the previous match — a subsequence, not a run.
 */
function orderedCommands_(
  label: string,
  expected: string[],
  actual: string[]
): void {
  let cursor = 0;
  for (const pattern of expected) {
    while (cursor < actual.length && !actual[cursor]!.startsWith(pattern))
      cursor += 1;
    if (cursor === actual.length)
      throw new Error(
        `${label}: no command starting with "${pattern}" at or after index ${cursor} in [${actual.join(', ')}]`
      );
    cursor += 1;
  }
}

function apply(step: Step, h: EngineHarness, at: string): void {
  if ('call' in step) {
    const expected = (step.throws as string | undefined) ?? null;
    let thrown: string | null = null;
    try {
      perform(step.call as string, step, h);
    } catch (error) {
      thrown = (error as { code?: string }).code ?? String(error);
    }
    expect_(`${at}: throws`, thrown, expected);
  } else if ('focus' in step) {
    h.recorder.focus =
      step.focus === 'denied'
        ? 'denied'
        : step.focus === 'delayed'
          ? 'delayed'
          : 'granted';
  } else if ('native' in step) {
    native(step, h);
  } else if ('driver' in step) {
    driver(step, h);
  } else if ('interruption' in step) {
    if (step.interruption === 'began') {
      h.engine.interruptionBegan(
        step.reason as InterruptionReason,
        step.resumable === true
      );
    } else {
      h.engine.interruptionEnded(step.shouldResume === true);
    }
  } else if ('network' in step) {
    const next: NetworkState =
      step.network === 'online'
        ? 'online'
        : step.network === 'offline'
          ? 'offline'
          : 'unknown';
    h.engine.networkChanged(next, step.handoff === true);
  } else if ('route' in step) {
    h.engine.routeChanged({
      kind: step.route as AudioRouteKind,
      name: (step.name as string | undefined) ?? null,
    });
  } else if ('view' in step) {
    const v = step.view as Record<string, unknown>;
    h.engine.viewChanged({
      attached: v.attached !== false,
      visible: v.visible !== false,
      width: (v.width as number | undefined) ?? 0,
      height: (v.height as number | undefined) ?? 0,
    });
  } else if ('pip' in step) {
    h.engine.pictureInPictureChanged(step.pip === true);
  } else if ('networkCost' in step) {
    const c = step.networkCost as Record<string, unknown>;
    h.engine.networkCostChanged(c.metered === true, c.saveData === true);
  } else if ('platformReset' in step) {
    h.engine.platformReset();
  } else if ('advance' in step) {
    h.advance(step.advance as number);
  } else if ('expect' in step) {
    check(step.expect as Record<string, unknown>, h, at);
  } else {
    throw new Error(`${at}: unknown step ${JSON.stringify(step)}`);
  }
}

describe('engine conformance (web twin)', () => {
  it('loads every shared scenario', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(59);
  });

  it.each(scenarios)('%s', (name, scenario) => {
    const h = new EngineHarness(engineOptions(scenario.options));
    scenario.steps.forEach((step, i) => apply(step, h, `${name} [step ${i}]`));
    expect(h.recorder.violations).toEqual([]);
  });
});
