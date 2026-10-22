#!/usr/bin/env node
// `rnap`: project checks, build modules, size, info and the migration codemod.
// Installed as both `rnap` and `react-native-anything-player` (package.json).

import { main } from './cli/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
