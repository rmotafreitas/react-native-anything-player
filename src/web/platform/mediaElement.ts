// The element a driver plays on: an `<audio>`, or a `<video>` that fills its
// stage and plays inline (iPhone Safari would take it fullscreen).

import { browser, type AudioElementLike } from './dom';

export function createMediaElement(
  kind: 'audio' | 'video',
  loop: boolean
): AudioElementLike {
  const document = browser().document!;
  if (kind === 'video') {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    // iPhone Safari before `playsInline` was a property.
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.loop = loop;
    Object.assign(video.style, {
      width: '100%',
      height: '100%',
      display: 'block',
      objectFit: 'contain',
      backgroundColor: 'black',
    });
    return video;
  }
  const element = document.createElement('audio');
  element.preload = 'auto';
  return element;
}
