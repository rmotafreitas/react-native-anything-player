// Entry point logic: parse, dispatch, print, choose the exit code.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, USAGE } from './args.mjs';
import { runDoctor } from './doctor.mjs';
import { runInit } from './init.mjs';
import { createPainter, formatDoctor } from './report.mjs';
import { isDirectory, readJson } from './util.mjs';

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);

export function cliVersion() {
  return readJson(path.join(cliRoot, 'package.json'))?.version ?? '0.0.0';
}

export async function main(
  argv,
  { stdout = process.stdout, stderr = process.stderr } = {}
) {
  const options = parseArgs(argv);
  if (options.error) {
    stderr.write(`rnap: ${options.error}\n\n${USAGE}`);
    return 2;
  }
  if (options.version) {
    stdout.write(`${cliVersion()}\n`);
    return 0;
  }
  if (options.help || options.command === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (!options.command) {
    stderr.write(USAGE);
    return 2;
  }

  const cwd = path.resolve(options.cwd);
  if (!isDirectory(cwd)) {
    stderr.write(`rnap: no such directory: ${options.cwd}\n`);
    return 2;
  }

  const paint = createPainter(
    options.color && Boolean(stdout.isTTY) && !process.env.NO_COLOR
  );
  const version = cliVersion();

  if (options.command === 'doctor') {
    const { report } = await runDoctor({
      cwd,
      urls: options.urls,
      packageUrls: options.packageUrls,
    });
    stdout.write(
      options.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : formatDoctor(report, { version, paint })
    );
    return report.ok ? 0 : 1;
  }

  return runInit({
    cwd,
    json: options.json,
    yes: options.yes,
    version,
    paint,
    stdout,
    stdin: process.stdin,
  });
}
