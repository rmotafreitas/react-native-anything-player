import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Player,
  type PlayerError,
  type Source,
  usePlayerEvent,
  usePlayerStatus,
} from 'react-native-anything-player';
import { useCues, VideoView } from 'react-native-anything-player/video';
import { STREAM_HOST } from './config';

/** The stream server's Clear Key test key (scripts/stream-server). */
const DRM_KID = 'a7e61c373e219033c21091fa607bf3b8';
const DRM_KEY = '76a6c65c5ea762046bd749a2e632ccbb';

// The video player, created on first use: an app built without the video
// module throws VIDEO_UNAVAILABLE, and the card says so instead.
let video: Player | null = null;
let unavailable: string | null = null;

function videoPlayer(): Player | null {
  if (video == null && unavailable == null) {
    try {
      video = new Player({
        video: { whenBackgrounded: 'pip' },
        diagnostics: __DEV__,
      });
    } catch (error) {
      unavailable = (error as PlayerError).message;
    }
  }
  return video;
}

export const VIDEO_SOURCES: Array<{ label: string; source: () => Source }> = [
  {
    label: 'Video file',
    source: () => ({
      uri: `${STREAM_HOST}/video-360.mp4`,
      metadata: { title: 'Test pattern', artist: 'RNAP' },
    }),
  },
  {
    label: 'Renditions + SRT',
    source: () => ({
      renditions: [
        { uri: `${STREAM_HOST}/video-360.mp4`, height: 360 },
        { uri: `${STREAM_HOST}/video-720.mp4`, height: 720 },
        { uri: `${STREAM_HOST}/video-audio.m4a`, audioOnly: true },
      ],
      subtitles: [{ uri: `${STREAM_HOST}/subs.srt`, language: 'en' }],
      metadata: { title: 'Test pattern (renditions)', artist: 'RNAP' },
    }),
  },
  {
    label: 'DASH',
    source: () => ({
      uri: `${STREAM_HOST}/video-dash/manifest.mpd`,
      metadata: { title: 'Test pattern (DASH)', artist: 'RNAP' },
    }),
  },
  {
    label: 'HLS + tracks',
    source: () => ({
      uri: `${STREAM_HOST}/video-hls/master.m3u8`,
      metadata: { title: 'Test pattern (HLS)', artist: 'RNAP' },
    }),
  },
  {
    label: 'MKV + tracks',
    source: () => ({
      uri: `${STREAM_HOST}/remux/movie.mkv`,
      metadata: { title: 'Test pattern (Matroska)', artist: 'RNAP' },
    }),
  },
  {
    label: 'MPEG-TS',
    source: () => ({
      uri: `${STREAM_HOST}/remux/movie.ts`,
      metadata: { title: 'Test pattern (MPEG-TS)', artist: 'RNAP' },
    }),
  },
  {
    label: 'Live TS',
    source: () => ({
      uri: `${STREAM_HOST}/live.ts`,
      metadata: { title: 'Test channel (live MPEG-TS)', artist: 'RNAP' },
    }),
  },
  {
    // Most phones have no AC-3 decoder: the software decoders play it.
    label: 'AC-3 audio',
    source: () => ({
      uri: `${STREAM_HOST}/remux/codec-ac3.mkv`,
      metadata: { title: 'Test pattern (AC-3)', artist: 'RNAP' },
    }),
  },
  {
    label: 'DRM keys',
    source: () => ({
      uri: `${STREAM_HOST}/drm/hls/index.m3u8`,
      // Clear Key with its keys in the source: no license server.
      drm: { clearkey: { keys: { [DRM_KID]: DRM_KEY } } },
      metadata: { title: 'Test pattern (Clear Key)', artist: 'RNAP' },
    }),
  },
  {
    label: 'DRM getLicense',
    source: () => ({
      uri: `${STREAM_HOST}/drm/hls/index.m3u8`,
      drm: {
        clearkey: { licenseUrl: `${STREAM_HOST}/drm/clearkey?token=demo` },
        // The app asks its license server itself (a session token here).
        getLicense: async ({ challenge, licenseUrl }) => {
          const response = await fetch(licenseUrl!, {
            method: 'POST',
            body: challenge,
            // React Native's fetch sends a binary body only with a type.
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Drm-Token': 'demo',
            },
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.arrayBuffer();
        },
      },
      metadata: { title: 'Test pattern (getLicense)', artist: 'RNAP' },
    }),
  },
];

function Small({
  title,
  onPress,
  active,
}: {
  title: string;
  onPress: () => void;
  active?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        active && styles.active,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.buttonText}>{title}</Text>
    </Pressable>
  );
}

/** A video player with its picture, subtitles, qualities, fullscreen and PiP. */
export function VideoCard() {
  const [player] = useState(videoPlayer);
  const [controls, setControls] = useState(false);
  const [error, setError] = useState<string | null>(unavailable);
  if (player == null) {
    return <Text style={styles.subtle}>{error}</Text>;
  }
  return (
    <VideoPanel
      player={player}
      controls={controls}
      setControls={setControls}
      error={error}
      setError={setError}
    />
  );
}

function VideoPanel({
  player,
  controls,
  setControls,
  error,
  setError,
}: {
  player: Player;
  controls: boolean;
  setControls: (value: boolean) => void;
  error: string | null;
  setError: (value: string | null) => void;
}) {
  const status = usePlayerStatus(player);
  const cues = useCues(player);
  const v = status.video;
  const fail = (e: PlayerError) => setError(`${e.code}: ${e.message}`);
  usePlayerEvent(player, 'error', (e) => setError(`${e.code}: ${e.message}`));
  const textTrack = v?.tracks.find((t) => t.kind !== 'audio');
  const audioTracks = v?.tracks.filter((t) => t.kind === 'audio') ?? [];
  const nextAudio =
    audioTracks[
      (audioTracks.findIndex((t) => t.id === v?.audioTrack) + 1) %
        Math.max(1, audioTracks.length)
    ];
  return (
    <View>
      <VideoView
        player={player}
        nativeControls={controls}
        style={styles.video}
      />
      <Text style={styles.state} testID="video-state">
        {status.state} · {v?.width ?? '?'}×{v?.height ?? '?'} · q{' '}
        {status.quality ?? '-'} · text {v?.textTrack ?? 'off'}
        {v?.firstFrame ? ' · frame' : ''}
        {v?.pictureInPicture ? ' · pip' : ''}
        {v?.fullscreen ? ' · fullscreen' : ''}
        {v?.audioOnly ? ` · audio (${v.audioOnly})` : ''}
      </Text>
      <Text style={styles.subtle} testID="video-cues">
        cues: {cues.map((c) => c.text).join(' / ') || '—'}
      </Text>
      {error && <Text style={styles.error}>{error}</Text>}
      <View style={styles.wrap}>
        {VIDEO_SOURCES.map((s) => (
          <Small
            key={s.label}
            title={s.label}
            onPress={() => {
              setError(null);
              player.load(s.source(), { autoplay: true }).catch(fail);
            }}
          />
        ))}
        <Small
          title={status.playWhenReady ? 'Pause' : 'Play'}
          onPress={() => player.toggle().catch(fail)}
        />
        <Small
          title="Controls"
          active={controls}
          onPress={() => setControls(!controls)}
        />
        <Small
          title="Fullscreen"
          onPress={() =>
            player
              .presentFullscreen({ lockOrientation: 'landscape' })
              .catch(fail)
          }
        />
        <Small
          title="PiP"
          onPress={() => player.startPictureInPicture().catch(fail)}
        />
        <Small
          title={v?.textTrack ? 'Subs off' : 'Subs on'}
          onPress={() =>
            player
              .selectSubtitles(v?.textTrack ? null : (textTrack?.id ?? null))
              .catch(fail)
          }
        />
        {audioTracks.length > 1 && nextAudio && (
          <Small
            title={`Audio: ${nextAudio.language ?? nextAudio.id}`}
            onPress={() => player.selectAudioTrack(nextAudio.id).catch(fail)}
          />
        )}
        {status.qualities.map((q) => (
          <Small
            key={q.id}
            title={q.audioOnly ? 'audio' : `${q.height ?? '?'}p`}
            active={status.selectedQuality === q.id}
            onPress={() => player.selectQuality(q.id).catch(fail)}
          />
        ))}
        {status.qualities.length > 0 && (
          <Small
            title="auto"
            active={status.selectedQuality == null}
            onPress={() => player.selectQuality('auto').catch(fail)}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  video: { width: '100%', aspectRatio: 16 / 9, borderRadius: 12 },
  state: { color: '#7bed9f', fontSize: 13, marginTop: 8, fontWeight: '600' },
  subtle: { color: '#9a9ac0', fontSize: 13, marginTop: 4 },
  error: { color: '#ff7675', marginTop: 6 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  button: {
    backgroundColor: '#2e2f55',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  active: { backgroundColor: '#6c5ce7' },
  pressed: { opacity: 0.6 },
  buttonText: { color: 'white', fontSize: 13 },
});
