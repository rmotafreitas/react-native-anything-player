/**
 * The video half of the TurboModule on top of `FakeNative`: video commands,
 * `getVideoStats` and `fetchText` are recorded (or scripted), and a player
 * created with `video` starts with a video status.
 */
import { baseStatus, fake } from './FakeNative';

export const videoStatus = (overrides: object = {}) => ({
  width: null,
  height: null,
  hdr: false,
  firstFrame: false,
  audioOnly: null,
  pictureInPicture: false,
  fullscreen: false,
  qualities: [],
  quality: null,
  selectedQuality: null,
  tracks: [],
  audioTrack: null,
  textTrack: null,
  subtitleDelay: 0,
  ...overrides,
});

/** Answers `fetchText`: a file's text, or an error to throw. */
export type TextAnswer = { text: string; charset?: string } | Error;

export const videoNative = {
  /** Set false to play an app built without the video module. */
  available: true,
  stats: { startupMs: 120, rebuffers: 1 } as object,
  fetches: [] as Array<{ uri: string; headers: object; encoding: unknown }>,
  answers: [] as TextAnswer[],
  /** Answers every fetch for this uri; otherwise `answers` are used in order. */
  files: new Map<string, string>(),
  rejectVideoCommand: null as Error | null,
  reset() {
    this.available = true;
    this.fetches = [];
    this.answers = [];
    this.files.clear();
    this.rejectVideoCommand = null;
  },
};

const createPlayer = fake.createPlayer;

Object.assign(fake, {
  createPlayer: (options: object) => {
    const id = createPlayer(options);
    const wantsVideo = (options as { video?: unknown }).video;
    if (wantsVideo && videoNative.available) {
      fake.statuses.set(id, baseStatus({ video: videoStatus() }));
    }
    return id;
  },
  videoCommand: (id: string, command: object) => {
    fake.calls.push(['videoCommand', id, command]);
    if (videoNative.rejectVideoCommand) {
      const error = videoNative.rejectVideoCommand;
      videoNative.rejectVideoCommand = null;
      return Promise.reject(error);
    }
    const current = fake.statuses.get(id) ?? baseStatus();
    const next = { ...current, seq: current.seq + 1 };
    fake.statuses.set(id, next);
    return Promise.resolve({ ...next });
  },
  getVideoStats: (id: string) => {
    fake.calls.push(['getVideoStats', id]);
    return videoNative.stats;
  },
  fetchText: (uri: string, headers: object, encoding: unknown) => {
    videoNative.fetches.push({ uri, headers, encoding });
    const file = videoNative.files.get(uri);
    if (file != null) return Promise.resolve({ text: file, charset: 'utf-8' });
    const answer = videoNative.answers.shift();
    if (answer == null) return Promise.reject(new Error('no answer scripted'));
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve({ charset: 'utf-8', ...answer });
  },
});

/** Video commands sent to native, in order. */
export const videoCommands = (): Array<Record<string, unknown>> =>
  fake.calls
    .filter((c) => c[0] === 'videoCommand')
    .map((c) => c[2] as Record<string, unknown>);
