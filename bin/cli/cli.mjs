// Entry point logic: parse, dispatch, print, choose the exit code.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './args.mjs';
import { commandUsage, MODULE_LIST, USAGE } from './usage.mjs';
import { runDoctor } from './doctor.mjs';
import { runInit } from './init.mjs';
import { runInfo } from './info.mjs';
import { runMigrate } from './migrate.mjs';
import { runModules, runToggle } from './module-command.mjs';
import { resolveModules } from './modules.mjs';
import { createPainter, formatDoctor } from './report.mjs';
import { runSize } from './size.mjs';
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
  { stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}
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
  if (!options.command) {
    if (options.help) {
      stdout.write(USAGE);
      return 0;
    }
    stderr.write(USAGE);
    return 2;
  }
  if (options.help || options.command === 'help') {
    stdout.write(
      options.command === 'help' ? USAGE : commandUsage(options.command)
    );
    return 0;
  }

  const cwd = path.resolve(options.cwd);
  if (!isDirectory(cwd)) {
    stderr.write(`rnap: no such directory: ${options.cwd}\n`);
    return 2;
  }

  if (options.command === 'add' || options.command === 'remove') {
    const { unknown } = resolveModules(options.positionals);
    if (unknown.length > 0) {
      stderr.write(
        `rnap: unknown module ${unknown.map((name) => `\`${name}\``).join(', ')}\n\nModules: ${MODULE_LIST}\n`
      );
      return 2;
    }
  }

  const paint = createPainter(
    options.color && Boolean(stdout.isTTY) && !process.env.NO_COLOR
  );
  const version = cliVersion();

  switch (options.command) {
    case 'doctor':
      return runDoctorCommand({ options, cwd, version, paint, stdout });
    case 'init':
      return runInit({
        cwd,
        json: options.json,
        yes: options.yes,
        version,
        paint,
        stdout,
        stdin,
      });
    case 'modules':
      return runModules({ cwd, json: options.json, version, paint, stdout });
    case 'add':
    case 'remove':
      return runToggle({
        action: options.command,
        names: options.positionals,
        cwd,
        json: options.json,
        yes: options.yes,
        dryRun: options.dryRun,
        version,
        paint,
        stdout,
        stdin,
      });
    case 'size':
      return runSize({ cwd, json: options.json, version, paint, stdout });
    case 'info':
      return runInfo({ cwd, json: options.json, version, paint, stdout });
    case 'migrate':
      return runMigrate({
        cwd,
        paths: options.positionals,
        from: options.from,
        json: options.json,
        yes: options.yes,
        dryRun: options.dryRun,
        version,
        paint,
        stdout,
        stdin,
      });
    default:
      stderr.write(USAGE);
      return 2;
  }
}

async function runDoctorCommand({ options, cwd, version, paint, stdout }) {
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
