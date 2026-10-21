#!/usr/bin/env bash
# Builds the Expo example for the web (example-expo/dist-web) against the
# current library, installed from its npm tarball like a consumer's would be.
# Used by `yarn test:web` and CI; the end-to-end suite serves the output.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
yarn prepare >/dev/null
yarn pack --out example-expo/react-native-anything-player.tgz >/dev/null
cd example-expo
if [ -n "${CI:-}" ]; then
  npm ci --no-audit --no-fund
else
  # Same tarball name, new contents: npm would keep the installed copy.
  rm -rf node_modules/react-native-anything-player
  npm install --no-audit --no-fund
fi
rm -rf dist-web
npx expo export --platform web --output-dir dist-web
