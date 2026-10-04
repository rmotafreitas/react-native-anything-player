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
# 30 s file for VOD/seek tests and the bundled local asset.
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=30:sample_rate=44100" \
  -af "volume=0.25,aformat=channel_layouts=stereo" -c:a libmp3lame -b:a 96k media/file.mp3
# Cover art.
ffmpeg -loglevel error -y -f lavfi -i "color=c=0x6c5ce7:s=512x512:d=1" -frames:v 1 media/artwork.png
ffmpeg -loglevel error -y -f lavfi -i "color=c=0x00b894:s=512x512:d=1" -frames:v 1 media/artwork2.png
ls -la media
