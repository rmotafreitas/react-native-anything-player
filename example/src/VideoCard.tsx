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
        {v?.quality ?? '-'} · text {v?.textTrack ?? 'off'}
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
        {v?.qualities.map((q) => (
          <Small
            key={q.id}
            title={q.audioOnly ? 'audio' : `${q.height ?? '?'}p`}
            active={v.selectedQuality === q.id}
            onPress={() => player.selectQuality(q.id).catch(fail)}
          />
        ))}
        {v && v.qualities.length > 0 && (
          <Small
            title="auto"
            active={v.selectedQuality == null}
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
