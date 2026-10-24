#!/usr/bin/env bash
# Generates the deterministic test media used by the stream server and the
# example app. Requires ffmpeg. Output is small and reproducible.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p media
# 120 s "live" program: a different pitch every 10 s so a listener can hear
# where in the program the player is (and whether a reconnect re-joined live).
inputs=()
filters=""
for i in $(seq 0 11); do
  freq=$((220 + i * 55))
  inputs+=(-f lavfi -i "sine=frequency=${freq}:duration=10:sample_rate=44100")
  filters+="[$i:a]"
done
ffmpeg -loglevel error -y "${inputs[@]}" -filter_complex "${filters}concat=n=12:v=0:a=1,volume=0.25,aformat=channel_layouts=stereo" \
  -c:a libmp3lame -b:a 128k -ar 44100 -write_xing 0 -id3v2_version 0 media/program.mp3
# The same program as ADTS AAC (64 kbps), for /live.aac: browsers that take AAC
# only inside MP4 are fed a remux of it.
ffmpeg -loglevel error -y -i media/program.mp3 -c:a aac -b:a 64k -ar 44100 -ac 2 -f adts media/program.aac
# 30 s file for VOD/seek tests and the bundled local asset.
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=30:sample_rate=44100" \
  -af "volume=0.25,aformat=channel_layouts=stereo" -c:a libmp3lame -b:a 96k media/file.mp3
# Cover art.
ffmpeg -loglevel error -y -f lavfi -i "color=c=0x6c5ce7:s=512x512:d=1" -frames:v 1 media/artwork.png
ffmpeg -loglevel error -y -f lavfi -i "color=c=0x00b894:s=512x512:d=1" -frames:v 1 media/artwork2.png
# Video: 60 s of a test pattern with a running clock, as two renditions of
# one video and its sound alone, plus subtitles (renditions, quality switches,
# subtitles and the audio-only fallback in the browser tests).
for size in 360 720; do
  width=$((size * 16 / 9))
  rate=$([ "$size" = 360 ] && echo 400k || echo 1200k)
  ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=${width}x${size}:rate=25:duration=60" \
    -f lavfi -i "sine=frequency=330:duration=60:sample_rate=44100" \
    -vf "drawtext=text='%{pts\\:hms} ${size}p':x=20:y=20:fontsize=$((size / 10)):fontcolor=white:box=1:boxcolor=black" \
    -c:v libx264 -profile:v baseline -pix_fmt yuv420p -b:v "$rate" -g 25 \
    -c:a aac -b:a 96k -ac 2 -shortest -movflags +faststart "media/video-${size}.mp4"
done
ffmpeg -loglevel error -y -i media/video-360.mp4 -vn -c:a copy -movflags +faststart media/video-audio.m4a
cat > media/subs.srt <<'SRT'
1
00:00:00,500 --> 00:00:04,000
First line

2
00:00:04,000 --> 00:00:08,000
<i>Second</i> line

3
00:00:08,000 --> 00:00:20,000
{\an8}Third line, at the top

4
00:00:20,000 --> 00:01:00,000
<font color="#ffd166">Fourth line</font>, in colour
SRT
cat > media/subs.vtt <<'VTT'
WEBVTT

00:00.500 --> 00:04.000
Primeira linha

00:04.000 --> 00:20.000 line:10%
Segunda linha
VTT
# The same video as HLS with its own tracks: two pictures (360p, 720p), two
# audio languages and two WebVTT subtitle groups (the source's tracks on
# Android, iOS and hls.js).
rm -rf media/hls-video && mkdir -p media/hls-video
for size in 360 720; do
  ffmpeg -loglevel error -y -i "media/video-${size}.mp4" -an -c:v copy -f hls -hls_time 4 -hls_playlist_type vod \
    -hls_segment_filename "media/hls-video/v${size}-%03d.ts" "media/hls-video/v${size}.m3u8"
done
for lang in en:330 es:550; do
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=${lang#*:}:duration=60:sample_rate=44100" \
    -c:a aac -b:a 96k -ac 2 -f hls -hls_time 4 -hls_playlist_type vod \
    -hls_segment_filename "media/hls-video/audio-${lang%%:*}-%03d.ts" "media/hls-video/audio-${lang%%:*}.m3u8"
done
# WebVTT segments line up with the video by its first timestamp (90 kHz).
start=$(ffprobe -v error -show_entries format=start_time -of csv=p=0 media/hls-video/v360-000.ts)
mpegts=$(awk -v s="$start" 'BEGIN { printf "%d", s * 90000 + 0.5 }')
subtitles() {
  cat > "media/hls-video/subs-$1.vtt" <<VTT
WEBVTT
X-TIMESTAMP-MAP=MPEGTS:${mpegts},LOCAL:00:00:00.000

00:00.500 --> 00:04.000
$2

00:04.000 --> 01:00.000
$3
VTT
  cat > "media/hls-video/subs-$1.m3u8" <<M3U8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:60
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:60.0,
subs-$1.vtt
#EXT-X-ENDLIST
M3U8
}
subtitles en "Embedded English" "Still English"
subtitles pt "Legenda em português" "Ainda em português"
cat > media/hls-video/master.m3u8 <<'M3U8'
#EXTM3U
#EXT-X-VERSION:4
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio-en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Español",LANGUAGE="es",DEFAULT=NO,AUTOSELECT=YES,URI="audio-es.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,URI="subs-en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Português",LANGUAGE="pt",DEFAULT=NO,AUTOSELECT=YES,URI="subs-pt.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=600000,AVERAGE-BANDWIDTH=520000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
v360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1500000,AVERAGE-BANDWIDTH=1320000,RESOLUTION=1280x720,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="aud",SUBTITLES="subs"
v720.m3u8
M3U8
# The same video as DASH (CMAF: fragmented MP4 segments, a SegmentTimeline
# template): two pictures and the sound (ExoPlayer's DASH module, Shaka on the
# web, iOS's DASH to HLS rewrite).
rm -rf media/dash-video && mkdir -p media/dash-video
ffmpeg -loglevel error -y -i media/video-360.mp4 -i media/video-720.mp4 \
  -map 0:v -map 1:v -map 0:a -c copy -f dash -seg_duration 4 -use_template 1 -use_timeline 1 \
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -init_seg_name 'init-$RepresentationID$.m4s' -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' \
  media/dash-video/manifest.mpd
# Containers browsers and AVPlayer do not read, for RNAP's remux: the video
# as Matroska (two audio languages, SubRip and ASS subtitles, a keyframe every
# 2 s), as an MPEG-TS file, as WebM (VP9 and Opus), and a minute of MPEG-TS
# the server sends as a live channel (/live.ts).
rm -rf media/remux && mkdir -p media/remux
cat > media/remux/subs.srt <<'SRT'
1
00:00:00,500 --> 00:00:04,000
Matroska <i>subtitles</i>

2
00:00:04,000 --> 00:00:30,000
Still the Matroska subtitles
SRT
cat > media/remux/subs.ass <<'ASS'
[Script Info]
ScriptType: v4.00+
PlayResX: 640
PlayResY: 360

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.50,0:00:04.00,Default,,0,0,0,,{\b1}Legendas{\b0} em ASS
Dialogue: 0,0:00:04.00,0:00:30.00,Default,,0,0,0,,{\an8}Ainda em ASS
ASS
X264="-c:v libx264 -preset veryfast -profile:v main -g 50 -keyint_min 50 -sc_threshold 0 -b:v 400k -pix_fmt yuv420p"
ffmpeg -loglevel error -y -i media/video-360.mp4 \
  -f lavfi -i "sine=frequency=330:duration=30:sample_rate=48000" \
  -f lavfi -i "sine=frequency=550:duration=30:sample_rate=44100" \
  -i media/remux/subs.srt -i media/remux/subs.ass \
  -map 0:v -map 1:a -map 2:a -map 3 -map 4 -t 30 $X264 -c:a aac -b:a 96k -ac 2 -c:s:0 srt -c:s:1 ass \
  -metadata:s:a:0 language=eng -metadata:s:a:0 title=English \
  -metadata:s:a:1 language=por -metadata:s:a:1 title=Português \
  -metadata:s:s:0 language=eng -metadata:s:s:1 language=por -metadata:s:s:1 title=ASS \
  -disposition:a:0 default -disposition:a:1 0 -disposition:s:0 0 -disposition:s:1 0 media/remux/movie.mkv
ffmpeg -loglevel error -y -i media/video-360.mp4 -t 30 $X264 -c:a aac -b:a 96k -ac 2 -f mpegts media/remux/movie.ts
ffmpeg -loglevel error -y -i media/video-360.mp4 -t 60 $X264 -c:a aac -b:a 96k -ac 2 -f mpegts media/remux/live.ts
ffmpeg -loglevel error -y -i media/video-360.mp4 -t 10 -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -g 50 -b:v 300k \
  -c:a libopus -b:a 64k media/remux/movie.webm
# Codecs few devices decode, for the software decoders: AC-3, DTS and MPEG
# audio layer II (DVB channels) sound, and AV1 video.
ffmpeg -loglevel error -y -i media/video-360.mp4 -t 10 $X264 -c:a ac3 -b:a 192k media/remux/codec-ac3.mkv
ffmpeg -loglevel error -y -i media/video-360.mp4 -t 10 $X264 -c:a dca -strict -2 -ar 48000 media/remux/codec-dts.mkv
ffmpeg -loglevel error -y -i media/video-360.mp4 -t 10 $X264 -c:a mp2 -b:a 192k -f mpegts media/remux/codec-mp2.ts
ffmpeg -loglevel error -y -i media/video-360.mp4 -t 10 -c:v libsvtav1 -preset 12 -g 50 -b:v 300k \
  -c:a libopus -b:a 64k media/remux/codec-av1.mkv

# DRM: the video as fragmented MP4 HLS, encrypted (CENC) with a Clear Key
# by encrypt-fmp4.mjs (browsers decrypt only fragmented MP4, and ffmpeg's own
# encryption of fragments is incomplete). The key and its id are the license
# server's (server.mjs).
DRM_KID=a7e61c373e219033c21091fa607bf3b8
DRM_KEY=76a6c65c5ea762046bd749a2e632ccbb
rm -rf media/drm && mkdir -p media/drm/hls
ffmpeg -loglevel error -y -i media/video-360.mp4 -t 20 -c copy -f hls -hls_time 4 -hls_playlist_type vod \
  -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4 -hls_segment_filename 'media/drm/hls/seg-%d.m4s' \
  media/drm/hls/index.m3u8
node encrypt-fmp4.mjs "${DRM_KID}" "${DRM_KEY}" media/drm/hls/init.mp4 media/drm/hls/seg-*.m4s

ls -la media media/hls-video media/dash-video media/remux media/drm | head -44
