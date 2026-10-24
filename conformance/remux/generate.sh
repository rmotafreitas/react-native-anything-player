#!/usr/bin/env bash
# Regenerates the remux fixtures (needs ffmpeg with libx264, libx265,
# libvpx, libsvtav1, libopus, libmp3lame, and mkvmerge). Three seconds of a
# 128x72 test picture, a keyframe every second, in each container and codec
# RNAP remuxes. The goldens (`*.out/`) are written by the TypeScript twin:
# RNAP_WRITE_GOLDEN=1 npx jest remux; the Swift twin must match them byte
# for byte.
set -euo pipefail
cd "$(dirname "$0")"
export SVT_LOG=1
V=(-f lavfi -i testsrc2=size=128x72:rate=25:duration=3)
A1=(-f lavfi -i sine=frequency=440:sample_rate=48000:duration=3)
A2=(-f lavfi -i sine=frequency=660:sample_rate=44100:duration=3)
X264=(-c:v libx264 -profile:v main -preset veryfast -g 25 -keyint_min 25 -sc_threshold 0 -bf 2 -pix_fmt yuv420p -b:v 60k -bitexact)
X265=(-c:v libx265 -x265-params log-level=error:keyint=25:min-keyint=25:bframes=2:info=0 -b:v 60k)
ff() { ffmpeg -v error -y "$@"; }

# MKV: H.264 with B-frames, two AAC tracks, SubRip and ASS subtitles.
ff "${V[@]}" "${A1[@]}" "${A2[@]}" -i sub.srt -i sub.ass -map 0 -map 1 -map 2 -map 3 -map 4 \
  "${X264[@]}" -c:a aac -b:a 32k -ac 2 -c:s:0 srt -c:s:1 ass \
  -metadata:s:a:0 language=eng -metadata:s:a:0 title=English \
  -metadata:s:a:1 language=por -metadata:s:a:1 title=Português \
  -metadata:s:s:0 language=eng -metadata:s:s:1 language=por -metadata:s:s:1 title=Styled \
  -disposition:a:0 default -disposition:a:1 0 -fflags +bitexact h264-aac.mkv
# The same through mkvmerge: laced audio, BlockGroups.
mkvmerge -q --disable-track-statistics-tags -o h264-aac-laced.mkv h264-aac.mkv
# WebM: VP9 and Opus.
ff "${V[@]}" "${A1[@]}" -c:v libvpx-vp9 -g 25 -b:v 60k -deadline realtime -cpu-used 8 \
  -c:a libopus -b:a 24k -fflags +bitexact vp9-opus.webm
# MKV: AV1 and FLAC.
ff "${V[@]}" "${A2[@]}" -c:v libsvtav1 -g 25 -preset 12 -crf 50 -pix_fmt yuv420p \
  -c:a flac -ac 1 -fflags +bitexact av1-flac.mkv
# MKV: HEVC, E-AC-3 and MP3.
ff "${V[@]}" "${A1[@]}" "${A2[@]}" -map 0 -map 1 -map 2 "${X265[@]}" -tag:v hvc1 \
  -c:a:0 eac3 -b:a:0 96k -c:a:1 libmp3lame -b:a:1 32k -fflags +bitexact hevc-eac3-mp3.mkv
# MPEG-TS: H.264 and AAC (ADTS).
ff "${V[@]}" "${A1[@]}" "${X264[@]}" -c:a aac -b:a 32k -ac 2 -fflags +bitexact -f mpegts h264-aac.mpegts
# M2TS (192-byte packets): H.264 and AAC. (`.mpegts`, not `.ts`: TypeScript's.)
ff "${V[@]}" "${A1[@]}" "${X264[@]}" -c:a aac -b:a 32k -ac 2 -fflags +bitexact -f mpegts -mpegts_m2ts_mode 1 h264-aac.m2ts
# MPEG-TS: HEVC, AC-3 and MP3, with languages.
ff "${V[@]}" "${A1[@]}" "${A2[@]}" -map 0 -map 1 -map 2 "${X265[@]}" \
  -c:a:0 ac3 -b:a:0 96k -c:a:1 libmp3lame -b:a:1 32k \
  -metadata:s:a:0 language=eng -metadata:s:a:1 language=fra -fflags +bitexact -f mpegts hevc-ac3-mp3.mpegts
