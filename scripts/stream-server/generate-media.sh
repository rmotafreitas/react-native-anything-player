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
# Video: 20 s of a test pattern with a running clock, as two renditions of
# one video and its sound alone, plus subtitles (renditions, quality switches,
# subtitles and the audio-only fallback in the browser tests).
for size in 360 720; do
  width=$((size * 16 / 9))
  rate=$([ "$size" = 360 ] && echo 400k || echo 1200k)
  ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=${width}x${size}:rate=25:duration=20" \
    -f lavfi -i "sine=frequency=330:duration=20:sample_rate=44100" \
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
SRT
cat > media/subs.vtt <<'VTT'
WEBVTT

00:00.500 --> 00:04.000
Primeira linha

00:04.000 --> 00:20.000 line:10%
Segunda linha
VTT
ls -la media
