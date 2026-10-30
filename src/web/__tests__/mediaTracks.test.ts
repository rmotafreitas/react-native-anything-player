// A video's own audio and text tracks on the web: the element's lists and
// hls.js's renditions as RNAP's tracks, the engine's picks applied, and the
// active cues of the chosen text track handed to the overlay.

import type { HlsMediaTrack } from '../../core/hls';
import type { MediaTrack } from '../../core/subtitles/tracks';
import type { SubtitleCue } from '../../core/subtitles/types';
import type { VideoElementLike } from '../platform/dom';
import {
  MediaTracks,
  cueOfVtt,
  type HlsTracks,
  type TrackSink,
} from '../platform/MediaTracks';
import { FakeAudioTrack, FakeTextTrack, FakeTrackList } from './FakeVideoDom';

interface Tracks {
  audio: FakeTrackList<FakeAudioTrack>;
  text: FakeTrackList<FakeTextTrack>;
}

function makeElement(tracks: Partial<Tracks> = {}) {
  const element = {
    audioTracks: tracks.audio?.asList(),
    textTracks: tracks.text?.asList(),
  };
  return element as unknown as VideoElementLike;
}

function open(element: VideoElementLike, sink: TrackSink): MediaTracks {
  return new MediaTracks(element, sink);
}

function makeSink() {
  const tracks: MediaTrack[][] = [];
  const cues: SubtitleCue[][] = [];
  const sink: TrackSink = {
    onTracks: (t) => tracks.push(t),
    onCues: (c) => cues.push(c),
  };
  return { sink, tracks, cues };
}

function makeHls(overrides: Partial<HlsTracks> = {}) {
  const calls: string[] = [];
  const hls: HlsTracks = {
    audioTracks: [
      { name: 'English', lang: 'en', default: true },
      {
        name: 'English AD',
        lang: 'en',
        characteristics: 'public.accessibility.describes-video',
      },
    ] as HlsMediaTrack[],
    subtitleTracks: [
      { name: 'Português', lang: 'pt' },
      {
        name: 'English SDH',
        lang: 'en',
        forced: true,
        characteristics: 'public.accessibility.transcribes-spoken-dialog',
      },
    ] as HlsMediaTrack[],
    selectAudio: (i) => calls.push(`audio:${i}`),
    selectSubtitles: (i) => calls.push(`text:${i}`),
    ...overrides,
  };
  return { hls, calls };
}

describe('listing the element’s tracks', () => {
  test('reports audio and text tracks with language, label and kind', () => {
    const audio = new FakeTrackList<FakeAudioTrack>();
    audio.items = [
      new FakeAudioTrack('a', 'main', 'English', 'en'),
      new FakeAudioTrack('b', 'description', '', ''),
    ];
    const text = new FakeTrackList<FakeTextTrack>();
    text.items = [
      new FakeTextTrack('subtitles', 'Português', 'pt'),
      new FakeTextTrack('captions', 'English CC', 'en'),
      new FakeTextTrack('metadata', 'ids', ''),
    ];
    const { sink, tracks } = makeSink();
    open(makeElement({ audio, text }), sink);

    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toEqual([
      {
        id: 'track:a:0',
        kind: 'audio',
        language: 'en',
        label: 'English',
        forced: false,
        default: true,
        sdh: false,
        describesVideo: false,
      },
      {
        id: 'track:a:1',
        kind: 'audio',
        language: null,
        label: null,
        forced: false,
        default: false,
        sdh: false,
        describesVideo: true,
      },
      {
        id: 'track:t:0',
        kind: 'subtitles',
        language: 'pt',
        label: 'Português',
        forced: false,
        default: false,
        sdh: false,
        describesVideo: false,
      },
      {
        id: 'track:t:1',
        kind: 'captions',
        language: 'en',
        label: 'English CC',
        forced: false,
        default: false,
        sdh: true,
        describesVideo: false,
      },
    ]);
  });

  test('a browser without track lists reports no tracks', () => {
    const { sink, tracks } = makeSink();
    const mediaTracks = new MediaTracks(makeElement(), sink);
    mediaTracks.select('track:a:0', 'track:t:0');

    expect(tracks).toEqual([[]]);
  });

  test('addtrack, removetrack and change re-read the lists', () => {
    const text = new FakeTrackList<FakeTextTrack>();
    const { sink, tracks } = makeSink();
    open(makeElement({ text }), sink);

    const track = new FakeTextTrack('subtitles', 'English', 'en');
    text.add(track);
    expect(tracks.at(-1)?.map((t) => t.label)).toEqual(['English']);

    text.remove(track);
    expect(tracks.at(-1)).toEqual([]);
    expect(tracks).toHaveLength(3);
  });

  test('a change that leaves the tracks as they were reports nothing', () => {
    const audio = new FakeTrackList<FakeAudioTrack>();
    audio.items = [new FakeAudioTrack('a', 'main', 'English', 'en')];
    const { sink, tracks } = makeSink();
    open(makeElement({ audio }), sink);

    audio.dispatch('change');

    expect(tracks).toHaveLength(1);
  });
});

describe('applying the picks', () => {
  test('enables the chosen audio track and disables the others', () => {
    const audio = new FakeTrackList<FakeAudioTrack>();
    const first = new FakeAudioTrack('a', 'main', '', 'en', true);
    const second = new FakeAudioTrack('b', '', '', 'pt', false);
    audio.items = [first, second];
    const { sink } = makeSink();
    const mediaTracks = new MediaTracks(makeElement({ audio }), sink);

    mediaTracks.select('track:a:1', null);

    expect([first.enabled, second.enabled]).toEqual([false, true]);
  });

  test('ignores an audio pick that is out of range or not an audio id', () => {
    const audio = new FakeTrackList<FakeAudioTrack>();
    const only = new FakeAudioTrack('a', 'main', '', 'en', true);
    audio.items = [only];
    const { sink } = makeSink();
    const mediaTracks = new MediaTracks(makeElement({ audio }), sink);

    mediaTracks.select('track:a:5', null);
    expect(only.enabled).toBe(true);

    mediaTracks.select('track:t:0', null);
    expect(only.enabled).toBe(true);
  });

  test('runs the chosen text track hidden and disables the rest', () => {
    const text = new FakeTrackList<FakeTextTrack>();
    const pt = new FakeTextTrack('subtitles', 'Português', 'pt');
    const en = new FakeTextTrack('subtitles', 'English', 'en');
    pt.mode = 'showing';
    text.items = [pt, en];
    const { sink } = makeSink();
    const mediaTracks = new MediaTracks(makeElement({ text }), sink);

    mediaTracks.select(null, 'track:t:1');
    expect([pt.mode, en.mode]).toEqual(['disabled', 'hidden']);

    mediaTracks.select(null, null);
    expect([pt.mode, en.mode]).toEqual(['disabled', 'disabled']);
  });

  test('keeps the pick for a track that shows up later', () => {
    const text = new FakeTrackList<FakeTextTrack>();
    const { sink } = makeSink();
    const mediaTracks = new MediaTracks(makeElement({ text }), sink);
    mediaTracks.select(null, 'track:t:0');

    const late = new FakeTextTrack('subtitles', 'English', 'en');
    late.mode = 'showing';
    text.add(late);

    expect(late.mode).toBe('hidden');
  });
});

describe('the cues of the chosen text track', () => {
  function setup() {
    const text = new FakeTrackList<FakeTextTrack>();
    const track = new FakeTextTrack('subtitles', 'English', 'en');
    text.items = [track];
    const out = makeSink();
    const mediaTracks = new MediaTracks(makeElement({ text }), out.sink);
    /** A browser fires `change` on the list when a track's mode is set. */
    const select = (audio: string | null, id: string | null) => {
      mediaTracks.select(audio, id);
      text.dispatch('change');
    };
    return { track, mediaTracks, select, ...out };
  }

  test('hands the active cues to the overlay as the browser changes them', () => {
    const { track, select, cues } = setup();
    select(null, 'track:t:0');

    track.showCues({ startTime: 1, endTime: 3, text: 'Hello' });
    expect(cues.at(-1)?.map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 3, 'Hello'],
    ]);

    track.showCues();
    expect(cues.at(-1)).toEqual([]);
  });

  test('does not repeat cues that did not change', () => {
    const { track, select, cues } = setup();
    select(null, 'track:t:0');
    track.showCues({ startTime: 1, endTime: 3, text: 'Hello' });
    const count = cues.length;

    track.showCues({ startTime: 1, endTime: 3, text: 'Hello' });

    expect(cues).toHaveLength(count);
  });

  test('skips a cue without text', () => {
    const { track, select, cues } = setup();
    select(null, 'track:t:0');

    track.showCues(
      { startTime: 1, endTime: 3 },
      { startTime: 2, endTime: 4, text: 'x' }
    );

    expect(cues.at(-1)?.map((c) => c.text)).toEqual(['x']);
  });

  test('stops following a track that was switched off', () => {
    const { track, select, cues } = setup();
    select(null, 'track:t:0');
    track.showCues({ startTime: 1, endTime: 3, text: 'Hello' });
    select(null, null);
    const count = cues.length;

    track.showCues({ startTime: 4, endTime: 5, text: 'Later' });

    expect(cues.at(-1)).toEqual([]);
    expect(cues).toHaveLength(count);
    expect(track.listenerCount('cuechange')).toBe(0);
  });
});

describe('cueOfVtt', () => {
  test('carries a cue’s placement into the cue model', () => {
    const cue = cueOfVtt({
      startTime: 1,
      endTime: 2.5,
      text: 'Top',
      align: 'left',
      line: 10,
      snapToLines: false,
      lineAlign: 'center',
      position: 20,
    });

    expect(cue).toMatchObject({
      start: 1,
      end: 2.5,
      text: 'Top',
      align: 'left',
      x: 0.2,
    });
    expect(cue?.y).not.toBeNull();
  });

  test('a cue on a line number anchors by its line alignment', () => {
    const cue = cueOfVtt({
      startTime: 0,
      endTime: 1,
      text: 'Line',
      line: -1,
      lineAlign: 'end',
    });

    expect(cue).toMatchObject({ text: 'Line', vertical: 'bottom' });
  });

  test('an end before the start collapses to the start', () => {
    const cue = cueOfVtt({ startTime: 5, endTime: 2, text: 'x' });

    expect(cue).toMatchObject({ start: 5, end: 5 });
  });

  test('a cue without text, or with empty text, is nothing', () => {
    expect(cueOfVtt({ startTime: 0, endTime: 1 })).toBeNull();
    expect(cueOfVtt({ startTime: 0, endTime: 1, text: '' })).toBeNull();
  });
});

describe('with hls.js', () => {
  test('lists its renditions as the tracks', () => {
    const { sink, tracks } = makeSink();
    const mediaTracks = new MediaTracks(makeElement(), sink);
    const { hls } = makeHls();

    mediaTracks.useHls(hls);

    const list = tracks.at(-1)!;
    expect(list.map((t) => [t.id, t.kind, t.language, t.label])).toEqual([
      ['track:a:0', 'audio', 'en', 'English'],
      ['track:a:1', 'audio', 'en', 'English AD'],
      ['track:t:0', 'subtitles', 'pt', 'Português'],
      ['track:t:1', 'captions', 'en', 'English SDH'],
    ]);
    expect(list[0]).toMatchObject({ default: true, describesVideo: false });
    expect(list[1]).toMatchObject({ describesVideo: true });
    expect(list[3]).toMatchObject({ sdh: true, forced: true });
    expect(list[2]).toMatchObject({ sdh: false, forced: false });
  });

  test('selects the picked rendition and the subtitles', () => {
    const { sink } = makeSink();
    const mediaTracks = new MediaTracks(makeElement(), sink);
    const { hls, calls } = makeHls();
    mediaTracks.useHls(hls);

    mediaTracks.select('track:a:1', 'track:t:0');

    expect(calls).toEqual(['audio:1', 'text:0']);
  });

  test('switches subtitles off for no pick or one out of range', () => {
    const { sink } = makeSink();
    const mediaTracks = new MediaTracks(makeElement(), sink);
    const { hls, calls } = makeHls();
    mediaTracks.useHls(hls);

    mediaTracks.select(null, null);
    mediaTracks.select('track:a:9', 'track:t:9');

    expect(calls).toEqual(['text:-1', 'text:-1']);
  });

  test('hides the text tracks hls.js shows and draws no cues without a pick', () => {
    const text = new FakeTrackList<FakeTextTrack>();
    const track = new FakeTextTrack('subtitles', 'English', 'en');
    track.mode = 'showing';
    text.items = [track];
    const { sink, cues } = makeSink();
    const mediaTracks = new MediaTracks(makeElement({ text }), sink);
    mediaTracks.useHls(makeHls().hls);

    mediaTracks.select(null, null);
    track.showCues({ startTime: 0, endTime: 1, text: 'Hidden' });

    expect(track.mode).toBe('hidden');
    expect(cues.flat()).toEqual([]);
  });

  test('follows hls.js’s text track once a subtitle is picked', () => {
    const text = new FakeTrackList<FakeTextTrack>();
    const track = new FakeTextTrack('subtitles', 'English', 'en');
    track.mode = 'hidden';
    text.items = [track];
    const { sink, cues } = makeSink();
    const mediaTracks = new MediaTracks(makeElement({ text }), sink);
    mediaTracks.useHls(makeHls().hls);

    mediaTracks.select(null, 'track:t:0');
    text.dispatch('change');
    track.showCues({ startTime: 0, endTime: 1, text: 'Shown' });

    expect(cues.at(-1)?.map((c) => c.text)).toEqual(['Shown']);
  });
});

describe('close', () => {
  test('unsubscribes from the lists and the cues, and goes quiet', () => {
    const text = new FakeTrackList<FakeTextTrack>();
    const track = new FakeTextTrack('subtitles', 'English', 'en');
    text.items = [track];
    const audio = new FakeTrackList<FakeAudioTrack>();
    const { sink, tracks, cues } = makeSink();
    const mediaTracks = new MediaTracks(makeElement({ audio, text }), sink);
    mediaTracks.select(null, 'track:t:0');

    mediaTracks.close();
    mediaTracks.close();
    text.add(new FakeTextTrack('subtitles', 'More', 'xx'));
    track.showCues({ startTime: 0, endTime: 1, text: 'Late' });
    mediaTracks.select(null, null);
    mediaTracks.useHls(makeHls().hls);

    expect(tracks).toHaveLength(1);
    expect(cues.flat()).toEqual([]);
    for (const type of ['addtrack', 'removetrack', 'change']) {
      expect(text.listenerCount(type)).toBe(0);
      expect(audio.listenerCount(type)).toBe(0);
    }
    expect(track.listenerCount('cuechange')).toBe(0);
  });
});
