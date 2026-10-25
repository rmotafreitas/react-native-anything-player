// The web video stage: moving the <video> between containers, what the engine
// is told about the view, fullscreen, Picture in Picture, the screen wake
// lock and the subtitle overlay.

import { PlayerError } from '../../errors';
import { vttCue } from '../../core/subtitles/vtt';
import type { SubtitleCue } from '../../core/subtitles/types';
import type { AudioElementLike } from '../platform/dom';
import type { EngineStatus } from '../engine/types';
import { WebVideo, type VideoHost } from '../platform/WebVideo';
import {
  FakeIntersectionObserver,
  FakeNode,
  FakeResizeObserver,
  FakeVideo,
  installPage,
  observers,
  uninstallPage,
  type FakePage,
} from './FakeVideoDom';

let page: FakePage;
let video: FakeVideo;
let engine: {
  wantsScreenAwake: boolean;
  viewChanged: jest.Mock;
  fullscreenChanged: jest.Mock;
  pictureInPictureChanged: jest.Mock;
};
let emitted: Array<{ type: string; payload: Record<string, unknown> }>;
let stage: WebVideo;

const asElement = (v: FakeVideo) => v as unknown as AudioElementLike;
const asStage = (s: WebVideo) => s.stage as unknown as FakeNode;

function setup(options: Parameters<typeof installPage>[0] = {}) {
  page = installPage(options);
  video = new FakeVideo();
  engine = {
    wantsScreenAwake: false,
    viewChanged: jest.fn(),
    fullscreenChanged: jest.fn(),
    pictureInPictureChanged: jest.fn(),
  };
  emitted = [];
  const host = {
    engine,
    element: () => asElement(video),
    emit: (type: string, payload: Record<string, unknown>) =>
      emitted.push({ type, payload }),
  } as unknown as VideoHost;
  stage = new WebVideo(host);
}

const container = () => new FakeNode();
const lastView = () => engine.viewChanged.mock.lastCall![0];
const overlay = () => asStage(stage).children[0]!;

function status(textTrack: string | null, subtitleDelay = 0): EngineStatus {
  return { video: { textTrack, subtitleDelay } } as unknown as EngineStatus;
}

function cue(
  start: number,
  end: number,
  text: string,
  settings = ''
): SubtitleCue {
  return vttCue(start * 1000, end * 1000, settings, text)!;
}

/** The overlay's text, one entry per cue box. */
const shown = () => overlay().lines;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  setup();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  uninstallPage();
});

describe('placing the stage', () => {
  test('puts the stage in the container and tells the engine it is attached', () => {
    const box = container();

    stage.attach(box as never);

    expect(asStage(stage).parentNode).toBe(box);
    expect(lastView()).toMatchObject({ attached: true, visible: true });
  });

  test('moves the stage to another container without a gap', () => {
    const first = container();
    const second = container();
    stage.attach(first as never);

    stage.attach(second as never);

    expect(first.children).toEqual([]);
    expect(second.children).toEqual([asStage(stage)]);
    expect(observers(FakeIntersectionObserver)[0]!.disconnected).toBe(true);
  });

  test('attaching to the same container only reports again', () => {
    const box = container();
    stage.attach(box as never);
    engine.viewChanged.mockClear();

    stage.attach(box as never);

    expect(box.children).toEqual([asStage(stage)]);
    expect(engine.viewChanged).toHaveBeenCalledTimes(1);
    expect(observers(FakeIntersectionObserver)).toHaveLength(1);
  });

  test('taking the stage out reports it detached and hidden', () => {
    const box = container();
    stage.attach(box as never);

    stage.attach(null);

    expect(box.children).toEqual([]);
    expect(lastView()).toMatchObject({ attached: false, visible: false });
  });

  test('without observers the view counts as visible once attached', () => {
    release();
    setup({ observers: false });

    stage.attach(container() as never);

    expect(lastView()).toMatchObject({ attached: true, visible: true });
    expect(observers(FakeIntersectionObserver)).toEqual([]);
  });

  function release() {
    stage.release();
    uninstallPage();
  }
});

describe('the view the engine hears about', () => {
  test('visibility follows the intersection observer', () => {
    stage.attach(container() as never);
    const io = observers(FakeIntersectionObserver)[0]!;
    expect(io.observed).toEqual([asStage(stage)]);

    io.fire({ isIntersecting: false, intersectionRatio: 0 });
    expect(lastView().visible).toBe(false);

    io.fire({ isIntersecting: true, intersectionRatio: 0.4 });
    expect(lastView().visible).toBe(true);

    io.fire({ isIntersecting: true, intersectionRatio: 0 });
    expect(lastView().visible).toBe(false);
  });

  test('an observer callback without entries changes nothing', () => {
    stage.attach(container() as never);
    engine.viewChanged.mockClear();

    observers(FakeIntersectionObserver)[0]!.callback([]);
    observers(FakeResizeObserver)[0]!.callback([]);

    expect(engine.viewChanged).not.toHaveBeenCalled();
  });

  test('the size is reported in device pixels and sets the subtitle size', () => {
    stage.attach(container() as never);
    const ro = observers(FakeResizeObserver)[0]!;

    ro.fire({ contentRect: { width: 640, height: 360 } });
    expect(lastView()).toMatchObject({ width: 1280, height: 720 });
    expect(overlay().style.fontSize).toBe('18px');

    ro.fire({ contentRect: { width: 100, height: 100 } });
    expect(overlay().style.fontSize).toBe('14px');
  });

  test('the observers stop when the stage leaves the page', () => {
    stage.attach(container() as never);

    stage.attach(null);

    expect(observers(FakeIntersectionObserver)[0]!.disconnected).toBe(true);
    expect(observers(FakeResizeObserver)[0]!.disconnected).toBe(true);
  });
});

describe('showing the elements', () => {
  test('puts the current element on top and hides the other one', () => {
    const behind = new FakeVideo();

    stage.show(asElement(video), asElement(behind));

    expect(video.parentNode).toBe(asStage(stage));
    expect(behind.parentNode).toBe(asStage(stage));
    expect(video.style).toMatchObject({ visibility: 'visible', zIndex: '1' });
    expect(behind.style).toMatchObject({ visibility: 'hidden', zIndex: '0' });
  });

  test('an element that is already on the stage stays where it is', () => {
    stage.show(asElement(video), null);
    const children = [...asStage(stage).children];

    stage.show(asElement(video), null);

    expect(asStage(stage).children).toEqual(children);
  });

  test('the object-fit mode applies to every element, and to later ones', () => {
    const behind = new FakeVideo();
    stage.show(asElement(video), asElement(behind));

    stage.attach(container() as never, 'cover');
    expect([video.style.objectFit, behind.style.objectFit]).toEqual([
      'cover',
      'cover',
    ]);

    stage.attach(null, 'fill');
    expect(video.style.objectFit).toBe('fill');

    stage.attach(null);
    expect(video.style.objectFit).toBe('fill');
  });

  test('the native controls show on the current element only', () => {
    const behind = new FakeVideo();
    stage.show(asElement(video), asElement(behind));

    stage.attach(container() as never, 'contain', true);
    expect([video.controls, behind.controls]).toEqual([true, false]);

    stage.show(asElement(behind), asElement(video));
    expect([video.controls, behind.controls]).toEqual([false, true]);

    stage.attach(null, 'contain', false);
    expect([video.controls, behind.controls]).toEqual([false, false]);
  });

  test('sets and clears the poster on the current element', () => {
    stage.setPoster('https://cdn.example/poster.jpg');
    expect(video.poster).toBe('https://cdn.example/poster.jpg');

    stage.setPoster(null);
    expect(video.poster).toBe('');
  });
});

describe('fullscreen', () => {
  test('asks the stage and holds the orientation lock', async () => {
    const request = jest.fn(async () => {});
    asStage(stage).requestFullscreen = request;

    await stage.setFullscreen(true, 'landscape');

    expect(request).toHaveBeenCalledTimes(1);
    expect(page.orientation.lock).toHaveBeenCalledWith('landscape');
  });

  test('no orientation lock when none is asked for', async () => {
    asStage(stage).requestFullscreen = async () => {};

    await stage.setFullscreen(true, false);

    expect(page.orientation.lock).not.toHaveBeenCalled();
  });

  test('a refused orientation lock does not fail the fullscreen', async () => {
    asStage(stage).requestFullscreen = async () => {};
    page.orientation.lock.mockRejectedValue(new Error('NotSupportedError'));

    await expect(
      stage.setFullscreen(true, 'landscape')
    ).resolves.toBeUndefined();
  });

  test('a refused request is the caller’s error', async () => {
    asStage(stage).requestFullscreen = async () => {
      throw new Error('NotAllowedError');
    };

    await expect(stage.setFullscreen(true, false)).rejects.toThrow(
      'NotAllowedError'
    );
  });

  test('falls back to webkit’s request on the stage', async () => {
    const request = jest.fn();
    asStage(stage).webkitRequestFullscreen = request;

    await stage.setFullscreen(true, false);

    expect(request).toHaveBeenCalledTimes(1);
  });

  test('iPhone Safari goes fullscreen with the video itself', async () => {
    video.webkitEnterFullscreen = jest.fn();

    await stage.setFullscreen(true, false);

    expect(video.webkitEnterFullscreen).toHaveBeenCalledTimes(1);
  });

  test('says so when the browser has no fullscreen', async () => {
    const error = await stage.setFullscreen(true, false).catch((e) => e);

    expect(error).toBeInstanceOf(PlayerError);
    expect(error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Fullscreen is not available in this browser.',
    });
  });

  test('leaving exits the document’s fullscreen and unlocks the orientation', async () => {
    page.document.fullscreenElement = asStage(stage);
    page.document.exitFullscreen = jest.fn(async () => {});

    await stage.setFullscreen(false, false);

    expect(page.document.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(page.orientation.unlock).toHaveBeenCalledTimes(1);
  });

  test('leaving webkit’s fullscreen', async () => {
    page.document.webkitFullscreenElement = asStage(stage);
    page.document.webkitExitFullscreen = jest.fn();

    await stage.setFullscreen(false, false);

    expect(page.document.webkitExitFullscreen).toHaveBeenCalledTimes(1);
  });

  test('leaving the native player of the video itself', async () => {
    video.webkitExitFullscreen = jest.fn();

    await stage.setFullscreen(false, false);

    expect(video.webkitExitFullscreen).toHaveBeenCalledTimes(1);
  });

  test('leaving without any fullscreen API still unlocks the orientation', async () => {
    await stage.setFullscreen(false, false);

    expect(page.orientation.unlock).toHaveBeenCalledTimes(1);
  });

  test('fullscreenchange reports whether the stage or the video is fullscreen', () => {
    stage.show(asElement(video), null);

    page.document.fullscreenElement = asStage(stage);
    page.document.dispatch('fullscreenchange');
    expect(engine.fullscreenChanged).toHaveBeenLastCalledWith(true);

    page.document.fullscreenElement = video;
    page.document.dispatch('fullscreenchange');
    expect(engine.fullscreenChanged).toHaveBeenLastCalledWith(true);

    page.document.fullscreenElement = undefined;
    page.document.webkitFullscreenElement = video;
    page.document.dispatch('webkitfullscreenchange');
    expect(engine.fullscreenChanged).toHaveBeenLastCalledWith(true);

    page.document.webkitFullscreenElement = undefined;
    page.document.dispatch('fullscreenchange');
    expect(engine.fullscreenChanged).toHaveBeenLastCalledWith(false);
  });

  test('another element in fullscreen is not ours', () => {
    page.document.fullscreenElement = new FakeNode();

    page.document.dispatch('fullscreenchange');

    expect(engine.fullscreenChanged).toHaveBeenLastCalledWith(false);
  });

  test('Safari’s presentation mode and begin/end events report fullscreen', () => {
    stage.show(asElement(video), null);

    video.webkitPresentationMode = 'fullscreen';
    video.dispatch('webkitpresentationmodechanged');
    expect(engine.fullscreenChanged).toHaveBeenLastCalledWith(true);

    video.webkitPresentationMode = 'inline';
    video.dispatch('webkitpresentationmodechanged');
    expect(engine.fullscreenChanged).toHaveBeenLastCalledWith(false);

    video.dispatch('webkitbeginfullscreen');
    expect(engine.fullscreenChanged).toHaveBeenLastCalledWith(true);

    video.dispatch('webkitendfullscreen');
    expect(engine.fullscreenChanged).toHaveBeenLastCalledWith(false);
  });
});

describe('Picture in Picture', () => {
  test('enters with the browser’s API', async () => {
    video.requestPictureInPicture = jest.fn(async () => ({}));

    await stage.setPictureInPicture(true);

    expect(video.requestPictureInPicture).toHaveBeenCalledTimes(1);
  });

  test('enters through Safari’s presentation mode', async () => {
    video.webkitSupportsPresentationMode = (mode) =>
      mode === 'picture-in-picture';
    video.webkitSetPresentationMode = jest.fn();

    await stage.setPictureInPicture(true);

    expect(video.webkitSetPresentationMode).toHaveBeenCalledWith(
      'picture-in-picture'
    );
  });

  test('a refusal reaches the caller', async () => {
    video.requestPictureInPicture = async () => {
      throw new Error('NotAllowedError');
    };

    await expect(stage.setPictureInPicture(true)).rejects.toThrow(
      'NotAllowedError'
    );
  });

  test.each([
    ['no support at all', undefined],
    ['a Safari without the mode', () => false],
  ])('says so with %s', async (_name, supports) => {
    video.webkitSupportsPresentationMode = supports;

    const error = await stage.setPictureInPicture(true).catch((e) => e);

    expect(error).toBeInstanceOf(PlayerError);
    expect(error).toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: 'Picture in Picture is not available in this browser.',
    });
  });

  test('leaves the document’s Picture in Picture', async () => {
    page.document.pictureInPictureElement = video;
    page.document.exitPictureInPicture = jest.fn(async () => {});

    await stage.setPictureInPicture(false);

    expect(page.document.exitPictureInPicture).toHaveBeenCalledTimes(1);
  });

  test('leaves Safari’s Picture in Picture back to inline', async () => {
    video.webkitSetPresentationMode = jest.fn();

    await stage.setPictureInPicture(false);

    expect(video.webkitSetPresentationMode).toHaveBeenCalledWith('inline');
  });

  test('leaving without any Picture in Picture API does nothing', async () => {
    await expect(stage.setPictureInPicture(false)).resolves.toBeUndefined();
  });

  test('enter and leave events report whether the video is the one in the window', () => {
    stage.show(asElement(video), null);

    page.document.pictureInPictureElement = video;
    video.dispatch('enterpictureinpicture');
    expect(engine.pictureInPictureChanged).toHaveBeenLastCalledWith(true);

    page.document.pictureInPictureElement = undefined;
    video.dispatch('leavepictureinpicture');
    expect(engine.pictureInPictureChanged).toHaveBeenLastCalledWith(false);

    page.document.pictureInPictureElement = new FakeNode();
    video.dispatch('enterpictureinpicture');
    expect(engine.pictureInPictureChanged).toHaveBeenLastCalledWith(false);
  });

  test('Safari’s presentation mode reports Picture in Picture', () => {
    stage.show(asElement(video), null);

    video.webkitPresentationMode = 'picture-in-picture';
    video.dispatch('webkitpresentationmodechanged');

    expect(engine.pictureInPictureChanged).toHaveBeenLastCalledWith(true);
  });
});

describe('the screen wake lock', () => {
  const flush = () => jest.advanceTimersByTimeAsync(0);

  test('is held while the engine wants the screen awake, once', async () => {
    engine.wantsScreenAwake = true;

    stage.statusChanged(status(null));
    stage.statusChanged(status(null));
    await flush();

    expect(page.locks).toHaveLength(1);
    expect(page.locks[0]!.released).toBe(false);
  });

  test('is released when the engine no longer wants it', async () => {
    engine.wantsScreenAwake = true;
    stage.statusChanged(status(null));
    await flush();

    engine.wantsScreenAwake = false;
    stage.statusChanged(status(null));
    await flush();

    expect(page.locks[0]!.released).toBe(true);
  });

  test('a new one is taken when it is wanted again', async () => {
    engine.wantsScreenAwake = true;
    stage.statusChanged(status(null));
    await flush();
    engine.wantsScreenAwake = false;
    stage.statusChanged(status(null));
    engine.wantsScreenAwake = true;
    stage.statusChanged(status(null));
    await flush();

    expect(page.locks).toHaveLength(2);
    expect(page.locks.map((l) => l.released)).toEqual([true, false]);
  });

  test('a refused request is not an error, and is not retried every status', async () => {
    page.denyWakeLock();
    engine.wantsScreenAwake = true;

    stage.statusChanged(status(null));
    stage.statusChanged(status(null));
    await flush();

    expect(page.locks).toEqual([]);
  });

  test('a browser without the Wake Lock API is fine', async () => {
    stage.release();
    uninstallPage();
    setup({ wakeLock: false });
    engine.wantsScreenAwake = true;

    stage.statusChanged(status(null));
    engine.wantsScreenAwake = false;
    stage.statusChanged(status(null));
    await flush();

    expect(page.locks).toEqual([]);
  });

  test('release() lets go of it', async () => {
    engine.wantsScreenAwake = true;
    stage.statusChanged(status(null));
    await flush();

    stage.release();
    await flush();

    expect(page.locks[0]!.released).toBe(true);
  });
});

describe('release', () => {
  test('takes the stage out of the page and stops the observers', () => {
    const box = container();
    stage.attach(box as never);

    stage.release();

    expect(box.children).toEqual([]);
    expect(observers(FakeIntersectionObserver)[0]!.disconnected).toBe(true);
    expect(observers(FakeResizeObserver)[0]!.disconnected).toBe(true);
  });

  test('stops the cue timer', () => {
    video.paused = false;
    stage.show(asElement(video), null);
    stage.beginSession('s');
    stage.setCues('s', 'file:1', [cue(0, 1, 'One'), cue(5, 6, 'Two')]);
    stage.statusChanged(status('file:1'));
    expect(jest.getTimerCount()).toBe(1);

    stage.release();

    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('subtitles from an app file', () => {
  beforeEach(() => {
    video.paused = false;
    stage.show(asElement(video), null);
    stage.beginSession('s');
    stage.setCues('s', 'file:1', [
      cue(1, 3, 'Hello'),
      cue(2, 4, 'World', 'line:0'),
      cue(8, 9, 'Later'),
    ]);
  });

  test('draws the cues on screen at the playback position', () => {
    stage.statusChanged(status('file:1'));
    expect(shown()).toEqual([]);

    video.currentTime = 1.5;
    video.dispatch('timeupdate');
    expect(shown()).toEqual(['Hello']);

    video.currentTime = 2.5;
    video.dispatch('seeked');
    expect(shown()).toEqual(['Hello', 'World']);

    video.currentTime = 5;
    video.dispatch('playing');
    expect(shown()).toEqual([]);
  });

  test('emits the cues that are on screen', () => {
    video.currentTime = 1.5;
    stage.statusChanged(status('file:1'));

    expect(emitted.at(-1)).toMatchObject({
      type: 'cues',
      payload: { cues: [expect.objectContaining({ text: 'Hello' })] },
    });
  });

  test('does not redraw or re-emit the same cues', () => {
    video.currentTime = 1.5;
    stage.statusChanged(status('file:1'));
    const count = emitted.length;

    video.dispatch('timeupdate');
    stage.statusChanged(status('file:1'));

    expect(emitted).toHaveLength(count);
  });

  test('changes the cues by itself when the next one starts', () => {
    video.currentTime = 0;
    stage.statusChanged(status('file:1'));
    expect(shown()).toEqual([]);

    video.currentTime = 1;
    jest.advanceTimersByTime(1000);

    expect(shown()).toEqual(['Hello']);
  });

  test('the timer follows the playback rate', () => {
    video.playbackRate = 2;
    video.currentTime = 0;
    stage.statusChanged(status('file:1'));

    jest.advanceTimersByTime(499);
    expect(shown()).toEqual([]);

    video.currentTime = 1;
    jest.advanceTimersByTime(1);
    expect(shown()).toEqual(['Hello']);
  });

  test('a paused video plans no change', () => {
    video.paused = true;

    stage.statusChanged(status('file:1'));

    expect(jest.getTimerCount()).toBe(0);
  });

  test('the subtitle delay shifts the cues', () => {
    video.currentTime = 1.5;
    stage.statusChanged(status('file:1', 1));
    expect(shown()).toEqual([]);

    video.currentTime = 3.5;
    video.dispatch('timeupdate');
    expect(shown()).toEqual(['Hello', 'World']);
  });

  test('turning the subtitles off clears the overlay', () => {
    video.currentTime = 1.5;
    stage.statusChanged(status('file:1'));

    stage.statusChanged(status(null));

    expect(shown()).toEqual([]);
    expect(emitted.at(-1)!.payload).toEqual({ cues: [] });
  });

  test('cues of a finished session are ignored', () => {
    stage.setCues('old', 'file:2', [cue(0, 10, 'Stale')]);
    stage.statusChanged(status('file:2'));

    expect(stage.cuesFor('file:2')).toBeNull();
    expect(shown()).toEqual([]);
  });

  test('cuesFor gives the loaded cues, and a new session forgets them', () => {
    expect(stage.cuesFor('file:1')).toHaveLength(3);
    expect(stage.cuesFor('file:9')).toBeNull();

    stage.beginSession('t');

    expect(stage.cuesFor('file:1')).toBeNull();
  });

  test('a new session clears what was drawn', () => {
    video.currentTime = 1.5;
    stage.statusChanged(status('file:1'));

    stage.beginSession(null);

    expect(shown()).toEqual([]);
  });
});

describe('how a cue looks', () => {
  function draw(c: SubtitleCue) {
    video.currentTime = c.start + 0.1;
    stage.beginSession('s');
    stage.setCues('s', 'file:1', [c]);
    stage.statusChanged(status('file:1'));
    return overlay().children[0]!;
  }

  test('a cue without a position sits at the bottom edge', () => {
    const box = draw(cue(0, 5, 'Plain'));

    expect(box.style).toMatchObject({
      position: 'absolute',
      left: '5%',
      right: '5%',
      bottom: '7%',
      textAlign: 'center',
    });
  });

  test('a cue at the top, or in the middle, sits there', () => {
    expect(draw(cue(0, 5, 'Up', 'line:0')).style.top).toBe('5%');

    const middle = { ...cue(0, 5, 'Mid'), vertical: 'middle' as const };
    expect(draw(middle).style).toMatchObject({
      top: '50%',
      transform: 'translateY(-50%)',
    });
  });

  test('a cue with its own point is anchored there', () => {
    const placed = {
      ...cue(0, 5, 'Here'),
      x: 0.25,
      y: 0.5,
      align: 'right' as const,
      vertical: 'middle' as const,
    };

    expect(draw(placed).style).toMatchObject({
      left: '25%',
      top: '50%',
      transform: 'translate(-100%, -50%)',
      textAlign: 'right',
      maxWidth: '90%',
    });
  });

  test('a cue with one coordinate gets the default for the other', () => {
    const placed = { ...cue(0, 5, 'Half'), x: 0.1, y: null };

    expect(draw(placed).style).toMatchObject({ left: '10%', top: '90%' });
  });

  test('the runs keep their style', () => {
    const styled: SubtitleCue = {
      ...cue(0, 5, 'ab'),
      spans: [
        {
          text: 'a',
          bold: true,
          italic: true,
          underline: true,
          color: '#ff0000',
        },
        { text: 'b' },
      ],
    };

    const [first, second] = draw(styled).children;

    expect(first!.textContent).toBe('a');
    expect(first!.style).toMatchObject({
      color: '#ff0000',
      fontWeight: 'bold',
      fontStyle: 'italic',
      textDecoration: 'underline',
    });
    expect(second!.style).toMatchObject({
      color: '#ffffff',
      fontWeight: 'normal',
      fontStyle: 'normal',
      textDecoration: 'none',
    });
  });

  test('draws without replaceChildren too', () => {
    stage.show(asElement(video), null);
    overlay().replaceChildren = undefined;

    draw(cue(0, 5, 'Old'));
    expect(shown()).toEqual(['Old']);

    video.currentTime = 9;
    video.dispatch('timeupdate');
    expect(shown()).toEqual([]);
  });
});

describe('subtitles from the source itself', () => {
  beforeEach(() => {
    stage.show(asElement(video), null);
    stage.beginSession('s');
  });

  test('draws and emits the cues the browser reports for the chosen track', () => {
    stage.statusChanged(status('track:t:0'));
    const cues = [cue(0, 2, 'From the stream')];

    stage.sourceCues(cues);

    expect(shown()).toEqual(['From the stream']);
    expect(emitted.at(-1)).toEqual({ type: 'cues', payload: { cues } });
  });

  test('the same cues are not drawn twice', () => {
    stage.statusChanged(status('track:t:0'));
    const cues = [cue(0, 2, 'Once')];
    stage.sourceCues(cues);
    const count = emitted.length;

    stage.statusChanged(status('track:t:0'));
    stage.sourceCues(cues);

    expect(emitted).toHaveLength(count);
  });

  test('plans no timer: the browser says when they change', () => {
    video.paused = false;
    stage.statusChanged(status('track:t:0'));
    stage.sourceCues([cue(0, 2, 'x')]);

    expect(jest.getTimerCount()).toBe(0);
  });

  test('a file whose id looks like a source track is the file’s', () => {
    stage.setCues('s', 'track:t:0', [cue(0, 5, 'File')]);
    stage.sourceCues([cue(0, 5, 'Source')]);
    video.currentTime = 1;

    stage.statusChanged(status('track:t:0'));

    expect(shown()).toEqual(['File']);
  });

  test('switching back to a file replaces the source’s cues', () => {
    stage.setCues('s', 'file:1', [cue(0, 5, 'File')]);
    stage.statusChanged(status('track:t:0'));
    stage.sourceCues([cue(0, 2, 'Source')]);
    video.currentTime = 1;

    stage.statusChanged(status('file:1'));

    expect(shown()).toEqual(['File']);
  });
});
