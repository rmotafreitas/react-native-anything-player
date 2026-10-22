#!/usr/bin/env node
// react-native-anything-player's project check: `rnap doctor` / `rnap init`.
// Installed as both `rnap` and `react-native-anything-player` (package.json).

import { main } from './cli/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
