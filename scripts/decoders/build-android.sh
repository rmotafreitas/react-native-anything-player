#!/usr/bin/env bash
# Builds Media3's software decoders for Android from pinned sources: FFmpeg
# (LGPL; audio only: AC-3, E-AC-3, DTS, TrueHD, MPEG audio layer II), libvpx
# (VP9) and dav1d (AV1), for arm64-v8a, armeabi-v7a, x86_64 and x86.
#
#   scripts/decoders/build-android.sh <work dir> <out dir>
#
# Writes <out>/media3-decoder-{ffmpeg,vp9,av1}-<media3>.aar and SHA256SUMS.
# CI publishes them as a GitHub Release (.github/workflows/decoders.yml);
# android/decoders.json pins the release and its checksums, and an app gets
# them with `rnapVideoDecoders=true` (`npx rnap add video-decoders`).
#
# Runs on Linux. Needs git, make, curl, python3, JDK 21, and an Android SDK (ANDROID_HOME)
# with NDK 27.1.12297006 and CMake. Meson and Ninja are used from PATH, else
# fetched (Meson) or taken from the SDK's CMake (Ninja). nasm gives dav1d its
# x86 SIMD; without it the x86 builds (emulators) are plain C.
set -euo pipefail

MEDIA3=1.11.1
MEDIA3_COMMIT=8c6678b657ede1e7883fc164ef73ed483c7796c3
FFMPEG_COMMIT=573f2b81ebd97da81def2ba762e81b0328547004 # release/6.0, as Media3 recommends
LIBVPX_TAG=v1.15.2
LIBVPX_COMMIT=d168454ecd099805c675d4a98c66f4891373302a
DAV1D_TAG=1.5.1
DAV1D_COMMIT=42b2b24fb8819f1ed3643aa9cf2a62f03868e3aa
CPU_FEATURES_TAG=v0.10.1
CPU_FEATURES_COMMIT=d3b2440fcfc25fe8e6d0d4a85f06d68e98312f5b
MESON_VERSION=1.6.1
NDK_VERSION=27.1.12297006
MIN_SDK=24
# FFmpeg names: `dca` is DTS; `mp3` decodes every MPEG audio layer (Media3 sends
# layers I and II to it too).
AUDIO_DECODERS=(ac3 eac3 dca truehd mp3)

WORK="$(mkdir -p "${1:?work dir}" && cd "$1" && pwd)"
OUT="$(mkdir -p "${2:?out dir}" && cd "$2" && pwd)"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
NDK="$SDK/ndk/$NDK_VERSION"
HOST=linux-x86_64 # Linux only (CI runs it on Ubuntu)
[[ -d "$NDK" ]] || { echo "NDK $NDK_VERSION not found in $SDK/ndk" >&2; exit 1; }

# A tag (or, with no tag, a commit) at exactly the pinned commit.
fetch() {
  local url="$1" tag="$2" commit="$3" dir="$4"
  if [[ ! -d "$dir/.git" ]]; then
    if [[ -n "$tag" ]]; then
      git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$url" "$dir"
    else
      git init --quiet "$dir"
      git -C "$dir" fetch --quiet --depth 1 "$url" "$commit"
      git -C "$dir" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
    fi
  fi
  local head
  head="$(git -C "$dir" rev-parse HEAD)"
  [[ "$head" == "$commit" ]] || { echo "$dir is at $head, not the pinned $commit" >&2; exit 1; }
}

# ── Tools ──
export PATH="$WORK/bin:$PATH"
mkdir -p "$WORK/bin"
if ! command -v meson >/dev/null; then
  [[ -d "$WORK/meson-$MESON_VERSION" ]] ||
    curl -fsSL "https://github.com/mesonbuild/meson/releases/download/$MESON_VERSION/meson-$MESON_VERSION.tar.gz" | tar xz -C "$WORK"
  printf '#!/bin/sh\nexec python3 "%s/meson-%s/meson.py" "$@"\n' "$WORK" "$MESON_VERSION" > "$WORK/bin/meson"
  chmod +x "$WORK/bin/meson"
fi
if ! command -v ninja >/dev/null; then
  ninja="$(ls -d "$SDK"/cmake/*/bin 2>/dev/null | sort -V | tail -1)"
  [[ -x "$ninja/ninja" ]] || { echo "ninja not found (install it, or CMake in the SDK)" >&2; exit 1; }
  export PATH="$ninja:$PATH"
fi

# ── Sources ──
MEDIA="$WORK/media"
fetch https://github.com/androidx/media.git "$MEDIA3" "$MEDIA3_COMMIT" "$MEDIA"
FFMPEG_MODULE="$MEDIA/libraries/decoder_ffmpeg/src/main"
VP9_MODULE="$MEDIA/libraries/decoder_vp9/src/main"
AV1_MODULE="$MEDIA/libraries/decoder_av1/src/main"
fetch https://github.com/FFmpeg/FFmpeg.git "" "$FFMPEG_COMMIT" "$FFMPEG_MODULE/jni/ffmpeg"
fetch https://chromium.googlesource.com/webm/libvpx "$LIBVPX_TAG" "$LIBVPX_COMMIT" "$VP9_MODULE/jni/libvpx"
fetch https://code.videolan.org/videolan/dav1d.git "$DAV1D_TAG" "$DAV1D_COMMIT" "$AV1_MODULE/jni/dav1d"
fetch https://github.com/google/cpu_features.git "$CPU_FEATURES_TAG" "$CPU_FEATURES_COMMIT" "$AV1_MODULE/jni/cpu_features"

# ── Native libraries ──
(cd "$FFMPEG_MODULE/jni" && ./build_ffmpeg.sh "$FFMPEG_MODULE" "$NDK" "$HOST" "$MIN_SDK" "${AUDIO_DECODERS[@]}")
(cd "$VP9_MODULE/jni" && ./generate_libvpx_android_configs.sh && "$NDK/ndk-build" -j"$(nproc 2>/dev/null || echo 4)")
# dav1d: without nasm, x86 is built without its assembly; tools and tests are skipped.
dav1d_script="$WORK/build_dav1d.sh"
sed 's|meson setup "${ABI_BUILD_DIR}" --cross-file="${TEMP_CROSS_FILE}" --default-library=static|EXTRA=""; if ! command -v nasm >/dev/null \&\& [[ "$android_abi" == x86* ]]; then EXTRA="-Denable_asm=false"; fi\n    meson setup "${ABI_BUILD_DIR}" --cross-file="${TEMP_CROSS_FILE}" --default-library=static -Denable_tools=false -Denable_tests=false $EXTRA|' \
  "$AV1_MODULE/jni/build_dav1d.sh" > "$dav1d_script"
grep -q 'enable_tools=false' "$dav1d_script" || { echo "Media3's build_dav1d.sh changed: update this script" >&2; exit 1; }
bash "$dav1d_script" "$AV1_MODULE" "$NDK" "$HOST"

# ── The AARs ──
echo "sdk.dir=$SDK" > "$MEDIA/local.properties"
(cd "$MEDIA" && ./gradlew --no-daemon --quiet \
  :lib-decoder-ffmpeg:assembleRelease :lib-decoder-vp9:assembleRelease :lib-decoder-av1:assembleRelease)
rm -f "$OUT/SHA256SUMS"
for name in ffmpeg vp9 av1; do
  cp "$MEDIA/libraries/decoder_$name/buildout/outputs/aar/lib-decoder-$name-release.aar" \
    "$OUT/media3-decoder-$name-$MEDIA3.aar"
done
(cd "$OUT" && sha256sum media3-decoder-*-"$MEDIA3".aar > SHA256SUMS && cat SHA256SUMS)
