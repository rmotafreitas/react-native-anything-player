import test from 'node:test';
import assert from 'node:assert/strict';
import { bareGood, runCli } from './cli-fixtures.mjs';
import { COMMANDS, COMMAND_NAMES } from '../../bin/cli/usage.mjs';
import { parseArgs } from '../../bin/cli/args.mjs';
import { cliVersion } from '../../bin/cli/cli.mjs';

test('every command documents itself', () => {
  for (const name of COMMAND_NAMES) {
    assert.match(COMMANDS[name].summary, /\S/, `${name} has a summary`);
    assert.match(COMMANDS[name].help, new RegExp(`^Usage: rnap ${name}\\b`));
    assert.match(COMMANDS[name].help, /Exit codes:/);
  }
});

test('no arguments is bad usage; --help is not', () => {
  const empty = runCli([]);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /^Usage: rnap <command> \[options\]/);

  const help = runCli(['--help']);
  assert.equal(help.status, 0);
  assert.equal(help.stdout, runCli(['help']).stdout);
  assert.match(help.stdout, /rnap modules/);
  assert.match(help.stdout, /rnap migrate/);
  assert.match(help.stdout, /0 {2}no errors/);
});

test('rnap help <command> is <command> --help', (t) => {
  const root = bareGood(t);
  for (const name of COMMAND_NAMES.filter((item) => item !== 'help')) {
    const viaHelp = runCli(['help', name], { cwd: root });
    const viaFlag = runCli([name, '--help'], { cwd: root });
    assert.equal(viaHelp.status, 0);
    assert.equal(viaHelp.stdout, viaFlag.stdout);
    assert.equal(viaHelp.stdout, COMMANDS[name].help);
  }
  assert.equal(runCli(['help', 'help']).stdout, runCli(['--help']).stdout);
});

test('the version flag works alone and after a command', (t) => {
  const root = bareGood(t);
  const plain = runCli(['--version']);
  assert.equal(plain.status, 0);
  assert.equal(plain.stdout.trim(), cliVersion());
  assert.equal(runCli(['-v']).stdout, plain.stdout);
  assert.equal(runCli(['modules', '--version'], { cwd: root }).stdout, plain.stdout);
});

test('unknown commands and options exit 2', () => {
  const command = runCli(['nope']);
  assert.equal(command.status, 2);
  assert.match(command.stderr, /unknown command nope/);

  const option = runCli(['doctor', '--nope']);
  assert.equal(option.status, 2);
  assert.match(option.stderr, /unknown option --nope/);

  const notHere = runCli(['modules', '--yes']);
  assert.equal(notHere.status, 2);
  assert.match(notHere.stderr, /--yes is not an option of modules/);

  const value = runCli(['--cwd']);
  assert.equal(value.status, 2);
  assert.match(value.stderr, /--cwd needs a value/);

  const topic = runCli(['help', 'nope']);
  assert.equal(topic.status, 2);
  assert.match(topic.stderr, /unknown command nope/);
});

test('commands without positionals reject extra arguments', (t) => {
  const root = bareGood(t);
  const result = runCli(['modules', 'extra'], { cwd: root });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unexpected argument extra/);
});

test('a --cwd that is not a directory is bad usage', () => {
  const result = runCli(['doctor', '--cwd', '/nope/nowhere']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no such directory: \/nope\/nowhere/);
});

test('parseArgs keeps command positionals and repeats --url', () => {
  const options = parseArgs([
    'doctor',
    '--url',
    'https://a.test/live.mp3',
    '--url=https://b.test/live.mp3',
    '--json',
    '--package-urls',
  ]);
  assert.equal(options.error, null);
  assert.equal(options.command, 'doctor');
  assert.deepEqual(options.urls, [
    'https://a.test/live.mp3',
    'https://b.test/live.mp3',
  ]);
  assert.equal(options.json, true);
  assert.equal(options.packageUrls, true);

  const migrate = parseArgs(['migrate', 'src', '--from', 'expo-av']);
  assert.equal(migrate.command, 'migrate');
  assert.deepEqual(migrate.positionals, ['src']);
  assert.equal(migrate.from, 'expo-av');
});
