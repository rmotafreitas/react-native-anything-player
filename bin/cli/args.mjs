// Command line parsing. Kept separate from the commands so `--help` and usage
// errors work the same for every command: the option table lives in usage.mjs,
// next to the help text that documents it.

import { COMMANDS } from './usage.mjs';

/** Long name -> how it is read. `flags` in COMMANDS refers to these keys. */
const FLAGS = {
  json: { option: '--json', key: 'json' },
  yes: { option: '--yes', alias: '-y', key: 'yes' },
  dryRun: { option: '--dry-run', key: 'dryRun' },
  packageUrls: { option: '--package-urls', key: 'packageUrls' },
  color: { option: '--no-color', key: 'color', value: false },
  help: { option: '--help', alias: '-h', key: 'help' },
  version: { option: '--version', alias: '-v', key: 'version' },
  cwd: { option: '--cwd', key: 'cwd', takesValue: true },
  url: { option: '--url', key: 'urls', takesValue: true, repeat: true },
  from: { option: '--from', key: 'from', takesValue: true },
};

/** Options every command accepts. */
const GLOBAL = ['cwd', 'json', 'color', 'help', 'version'];

const BY_OPTION = new Map(
  Object.entries(FLAGS).map(([name, spec]) => [spec.option, { name, ...spec }])
);
const BY_ALIAS = new Map(
  Object.entries(FLAGS)
    .filter(([, spec]) => spec.alias)
    .map(([name, spec]) => [spec.alias, { name, ...spec }])
);

const DEFAULTS = () => ({
  command: null,
  cwd: process.cwd(),
  urls: [],
  json: false,
  yes: false,
  dryRun: false,
  packageUrls: false,
  color: true,
  help: false,
  version: false,
  from: null,
  positionals: [],
  helpTopic: null,
  used: new Set(),
  error: null,
});

function takeValue(spec, argv, index, options) {
  const inline = argv[index].includes('=')
    ? argv[index].slice(argv[index].indexOf('=') + 1)
    : undefined;
  if (inline !== undefined) {
    options[spec.key] = spec.repeat ? [...options[spec.key], inline] : inline;
    options.used.add(spec.name);
    return index;
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('-')) {
    options.error = `${spec.option} needs a value`;
    return index;
  }
  options[spec.key] = spec.repeat ? [...options[spec.key], value] : value;
  options.used.add(spec.name);
  return index + 1;
}

export function parseArgs(argv) {
  const options = DEFAULTS();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const eq = arg.indexOf('=');
    const head = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    const spec = BY_OPTION.get(head) ?? BY_ALIAS.get(head);
    if (spec) {
      if (spec.takesValue) {
        index = takeValue(spec, argv, index, options);
        if (options.error) return options;
        continue;
      }
      options[spec.key] = spec.value === undefined ? true : spec.value;
      options.used.add(spec.name);
      continue;
    }
    if (arg.startsWith('-')) {
      options.error = `unknown option ${arg}`;
      return options;
    }
    options.positionals.push(arg);
  }

  if (options.positionals.length > 0) {
    const [first, ...rest] = options.positionals;
    if (COMMANDS[first]) {
      options.command = first;
      options.helpTopic = rest[0] ?? null;
      options.positionals = rest;
    } else {
      options.error = `unknown command ${first}`;
      return options;
    }
  }

  // `rnap help <command>` prints that command's help, like `<command> --help`.
  if (options.command === 'help' && options.helpTopic) {
    if (!COMMANDS[options.helpTopic]) {
      options.error = `unknown command ${options.helpTopic}`;
      return options;
    }
    options.command = options.helpTopic;
    options.help = true;
    options.helpTopic = null;
    options.positionals = [];
  }

  const spec = COMMANDS[options.command];
  if (!spec) return options;

  for (const name of options.used) {
    if (!GLOBAL.includes(name) && !spec.flags.includes(name)) {
      options.error = `${FLAGS[name].option} is not an option of ${options.command}`;
      return options;
    }
  }
  if (spec.positionals === false && options.positionals.length > 0) {
    options.error = `unexpected argument ${options.positionals[0]}`;
    return options;
  }
  return options;
}

export { FLAGS };
