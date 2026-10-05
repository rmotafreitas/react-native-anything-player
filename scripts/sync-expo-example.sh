#!/usr/bin/env bash
# Builds the npm tarball and installs it into example-expo exactly like a
# consumer would (no workspace links), then copies the shared example UI and
# integration scenarios from example/src.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
yarn prepare >/dev/null
tarball=$(npm pack --silent | tail -1)
mv "$tarball" example-expo/react-native-anything-player.tgz
mkdir -p example-expo/src example-expo/assets
cp example/src/*.ts example/src/*.tsx example-expo/src/
cp example/assets/tone.mp3 example/assets/cover.png example-expo/assets/
cd example-expo
npm install --no-audit --no-fund ./react-native-anything-player.tgz
