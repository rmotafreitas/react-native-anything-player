import { Platform } from 'react-native';
import type { Source } from 'react-native-anything-player';

/** The test stream server (scripts/stream-server). The Android emulator
 * reaches the host machine as 10.0.2.2. Override with STREAM_HOST below for
 * a physical device on the same network. */
export const STREAM_HOST =
  Platform.OS === 'android' ? 'http://10.0.2.2:8765' : 'http://localhost:8765';

export const COVER = require('../assets/cover.png');
export const LOCAL_TONE = require('../assets/tone.mp3');

export interface Station {
  label: string;
  source: Source | number;
  live?: boolean;
}

export const STATIONS: Station[] = [
  { label: 'Local file (bundled asset)', source: LOCAL_TONE },
  {
    label: 'Remote file (test server)',
    source: {
      uri: `${STREAM_HOST}/file.mp3`,
      metadata: { title: 'Remote tone', artist: 'RNAP', artwork: COVER },
    },
  },
  {
    label: 'Test radio (ICY)',
    live: true,
    source: {
      uri: `${STREAM_HOST}/live.mp3?titleEvery=10`,
      live: true,
      metadata: {
        title: 'RNAP Test Radio',
        artwork: `${STREAM_HOST}/artwork2.png`,
      },
    },
  },
  {
    label: 'Test radio: stalls at 8 s for 10 s',
    live: true,
    source: {
      uri: `${STREAM_HOST}/live.mp3?stallAfter=8&stallFor=10`,
      live: true,
      metadata: { title: 'Stalling radio' },
    },
  },
  {
    label: 'Test radio: drops every 15 s',
    live: true,
    source: {
      uri: `${STREAM_HOST}/live.mp3?dropAfter=15`,
      live: true,
      metadata: { title: 'Dropping radio' },
    },
  },
  {
    label: 'Test radio: Latin-1 + malformed metadata',
    live: true,
    source: {
      uri: `${STREAM_HOST}/live.mp3?charset=latin1&malformed=1&titleEvery=5`,
      live: true,
    },
  },
  {
    label: 'Rádio Animu 192k MP3 (real ICY)',
    live: true,
    source: {
      uri: 'https://stream.animu.moe/192',
      metadata: {
        title: 'Rádio Animu',
        artwork: 'https://www.animu.moe/favicon.png',
      },
    },
  },
  {
    label: 'Rádio Animu 64k AAC+ (real ICY)',
    live: true,
    source: {
      uri: 'https://stream.animu.moe/64',
      metadata: { title: 'Rádio Animu (AAC+)' },
    },
  },
  { label: 'HTTP 404', source: { uri: `${STREAM_HOST}/live.mp3?status=404` } },
  {
    label: 'Unresolvable host',
    source: { uri: 'https://does-not-exist.invalid/stream.mp3' },
  },
];

export async function serverControl(query: string): Promise<unknown> {
  const response = await fetch(`${STREAM_HOST}/control?${query}`);
  return response.json();
}

export async function serverStats(): Promise<{
  active: number;
  total: number;
  activeIds: number[];
}> {
  const response = await fetch(`${STREAM_HOST}/stats`);
  return response.json();
}
