/* global location */
// A video player in a plain page: `attachTo` puts the picture in a <div>,
// separate files per quality switch behind the picture, a SubRip file is
// drawn over it. `window.videoTest` is for the end-to-end tests
// (e2e/video.spec.ts).
import { Player } from 'react-native-anything-player/web';

const MEDIA = `${location.protocol}//${location.hostname}:8765`;
const log = document.getElementById('log');
const say = (text) => {
  log.textContent = `${text}\n${log.textContent}`.slice(0, 4000);
};

const player = new Player({ video: true });
player.attachTo(document.getElementById('stage'));

const test = { player, MEDIA, cues: [], errors: [], states: [] };
window.videoTest = test;
player.on('cues', (cues) => test.cues.push(cues.map((c) => c.text)));
player.on('error', (error, { fatal }) => {
  test.errors.push(`${error.code}:${fatal ? 'fatal' : 'recoverable'}`);
  say(`error ${error.code}: ${error.message}`);
});
player.on('stateChange', (state) => {
  test.states.push(state);
  say(`state ${state}`);
});
player.on('firstFrame', () => say('first frame'));

/** The video as two renditions, with subtitles. */
export function source() {
  return {
    uri: `${MEDIA}/video-720.mp4`,
    renditions: [
      {
        uri: `${MEDIA}/video-360.mp4`,
        height: 360,
        bitrate: 500_000,
        label: '360p',
      },
      {
        uri: `${MEDIA}/video-720.mp4`,
        height: 720,
        bitrate: 1_300_000,
        label: '720p',
      },
    ],
    subtitles: [
      {
        uri: `${MEDIA}/subs.srt`,
        language: 'en',
        label: 'English',
        default: true,
      },
    ],
    metadata: { title: 'Test pattern' },
  };
}
test.source = source;

const on = (id, run) =>
  document.getElementById(id).addEventListener('click', () => {
    run().catch((error) => say(`${id}: ${error.code ?? error}`));
  });
on('load', () => player.load(source(), { autoplay: true }));
on('play', () => player.play());
on('pause', () => player.pause());
on('low', () => player.selectQuality('r0'));
on('high', () => player.selectQuality('r1'));
on('auto', () => player.selectQuality('auto'));
on('subs', () =>
  player.selectSubtitles(player.status.video?.textTrack ? null : 'sub:0')
);
on('fullscreen', () =>
  player.status.video?.fullscreen
    ? player.dismissFullscreen()
    : player.presentFullscreen()
);
on('pip', () =>
  player.status.video?.pictureInPicture
    ? player.stopPictureInPicture()
    : player.startPictureInPicture()
);
