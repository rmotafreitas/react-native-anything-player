// Command line parsing. Kept separate from the commands so `--help` and usage
// errors work the same for doctor and init.

const COMMANDS = new Set(['doctor', 'init', 'help']);

export function parseArgs(argv) {
  const options = {
    command: null,
    cwd: process.cwd(),
    urls: [],
    json: false,
    yes: false,
    color: true,
    help: false,
    version: false,
    error: null,
  };

  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--no-color') options.color = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg === '--cwd' || arg === '--url') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        options.error = `${arg} needs a value`;
        break;
      }
      index += 1;
      if (arg === '--cwd') options.cwd = value;
      else options.urls.push(value);
    } else if (arg.startsWith('--cwd=')) {
      options.cwd = arg.slice('--cwd='.length);
    } else if (arg.startsWith('--url=')) {
      options.urls.push(arg.slice('--url='.length));
    } else if (arg.startsWith('-')) {
      options.error = `unknown option ${arg}`;
      break;
    } else {
      positional.push(arg);
    }
  }

  if (!options.error && positional.length > 1)
    options.error = `unexpected argument ${positional[1]}`;
  if (!options.error && positional.length === 1) {
    if (!COMMANDS.has(positional[0]))
      options.error = `unknown command ${positional[0]}`;
    else options.command = positional[0];
  }
  return options;
}

export const USAGE = `Usage: rnap <command> [options]

Commands
  doctor        report project setup problems (exit 1 when any is an error)
  init          apply the safe fixes, each as a diff

Options
  --cwd <dir>    project directory (default: current directory)
  --url <url>    stream URL to probe; repeatable
  --json         machine-readable output
  --yes, -y      init: apply every fix without asking
  --no-color     plain text (also honours NO_COLOR)
  --help, -h     this text
  --version, -v  the CLI version

Examples
  npx react-native-anything-player doctor
  npx react-native-anything-player init
  npx react-native-anything-player doctor --url https://radio.example/live.mp3 --json
`;
