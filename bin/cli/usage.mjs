// Command table, option specs and help text. Every command is one entry here,
// so the parser, the help output and the tests read the same list.

import { MODULES } from './modules.mjs';

const MODULE_NAMES = MODULES.map((module) => module.id).join(', ');

/**
 * @typedef {object} CommandSpec
 * @property {string[]} flags command-only options, by long name
 * @property {false|'modules'|'paths'} positionals what the bare arguments are
 * @property {string} summary one line, in the global usage
 * @property {string} help the whole `rnap <command> --help` text
 */

/** @type {Record<string, CommandSpec>} */
export const COMMANDS = {
  doctor: {
    flags: ['url', 'packageUrls'],
    positionals: false,
    summary: 'report project setup problems (exit 1 when any is an error)',
    help: `Usage: rnap doctor [options]

Report what is wrong with this project: versions, the New Architecture, the
Expo plugin, the module switches, iOS and Android settings, Pods, and — with
--url — the stream servers the app plays. Nothing is changed.

Options
  --cwd <dir>     project directory (default: current directory)
  --url <url>     stream URL to probe; repeatable
  --package-urls  also probe the URLs in package.json "rnap.urls"
  --json          machine-readable report
  --no-color      plain text (also honours NO_COLOR)
  --help, -h      this text

Exit codes: 0 no errors, 1 at least one error, 2 bad usage.

Examples
  npx rnap doctor
  npx rnap doctor --url https://radio.example/live.mp3 --json
`,
  },
  init: {
    flags: ['yes'],
    positionals: false,
    summary: 'apply the safe fixes, each as a diff',
    help: `Usage: rnap init [options]

Apply the safe subset of the fixes doctor reports. Each change is shown as a
unified diff and applied only when you answer yes.

Options
  --cwd <dir>  project directory (default: current directory)
  --yes, -y    apply every fix without asking
  --json       machine-readable report (without --yes: a dry run)
  --no-color   plain text (also honours NO_COLOR)
  --help, -h   this text

Exit codes: 0 no errors remain, 1 errors remain, 2 bad usage.

Examples
  npx rnap init
  npx rnap init --yes
`,
  },
  modules: {
    flags: [],
    positionals: false,
    summary: 'list the build modules and whether this project has them',
    help: `Usage: rnap modules [options]

List every build module, whether it is on in this project, where that is
configured, and what it adds to a release APK when it is measured.

Options
  --cwd <dir>  project directory (default: current directory)
  --json       machine-readable report
  --no-color   plain text (also honours NO_COLOR)
  --help, -h   this text

Exit codes: 0 this is a report, 1 no package.json here, 2 bad usage.

Example
  npx rnap modules
`,
  },
  add: {
    flags: ['yes', 'dryRun'],
    positionals: 'modules',
    summary: 'turn build modules on (no names: pick them in a terminal)',
    help: `Usage: rnap add [module…] [options]

Turn build modules on. With no module names and a terminal, an interactive
picker lists every module with its description and measured size.

Modules: ${MODULE_NAMES}

Options
  --cwd <dir>  project directory (default: current directory)
  --dry-run    show the diff and write nothing
  --yes, -y    apply without asking
  --json       machine-readable report (without --yes: a dry run)
  --no-color   plain text (also honours NO_COLOR)
  --help, -h   this text

Where it writes: android/gradle.properties, ios/Podfile.properties.json and
the app's Info.plist for a bare app; the Expo plugin options in app.json for
an Expo app. app.config.js/ts is never edited: the exact snippet is printed.

Exit codes: 0 changed, already on, or nothing accepted (a \`no\` answer, or the
picker closed), 1 no package.json here, the project cannot be changed
safely, or a file changed after the diff was shown, 2 bad usage (including an unknown module name).

Examples
  npx rnap add cast
  npx rnap add sound car --dry-run
  npx rnap add
`,
  },
  remove: {
    flags: ['yes', 'dryRun'],
    positionals: 'modules',
    summary: 'turn build modules off',
    help: `Usage: rnap remove [module…] [options]

Turn build modules off, as a diff first. The module names are the same as for
\`rnap add\`; \`rnap modules\` lists them.

Options
  --cwd <dir>  project directory (default: current directory)
  --dry-run    show the diff and write nothing
  --yes, -y    apply without asking
  --json       machine-readable report (without --yes: a dry run)
  --no-color   plain text (also honours NO_COLOR)
  --help, -h   this text

Exit codes: 0 changed, already off, or nothing accepted (a \`no\` answer, or the
picker closed), 1 no package.json here, the project cannot be changed
safely, or a file changed after the diff was shown, 2 bad usage (including an unknown module name).

Examples
  npx rnap remove cast
  npx rnap remove hls --dry-run
`,
  },
  size: {
    flags: [],
    positionals: false,
    summary: 'what the enabled modules add to a release APK and a web page',
    help: `Usage: rnap size [options]

Print what this project's modules add to a release Android APK, with R8 and
without, and to a web page. The numbers are measured on a React Native release
build and bundled into the CLI: they are estimates for this app.

Options
  --cwd <dir>  project directory (default: current directory)
  --json       machine-readable report
  --no-color   plain text (also honours NO_COLOR)
  --help, -h   this text

Exit codes: 0 this is a report, 1 no package.json here or the measured data is
missing, 2 bad usage.

Example
  npx rnap size
`,
  },
  info: {
    flags: [],
    positionals: false,
    summary: 'a paste-able report for bug reports',
    help: `Usage: rnap info [options]

Print one report to paste into a bug report: versions, platforms, the build
modules that are on, the tools on this machine and a summary of doctor's
findings. Paths are printed with your home directory as ~.

Options
  --cwd <dir>  project directory (default: current directory)
  --json       machine-readable report
  --no-color   plain text (also honours NO_COLOR)
  --help, -h   this text

Exit codes: 0 always (this is a report), 2 bad usage.

Example
  npx rnap info
`,
  },
  migrate: {
    flags: ['from', 'yes', 'dryRun'],
    positionals: 'paths',
    summary: 'rewrite Track Player, expo-audio or expo-av calls to RNAP',
    help: `Usage: rnap migrate [paths…] [options]

Rewrite the mechanical part of a migration to RNAP: imports, the player
commands, the hooks and the state constants. Anything that needs a decision is
left alone and marked with a \`// rnap-migrate:\` comment that names the section
of the guide. Each file is shown as a unified diff before it is written.

Paths are files or directories. Default: the whole project, skipping
node_modules, ios, android, build outputs and dot directories.

--from is detected from the imports when it is omitted.

Options
  --from <library>  track-player, expo-audio or expo-av
  --cwd <dir>       project directory (default: current directory)
  --dry-run         show the diffs and write nothing
  --yes, -y         apply without asking
  --json            machine-readable report (without --yes: a dry run)
  --no-color        plain text (also honours NO_COLOR)
  --help, -h        this text

Exit codes: 0 rewrote or found nothing, 1 a file could not be parsed, a file
changed after the diff was shown, or @babel/parser is not installed in the
project (migrate loads the project's own copy), 2 bad usage (an unknown \`--from\`, or a path that does not exist or is outside
the project).

Examples
  npx rnap migrate --dry-run
  npx rnap migrate src App.tsx --from expo-av
`,
  },
  help: {
    flags: [],
    positionals: false,
    summary: 'the commands, options and exit codes',
    help: `Usage: rnap help [command]

Print the global usage, or the help of one command: \`rnap help modules\` is
\`rnap modules --help\`.

Exit codes: 0 printed, 2 unknown command.
`,
  },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

export const USAGE = `Usage: rnap <command> [options]

Commands
${COMMAND_NAMES.map(
  (name) =>
    `  ${name.padEnd(17)}${COMMANDS[name].summary}`
).join('\n')}

Options
  --cwd <dir>    project directory (default: current directory)
  --json         machine-readable output
  --dry-run      show the changes without writing them (add, remove, migrate)
  --yes, -y      apply the changes without asking (init, add, remove, migrate)
  --no-color     plain text (also honours NO_COLOR)
  --help, -h     this text, or the help of the command it follows
  --version, -v  the CLI version

Command options
  doctor   --url <url> (repeatable), --package-urls
  migrate  --from <track-player|expo-audio|expo-av>

Exit codes
  0  no errors (doctor, init), changed, already so, or nothing accepted
     (add, remove, migrate), a report (modules, size, info)
  1  at least one error (doctor, init), no package.json here (modules, add,
     remove, size), cannot change safely (init, add, remove, migrate), a file
     could not be parsed or @babel/parser is missing (migrate), no measured
     data (size)
  2  bad usage: unknown command, unknown option, unknown module, no command,
     or a --cwd that does not exist

Examples
  npx rnap doctor
  npx rnap modules
  npx rnap add cast
  npx rnap size --json
  npx rnap migrate src
`;

/** Help for one command, or the global usage for `help`. */
export function commandUsage(name) {
  const spec = COMMANDS[name];
  if (!spec || name === 'help') return USAGE;
  return spec.help;
}

/** The modules tag line, shared by the add/remove help and errors. */
export const MODULE_LIST = MODULE_NAMES;
