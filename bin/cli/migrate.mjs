// `rnap migrate`: the mechanical part of a migration to RNAP, rewritten with a
// real parser (@babel/parser) so the file's formatting survives: every edit
// replaces an exact source range and nothing else is re-printed.
//
// What cannot be decided mechanically — creating the player, the queue, the
// events, the audio mode — is left alone and marked with a `rnap-migrate`
// comment that names the section of the guide.

import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { buildChange, reviewChanges } from './edits.mjs';
import { formatMigrateHeader } from './report.mjs';
import { readText, relative } from './util.mjs';

const SOURCES = {
  'track-player': {
    packages: ['react-native-track-player', '@rntp/player'],
    guide: 'docs/migrating-from-track-player.md',
  },
  'expo-audio': {
    packages: ['expo-audio'],
    guide: 'docs/migrating-from-expo-audio.md',
  },
  'expo-av': {
    packages: ['expo-av'],
    guide: 'docs/migrating-from-expo-av.md',
  },
};

export const MIGRATION_NAMES = Object.keys(SOURCES);

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.expo',
  '.yarn',
  'ios',
  'android',
  'build',
  'dist',
  'lib',
  'coverage',
  'Pods',
  'vendor',
]);

/* ------------------------------------------------------------------ parsing */

/** `node.parent` links: the parser gives none, and the passes need them. */
function attachParents(node, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  node.parent = parent;
  for (const key of Object.keys(node)) {
    if (key === 'parent' || SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value)
        if (child && typeof child.type === 'string') attachParents(child, node);
    } else if (value && typeof value.type === 'string') {
      attachParents(value, node);
    }
  }
}

function parseFile(code, file) {
  const typescript = /\.(ts|tsx)$/.test(file);
  const ast = parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    plugins: typescript ? ['jsx', 'typescript'] : ['jsx', 'flow'],
  });
  attachParents(ast);
  return ast;
}

/** The migration a file needs, from its imports (`null` when none). */
export function detectSource(code) {
  for (const [id, source] of Object.entries(SOURCES)) {
    for (const packageName of source.packages) {
      const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(
        `(?:from\\s*|require\\(\\s*)['"]${escaped}['"]`
      );
      if (pattern.test(code)) return id;
    }
  }
  return null;
}

/* -------------------------------------------------------------------- walks */

const SKIP_KEYS = new Set([
  'loc',
  'parent',
  'start',
  'end',
  'range',
  'extra',
  'comments',
  'tokens',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);

function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, ancestors) === false) return;
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value)
        if (child && typeof child.type === 'string')
          walk(child, visit, [...ancestors, node]);
    } else if (value && typeof value.type === 'string') {
      walk(value, visit, [...ancestors, node]);
    }
  }
}

const localName = (specifier) => specifier.local?.name ?? null;

function importedName(specifier) {
  if (specifier.type !== 'ImportSpecifier') return null;
  return specifier.imported?.name ?? specifier.imported?.value ?? null;
}

function isTypeSpecifier(node, specifier) {
  return node.importKind === 'type' || specifier.importKind === 'type';
}

/** Every Identifier bound to `name` outside the imports. */
function referencesTo(ast, name) {
  const found = [];
  walk(ast, (node, ancestors) => {
    if (node.type === 'ImportDeclaration') return false;
    if (node.type !== 'Identifier' || node.name !== name) return;
    const parent = ancestors.at(-1);
    found.push({
      node,
      parent,
      isMemberObject:
        parent?.type === 'MemberExpression' && parent.object === node,
    });
  });
  return found;
}

function memberUses(ast, name) {
  const uses = [];
  walk(ast, (node) => {
    if (node.type !== 'MemberExpression') return;
    if (node.object.type !== 'Identifier' || node.object.name !== name) return;
    if (node.property.type !== 'Identifier' || node.computed) return;
    uses.push({ node, property: node.property.name });
  });
  return uses;
}

function callUses(ast, name) {
  const calls = [];
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    if (node.callee.type === 'Identifier' && node.callee.name === name)
      calls.push(node);
  });
  return calls;
}

function findAncestor(ast, target, predicate) {
  let found = null;
  walk(ast, (node, ancestors) => {
    if (node !== target) return;
    found = [...ancestors].reverse().find(predicate) ?? null;
    return false;
  });
  return found;
}

/* ------------------------------------------------------------------ helpers */

function applyEdits(code, edits) {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let cursor = 0;
  let applied = 0;
  for (const edit of sorted) {
    if (edit.start < cursor) continue;
    out += code.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
    applied += 1;
  }
  return { code: out + code.slice(cursor), applied };
}

function argumentTexts(code, node) {
  return node.arguments.map((argument) => {
    if (argument.type === 'SpreadElement')
      return `...${code.slice(argument.argument.start, argument.argument.end)}`;
    return code.slice(argument.start, argument.end);
  });
}

function keepArguments(code, node, mode) {
  const args = argumentTexts(code, node);
  if (mode === 'none') return '';
  if (mode === 'first') return args.slice(0, 1).join(', ');
  return args.join(', ');
}

/** `2500` -> `2.5`, anything else -> `(expr) / 1000`. */
function secondsExpression(code, node) {
  const text = code.slice(node.start, node.end);
  const value = Number(text);
  if (text.trim() !== '' && Number.isFinite(value)) return String(value / 1000);
  return `${text} / 1000`;
}

/** The whole line holding a statement, when nothing else shares it. */
function removeStatement(code, statement) {
  const lineStart = code.lastIndexOf('\n', statement.start - 1) + 1;
  const indent = code.slice(lineStart, statement.start);
  const lineEnd = code.indexOf('\n', statement.end);
  const tail = code.slice(
    statement.end,
    lineEnd === -1 ? code.length : lineEnd
  );
  if (indent.trim() === '' && tail.trim() === '')
    return {
      start: lineStart,
      end: lineEnd === -1 ? code.length : lineEnd + 1,
      text: '',
    };
  return { start: statement.start, end: statement.end, text: '' };
}

function addNote(notes, anchor, text, guide) {
  const body = `${text} (${guide}${anchor})`;
  if (notes.some((note) => note.text === body)) return;
  notes.push({ text: body });
}

function playerName(ast) {
  const taken = new Set();
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier')
      taken.add(node.id.name);
    if (node.type === 'FunctionDeclaration' && node.id) taken.add(node.id.name);
    if (node.type === 'ImportSpecifier') taken.add(node.local.name);
    if (node.type === 'ImportDefaultSpecifier') taken.add(node.local.name);
  });
  if (!taken.has('player')) return 'player';
  if (!taken.has('rnapPlayer')) return 'rnapPlayer';
  return 'rnapPlayer2';
}

const isIdentifier = (node, name) =>
  node?.type === 'Identifier' && (name === undefined || node.name === name);

const isMemberOf = (node, objectName, propertyName) =>
  node?.type === 'MemberExpression' &&
  isIdentifier(node.object, objectName) &&
  (propertyName === undefined ||
    (!node.computed && node.property.name === propertyName));

/* ------------------------------------------------------------------- tables */

const COMMANDS = {
  play: { name: 'play' },
  pause: { name: 'pause' },
  stop: { name: 'stop' },
  seekTo: { name: 'seekTo' },
  setVolume: { name: 'setVolume' },
  setMuted: { name: 'setMuted' },
  setRate: { name: 'setRate' },
  reset: { name: 'reset' },
  getProgress: { name: 'getProgress' },
  destroy: { name: 'release' },
  updateNowPlayingMetadata: { name: 'updateNowPlaying' },
  updateMetadataForTrack: {
    name: 'updateNowPlaying',
    note: {
      anchor: '#lock-screen-remote-controls-and-capabilities',
      text: 'updateMetadataForTrack() became player.updateNowPlaying(): there is one source.',
    },
  },
  retry: {
    name: 'play',
    note: {
      anchor: '#the-recovery-code-you-can-delete',
      text: 'retry() became player.play(): RNAP retries by itself, so this is usually deletable.',
    },
  },
  add: {
    name: 'load',
    note: {
      anchor: '#the-queue-is-the-big-difference',
      text: 'TrackPlayer.add() became player.load(): RNAP plays one source. Add { autoplay: true } if it should start, and drop skip(0).',
    },
  },
  seekBy: {
    special: 'seekBy',
    note: {
      anchor: '#playback',
      text: 'seekBy(offset) became player.seekTo(player.getProgress().position + offset).',
    },
  },
  getVolume: {
    special: 'status.volume',
    note: { anchor: '#playback', text: 'getVolume() became player.status.volume.' },
  },
  getRate: {
    special: 'status.rate',
    note: { anchor: '#playback', text: 'getRate() became player.status.rate.' },
  },
  getState: {
    special: 'status',
    note: {
      anchor: '#events',
      text: 'getState()/getPlaybackState() became player.status.',
    },
  },
  getPlaybackState: { special: 'status' },
};

const UNMAPPED_COMMANDS = {
  setupPlayer: {
    anchor: '#install-and-setup',
    text: 'TrackPlayer.setupPlayer(): create one `new Player(options)` at module scope instead.',
  },
  updateOptions: {
    anchor: '#lock-screen-remote-controls-and-capabilities',
    text: 'TrackPlayer.updateOptions(): pass mediaSession.commands to the Player constructor.',
  },
  setCommands: {
    anchor: '#lock-screen-remote-controls-and-capabilities',
    text: 'TrackPlayer.setCommands(): pass mediaSession.commands to the Player constructor.',
  },
  registerPlaybackService: {
    anchor: '#install-and-setup',
    text: 'TrackPlayer.registerPlaybackService(): delete the service file and its registration.',
  },
  addEventListener: {
    anchor: '#events',
    text: 'TrackPlayer.addEventListener(): use player.on(...); delete the RemotePlay/Pause/Stop/Seek handlers (native now).',
  },
  skip: {
    anchor: '#the-queue-is-the-big-difference',
    text: 'TrackPlayer.skip(): load() the source you want; RNAP has no queue.',
  },
  skipToNext: {
    anchor: '#the-queue-is-the-big-difference',
    text: 'skipToNext(): load() the next item yourself, or wait for the native queue.',
  },
  skipToPrevious: {
    anchor: '#the-queue-is-the-big-difference',
    text: 'skipToPrevious(): load() the previous item yourself, or wait for the native queue.',
  },
  setQueue: {
    anchor: '#the-queue-is-the-big-difference',
    text: 'TrackPlayer.setQueue(): RNAP has no queue yet; use the interim pattern in the guide.',
  },
  getQueue: {
    anchor: '#the-queue-is-the-big-difference',
    text: 'TrackPlayer.getQueue(): RNAP has no queue; keep your own list.',
  },
  setPlayWhenReady: {
    anchor: '#playback',
    text: 'TrackPlayer.setPlayWhenReady(): use player.toggle() or player.play()/player.pause().',
  },
  setRepeatMode: {
    anchor: '#the-queue-is-the-big-difference',
    text: 'setRepeatMode(): repeat one with player.on("ended", () => player.play()); there is no queue to repeat.',
  },
};

const HOOKS = {
  useProgress: { name: 'useProgress' },
  usePlaybackState: { name: 'usePlaybackState', note: '#hooks' },
  useIsPlaying: {
    name: 'usePlayerStatus',
    note: {
      anchor: '#hooks',
      text: 'useIsPlaying() became usePlayerStatus(player): read status.playWhenReady, and status.state for the spinner.',
    },
  },
  usePlayWhenReady: {
    name: 'usePlayerStatus',
    note: {
      anchor: '#hooks',
      text: 'usePlayWhenReady() became usePlayerStatus(player).playWhenReady.',
    },
  },
  useActiveTrack: {
    name: 'useStreamMetadata',
    note: {
      anchor: '#hooks',
      text: 'useActiveTrack() became useStreamMetadata(player) for the ICY title; keep other track fields in your own state.',
    },
  },
};

const HOOK_NOTES = {
  useProgress: {
    anchor: '#hooks',
    text: 'useProgress(player, ms) now takes the player first.',
  },
  usePlaybackState: {
    anchor: '#hooks',
    text: 'usePlaybackState(player) now takes the player and returns a PlaybackState, never undefined.',
  },
};

const STATES = {
  None: 'idle',
  Loading: 'loading',
  Buffering: 'buffering',
  Ready: 'paused',
  Playing: 'playing',
  Paused: 'paused',
  Stopped: 'stopped',
  Ended: 'ended',
  Error: 'error',
};

const EXPO_AUDIO_COMMANDS = {
  replace: { name: 'load', args: 'all' },
  remove: { name: 'release', args: 'none' },
  seekTo: { name: 'seekTo', args: 'first' },
  setPlaybackRate: { name: 'setRate', args: 'first' },
};

const EXPO_AV_COMMANDS = {
  playAsync: { name: 'play', args: 'none' },
  pauseAsync: { name: 'pause', args: 'none' },
  stopAsync: { name: 'stop', args: 'none' },
  unloadAsync: { name: 'reset', args: 'none' },
  setVolumeAsync: { name: 'setVolume', args: 'first' },
  setRateAsync: { name: 'setRate', args: 'first' },
  setPositionAsync: { name: 'seekTo', args: 'first', seconds: true },
  setOnPlaybackStatusUpdate: { name: 'on', args: 'first', event: 'status' },
  setOnMetadataUpdate: { name: 'on', args: 'first', event: 'metadata' },
};

const EXPO_AV_UNMAPPED = {
  getStatusAsync: {
    anchor: '#status-and-events',
    text: 'getStatusAsync() became player.status (synchronous).',
  },
  replayAsync: {
    anchor: '#api-mapping',
    text: 'replayAsync() became player.seekTo(0) then player.play().',
  },
  setIsLoopingAsync: {
    anchor: '#api-mapping',
    text: 'setIsLoopingAsync(): RNAP has no loop; use player.on("ended", () => player.play()).',
  },
  setProgressUpdateIntervalAsync: {
    anchor: '#status-and-events',
    text: 'setProgressUpdateIntervalAsync(): use useProgress(player, ms) or the progressInterval option.',
  },
  setOnAudioSampleReceived: {
    anchor: '#status-and-events',
    text: 'setOnAudioSampleReceived(): use player.setAudioSampling({ enabled: true }) and the audioSample event.',
  },
};

/* ------------------------------------------------------- import declaration */

function sourceImports(ast, packages) {
  const found = [];
  walk(ast, (node) => {
    if (node.type !== 'ImportDeclaration') return;
    if (packages.includes(node.source.value)) found.push(node);
  });
  return found;
}

/**
 * Rewrites the imports from the old package: the specifiers in `keep` stay,
 * the names in `values`/`types` move to the RNAP import, and an import with
 * nothing left is removed.
 */
function rewriteImports({
  code,
  ast,
  edits,
  packages,
  keep,
  values,
  types,
  needsPlayer,
  player,
  guide,
  notes,
}) {
  const replacements = new Map();
  for (const node of sourceImports(ast, packages)) {
    // A side-effect import (`import 'expo-av'`) has nothing to rewrite.
    if (node.specifiers.length === 0) continue;
    const remaining = [];
    let defaultLocal = null;
    let namespaceLocal = null;
    let typeOnly = true;
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportDefaultSpecifier') {
        if (keep.has(specifier)) defaultLocal = specifier.local.name;
        continue;
      }
      if (specifier.type === 'ImportNamespaceSpecifier') {
        if (keep.has(specifier)) namespaceLocal = specifier.local.name;
        continue;
      }
      if (!keep.has(specifier)) continue;
      remaining.push(specifier);
      if (!isTypeSpecifier(node, specifier)) typeOnly = false;
    }
    const named = remaining
      .map((specifier) => {
        const imported = importedName(specifier);
        return imported === specifier.local.name
          ? imported
          : `${imported} as ${specifier.local.name}`;
      })
      .join(', ');

    const parts = [];
    if (defaultLocal && named)
      parts.push(
        `import ${defaultLocal}, { ${named} } from '${node.source.value}';`
      );
    else if (defaultLocal)
      parts.push(`import ${defaultLocal} from '${node.source.value}';`);
    else if (named)
      parts.push(
        `${typeOnly ? 'import type' : 'import'} { ${named} } from '${node.source.value}';`
      );
    if (namespaceLocal)
      parts.push(`import * as ${namespaceLocal} from '${node.source.value}';`);
    const text = parts.join('\n');

    if (text !== code.slice(node.start, node.end)) replacements.set(node, text);
  }

  const lines = [];
  if (values.length > 0)
    lines.push(
      `import { ${[...new Set(values)].join(', ')} } from 'react-native-anything-player';`
    );
  if (types.length > 0)
    lines.push(
      `import type { ${[...new Set(types)].join(', ')} } from 'react-native-anything-player';`
    );
  if (needsPlayer && player) {
    const imported = sourceImports(ast, ['react-native-anything-player']);
    const already = imported.some((node) =>
      node.specifiers.some(
        (specifier) =>
          localName(specifier) === player &&
          specifier.type === 'ImportSpecifier' &&
          importedName(specifier) === 'Player'
      )
    );
    if (!already) {
      lines.push(`import { ${player} } from './player';`);
      addNote(
        notes,
        '#install-and-setup',
        `The added \`import { ${player} } from './player'\` must point at the module that creates \`new Player()\`.`,
        guide
      );
    }
  }

  if (lines.length > 0) {
    const lastImport = [...ast.program.body]
      .filter((node) => node.type === 'ImportDeclaration')
      .at(-1);
    if (lastImport) {
      // The new imports ride on the last one: replacing it keeps the file's
      // own line breaks, where a separate insertion leaves a blank line.
      const existing = replacements.has(lastImport)
        ? replacements.get(lastImport)
        : code.slice(lastImport.start, lastImport.end);
      replacements.set(
        lastImport,
        existing === '' ? lines.join('\n') : `${existing}\n${lines.join('\n')}`
      );
    } else edits.push({ start: 0, end: 0, text: `${lines.join('\n')}\n` });
  }

  for (const [node, text] of replacements)
    edits.push({ start: node.start, end: node.end, text });
}

/* ------------------------------------------------------------- track player */

function trackPlayerPass(code, ast, { notes, guide }) {
  const packages = SOURCES['track-player'].packages;
  const edits = [];
  const keep = new Set();
  const values = [];
  const player = playerName(ast);

  const imported = { defaultLocal: null, named: [] };
  for (const node of sourceImports(ast, packages)) {
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportDefaultSpecifier')
        imported.defaultLocal = specifier.local.name;
      else if (specifier.type === 'ImportSpecifier')
        imported.named.push({
          specifier,
          local: specifier.local.name,
          name: importedName(specifier),
        });
    }
  }

  // TrackPlayer itself: the default import.
  const tp = imported.defaultLocal;
  let migrateCommands = false;
  let usesPlayer = false;
  if (tp) {
    const commandUses = [];
    walk(ast, (node) => {
      if (node.type !== 'MemberExpression') return;
      if (!isIdentifier(node.object, tp)) return;
      if (node.property.type !== 'Identifier' || node.computed) return;
      commandUses.push(node);
    });
    const bare = referencesTo(ast, tp).filter((use) => !use.isMemberObject);
    const unmapped = commandUses.filter(
      (node) => !COMMANDS[node.property.name]
    );
    migrateCommands = unmapped.length === 0 && bare.length === 0;

    if (migrateCommands) {
      if (commandUses.length > 0) usesPlayer = true;
      for (const node of commandUses) {
        const command = COMMANDS[node.property.name];
        const call = node.parent?.type === 'CallExpression' ? node.parent : null;
        const range = command.special ? (call ?? node) : node;
        let text;
        if (command.special === 'seekBy') {
          const offset = call ? keepArguments(code, call, 'all') : 'offset';
          text = `${player}.seekTo(${player}.getProgress().position + ${offset})`;
        } else if (command.special) {
          text = `${player}.${command.special}`;
        } else {
          text = `${player}.${command.name}`;
        }
        edits.push({ start: range.start, end: range.end, text });
        if (command.note)
          addNote(notes, command.note.anchor, command.note.text, guide);
      }
    } else {
      keep.add(
        sourceImports(ast, packages)
          .flatMap((node) => node.specifiers)
          .find(
            (specifier) =>
              specifier.type === 'ImportDefaultSpecifier' &&
              specifier.local.name === tp
          )
      );
      for (const node of unmapped) {
        const note = UNMAPPED_COMMANDS[node.property.name];
        addNote(
          notes,
          note?.anchor ?? '#api-mapping',
          note?.text ??
            `TrackPlayer.${node.property.name}() has no equivalent in this codemod: see the API mapping.`,
          guide
        );
      }
      if (bare.length > 0)
        addNote(
          notes,
          '#api-mapping',
          `TrackPlayer is used as a value: RNAP has no such singleton, commands live on the player object.`,
          guide
        );
    }
  }

  // Named imports: hooks and State.
  for (const binding of imported.named) {
    const { specifier, local, name } = binding;
    if (name === 'State') {
      const uses = memberUses(ast, local);
      const mappable =
        uses.length > 0 &&
        uses.every((use) => STATES[use.property] !== undefined) &&
        referencesTo(ast, local).every((use) => use.isMemberObject);
      if (mappable) {
        for (const use of uses)
          edits.push({
            start: use.node.start,
            end: use.node.end,
            text: `'${STATES[use.property]}'`,
          });
        continue;
      }
      keep.add(specifier);
      addNote(
        notes,
        '#events',
        'State.* has no RNAP equivalent here: use status.state and the state names in the guide.',
        guide
      );
      continue;
    }

    const hook = HOOKS[name];
    if (!hook) {
      keep.add(specifier);
      addNote(
        notes,
        '#api-mapping',
        `\`${name}\` is not part of RNAP: keep what you still use, or delete it.`,
        guide
      );
      continue;
    }

    const calls = callUses(ast, local);
    const bare = referencesTo(ast, local).filter(
      (use) =>
        !(
          use.parent?.type === 'CallExpression' && use.parent.callee === use.node
        )
    );
    if (calls.length === 0 || bare.length > 0) {
      keep.add(specifier);
      continue;
    }
    for (const call of calls) {
      edits.push({
        start: call.start,
        end: call.end,
        text: `${hook.name}(${[player, ...argumentTexts(code, call)].join(', ')})`,
      });
      usesPlayer = true;
    }
    values.push(hook.name);
    const note = HOOK_NOTES[name] ?? hook.note;
    if (note)
      addNote(
        notes,
        typeof note === 'string' ? note : note.anchor,
        typeof note === 'string'
          ? `${name}() now takes the player first.`
          : note.text,
        guide
      );
  }

  rewriteImports({
    code,
    ast,
    edits,
    packages,
    keep,
    values,
    types: [],
    needsPlayer: usesPlayer,
    player,
    guide,
    notes,
  });

  return edits;
}

/* ---------------------------------------------------------------- expo-audio */

function expoAudioPass(code, ast, { notes, guide }) {
  const packages = SOURCES['expo-audio'].packages;
  const edits = [];
  const keep = new Set();
  const values = [];
  const types = [];

  const bindings = [];
  for (const node of sourceImports(ast, packages)) {
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      bindings.push({
        specifier,
        local: specifier.local.name,
        name: importedName(specifier),
        typeOnly: isTypeSpecifier(node, specifier),
      });
    }
  }

  const hookCalls = callUses(ast, 'useAudioPlayer');
  const creators = [];
  walk(ast, (node) => {
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier')
      return;
    if (!isIdentifier(node.init?.callee, 'createAudioPlayer')) return;
    creators.push(node);
  });

  const migrate = hookCalls.length === 0 && creators.length > 0;
  if (!migrate) {
    for (const binding of bindings) keep.add(binding.specifier);
    if (hookCalls.length > 0)
      addNote(
        notes,
        '#the-mental-model-changes',
        'useAudioPlayer() creates a player tied to a component: create one `new Player()` at module scope and keep playing across screens.',
        guide
      );
    for (const node of creators)
      addNote(
        notes,
        '#the-mental-model-changes',
        'createAudioPlayer() has no direct RNAP equivalent in this file: create one module-scope player and load() the source.',
        guide
      );
    rewriteImports({
      code,
      ast,
      edits,
      packages,
      keep,
      values,
      types,
      needsPlayer: false,
      player: null,
      guide,
      notes,
    });
    return edits;
  }

  const players = new Set();
  for (const node of creators) {
    const declaration = findAncestor(
      ast,
      node,
      (candidate) => candidate.type === 'VariableDeclaration'
    );
    players.add(node.id.name);
    if (!declaration || declaration.declarations.length !== 1) {
      addNote(
        notes,
        '#the-mental-model-changes',
        'createAudioPlayer() in a multi-variable declaration: create one module-scope player and load() the source.',
        guide
      );
      continue;
    }
    const [source] = argumentTexts(code, node.init);
    const load = source ? `\n${node.id.name}.load(${source});` : '';
    edits.push({
      start: declaration.start,
      end: declaration.end,
      text: `const ${node.id.name} = new Player();${load}`,
    });
    addNote(
      notes,
      '#the-mental-model-changes',
      'createAudioPlayer() became `new Player()` plus `player.load(source)`; set the constructor options from docs/configuration.md.',
      guide
    );
  }
  if (players.size > 0) values.push('Player');

  walk(ast, (node) => {
    if (node.type === 'AssignmentExpression') {
      const left = node.left;
      if (
        left.type !== 'MemberExpression' ||
        !isIdentifier(left.object) ||
        !players.has(left.object.name) ||
        left.property.type !== 'Identifier'
      )
        return;
      const value = code.slice(node.right.start, node.right.end);
      if (left.property.name === 'volume')
        edits.push({
          start: node.start,
          end: node.end,
          text: `${left.object.name}.setVolume(${value})`,
        });
      else if (left.property.name === 'muted')
        edits.push({
          start: node.start,
          end: node.end,
          text: `${left.object.name}.setMuted(${value})`,
        });
      else if (left.property.name === 'loop')
        addNote(
          notes,
          '#api-mapping',
          'player.loop has no RNAP equivalent: use player.on("ended", () => player.play()).',
          guide
        );
      return;
    }
    if (node.type !== 'CallExpression') return;
    if (node.callee.type !== 'MemberExpression') return;
    const receiver = node.callee.object;
    if (!isIdentifier(receiver) || !players.has(receiver.name)) return;
    if (node.callee.property.type !== 'Identifier') return;
    const command = EXPO_AUDIO_COMMANDS[node.callee.property.name];
    if (!command) return;
    edits.push({
      start: node.start,
      end: node.end,
      text: `${receiver.name}.${command.name}(${keepArguments(code, node, command.args)})`,
    });
  });

  for (const binding of bindings) {
    if (migrate && binding.name === 'createAudioPlayer') continue;
    const renamed =
      binding.name === 'useAudioPlayerStatus'
        ? 'usePlayerStatus'
        : binding.name === 'AudioStatus'
          ? 'PlayerStatus'
          : binding.name === 'AudioSource'
            ? 'SourceInput'
            : null;
    if (!renamed) {
      keep.add(binding.specifier);
      addNote(
        notes,
        '#what-differs-or-is-missing',
        `\`${binding.name}\` stays in expo-audio: RNAP has no equivalent (recording, playlists, preloading).`,
        guide
      );
      continue;
    }
    if (
      binding.typeOnly ||
      binding.name === 'AudioStatus' ||
      binding.name === 'AudioSource'
    )
      types.push(renamed);
    else values.push(renamed);
    for (const use of referencesTo(ast, binding.local)) {
      edits.push({ start: use.node.start, end: use.node.end, text: renamed });
    }
    if (binding.name === 'useAudioPlayerStatus')
      addNote(
        notes,
        '#status-and-events',
        'useAudioPlayerStatus() became usePlayerStatus(player).',
        guide
      );
  }

  rewriteImports({
    code,
    ast,
    edits,
    packages,
    keep,
    values,
    types,
    needsPlayer: false,
    player: null,
    guide,
    notes,
  });

  return edits;
}

/* ------------------------------------------------------------------ expo-av */

function avLoadOptions(code, status) {
  if (!status || status.type !== 'ObjectExpression') return null;
  const parts = [];
  for (const property of status.properties) {
    if (property.type !== 'ObjectProperty') continue;
    const key =
      property.key.type === 'Identifier' ? property.key.name : property.key.value;
    const value = code.slice(property.value.start, property.value.end);
    if (key === 'shouldPlay' && value === 'true') parts.push('autoplay: true');
    if (key === 'positionMillis')
      parts.push(`startPosition: ${secondsExpression(code, property.value)}`);
  }
  return parts.length > 0 ? `{ ${parts.join(', ')} }` : null;
}

function expoAvPass(code, ast, { notes, guide }) {
  const packages = SOURCES['expo-av'].packages;
  const edits = [];
  const keep = new Set();
  const player = playerName(ast);

  const bindings = [];
  const others = [];
  for (const node of sourceImports(ast, packages)) {
    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier') {
        // Default and namespace imports stay as they are.
        others.push({ specifier, name: specifier.local.name });
        continue;
      }
      if (importedName(specifier) === 'Audio') {
        bindings.push({ specifier, local: specifier.local.name });
      } else {
        others.push({ specifier, name: importedName(specifier) });
      }
    }
  }
  if (bindings.length === 0) return edits;
  if (bindings.length > 1) {
    addNote(
      notes,
      '#api-mapping',
      'The file binds `Audio` more than once: rewrite the expo-av calls by hand.',
      guide
    );
    return edits;
  }
  const audio = bindings[0].local;

  // Classify every use of Audio: only a fully mechanical file is rewritten.
  const creates = [];
  const modeCalls = [];
  let blocking = false;
  walk(ast, (node) => {
    if (!isIdentifier(node.object, audio)) return;
    if (node.property.type !== 'Identifier') return;
    if (node.property.name === 'setAudioModeAsync') {
      modeCalls.push(node);
      return;
    }
    if (node.property.name !== 'Sound') return;
    const parent = node.parent;
    const isCreate =
      parent?.type === 'MemberExpression' &&
      parent.property.name === 'createAsync' &&
      parent.object === node;
    const isNew = parent?.type === 'NewExpression' && parent.callee === node;
    if (isCreate) {
      // `creates` holds the call, not the `Audio.Sound.createAsync` property.
      if (parent.parent?.type === 'CallExpression') creates.push(parent.parent);
      else blocking = true;
      return;
    }
    if (isNew) {
      blocking = true;
      addNote(
        notes,
        '#api-mapping',
        'new Audio.Sound() became one module-scope player: player.load(source).',
        guide
      );
      return;
    }
    blocking = true;
  });

  // Every createAsync must be `const { sound } = await Audio.Sound.createAsync(…)`.
  const sounds = new Set();
  for (const call of creates) {
    const awaitNode = call.parent;
    const declarator = awaitNode?.parent;
    const simple =
      awaitNode?.type === 'AwaitExpression' &&
      declarator?.type === 'VariableDeclarator' &&
      declarator.id.type === 'ObjectPattern' &&
      declarator.id.properties.length === 1 &&
      declarator.init === awaitNode;
    if (!simple) {
      blocking = true;
      addNote(
        notes,
        '#api-mapping',
        'Audio.Sound.createAsync() outside `const { sound } = await …`: with RNAP there is one player, so rewrite this by hand.',
        guide
      );
      continue;
    }
    const declaration = findAncestor(
      ast,
      declarator,
      (candidate) => candidate.type === 'VariableDeclaration'
    );
    if (!declaration || declaration.declarations.length !== 1) {
      blocking = true;
      continue;
    }
    const property = declarator.id.properties[0];
    const soundName =
      property.value?.type === 'Identifier'
        ? property.value.name
        : property.key?.name;
    if (!soundName) {
      blocking = true;
      continue;
    }
    sounds.add(soundName);
    const source = argumentTexts(code, call)[0] ?? 'source';
    const options = avLoadOptions(code, call.arguments[1]);
    edits.push({
      start: declaration.start,
      end: declaration.end,
      text: `await ${player}.load(${source}${options ? `, ${options}` : ''});`,
    });
    addNote(
      notes,
      '#the-mental-model-changes',
      'Audio.Sound.createAsync() became one module-scope player and `await player.load(source)`; drop the sound state from your component.',
      guide,
    );
  }

  for (const node of modeCalls) {
    const statement = findAncestor(
      ast,
      node,
      (candidate) => candidate.type === 'ExpressionStatement'
    );
    if (statement) {
      const expression = statement.expression;
      const target =
        expression.type === 'AwaitExpression' ? expression.argument : expression;
      if (target === node.parent) edits.push(removeStatement(code, statement));
    }
    addNote(
      notes,
      '#audio-mode',
      'Audio.setAudioModeAsync() is not needed: the constructor options cover it (docs/configuration.md).',
      guide
    );
  }

  if (blocking) {
    // Nothing is rewritten: the file stays as it is, and the notes say why.
    return [];
  }

  for (const item of others) {
    keep.add(item.specifier);
    addNote(
      notes,
      '#what-differs-or-is-missing',
      `\`${item.name}\` stays in expo-av: RNAP has no equivalent.`,
      guide
    );
  }

  // sound.playAsync() -> player.play(), and so on.
  walk(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee;
    if (callee.type !== 'MemberExpression') return;
    if (!isIdentifier(callee.object) || !sounds.has(callee.object.name)) return;
    if (callee.property.type !== 'Identifier') return;
    const command = EXPO_AV_COMMANDS[callee.property.name];
    if (!command) {
      const note = EXPO_AV_UNMAPPED[callee.property.name];
      if (note) addNote(notes, note.anchor, note.text, guide);
      return;
    }
    let text;
    if (command.event)
      text = `${player}.on('${command.event}', ${keepArguments(code, node, command.args)})`;
    else if (command.seconds) {
      const first = node.arguments[0];
      if (!first) return;
      text = `${player}.${command.name}(${secondsExpression(code, first)})`;
    } else {
      text = `${player}.${command.name}(${keepArguments(code, node, command.args)})`;
    }
    edits.push({ start: node.start, end: node.end, text });
  });

  for (const sound of sounds) {
    const remaining = referencesTo(ast, sound).filter(
      (use) =>
        !(
          use.parent?.type === 'MemberExpression' &&
          use.parent.object === use.node
        ) &&
        !(
          use.parent?.type === 'ObjectProperty' &&
          (use.parent.value === use.node || use.parent.key === use.node)
        )
    );
    if (remaining.length > 0)
      addNote(
        notes,
        '#the-mental-model-changes',
        `\`${sound}\` is gone: point its other uses at the player.`,
        guide
      );
  }

  rewriteImports({
    code,
    ast,
    edits,
    packages,
    keep,
    values: [],
    types: [],
    needsPlayer: sounds.size > 0,
    player,
    guide,
    notes,
  });

  return edits;
}

/* -------------------------------------------------------------- single file */

const PASSES = {
  'track-player': trackPlayerPass,
  'expo-audio': expoAudioPass,
  'expo-av': expoAvPass,
};

function insertNotes(code, notes, guide) {
  if (notes.length === 0) return code;
  const headerLine = `// rnap-migrate: what still needs a human, from ${guide}`;
  const lines = code.split('\n');
  const merged = [];
  let header = headerLine;
  let start = 0;
  if (lines[0].startsWith('// rnap-migrate: what still needs a human, from ')) {
    header = lines[0];
    let index = 1;
    while (index < lines.length && lines[index].startsWith('//  - ')) {
      merged.push(lines[index]);
      index += 1;
    }
    if (index < lines.length && lines[index].trim() === '') index += 1;
    start = index;
  }
  for (const note of notes) {
    const line = `//  - ${note.text}`;
    if (!merged.includes(line)) merged.push(line);
  }
  const block = [header, ...merged, ''];
  return `${block.join('\n')}\n${lines.slice(start).join('\n')}`;
}

/**
 * Migrates one file's text. Returns `null` when nothing changed, including when
 * the file does not import the chosen (or any known) source library.
 */
export function migrateCode(code, { file = 'index.tsx', from = null } = {}) {
  const sourceId = from ?? detectSource(code);
  if (!sourceId || !SOURCES[sourceId]) return null;
  const guide = SOURCES[sourceId].guide;
  const notes = [];
  let current = code;
  let changes = 0;

  for (let pass = 0; pass < 6; pass += 1) {
    const ast = parseFile(current, file);
    const before = current;
    const applied = applyEdits(
      current,
      PASSES[sourceId](current, ast, { notes, guide })
    );
    current = applied.code;
    changes += applied.applied;
    if (current === before) break;
  }

  const migrated = insertNotes(current, notes, guide);
  if (migrated === code) return null;
  return { source: sourceId, code: migrated, changes, notes, guide };
}

/* ----------------------------------------------------------------- command */

function collectFiles(cwd, targets) {
  const files = [];
  const visit = (target) => {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      return;
    }
    if (stat.isFile()) {
      if (SOURCE_EXTENSIONS.includes(path.extname(target))) files.push(target);
      return;
    }
    if (!stat.isDirectory()) return;
    let entries;
    try {
      entries = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.') continue;
        visit(path.join(target, entry.name));
      } else if (SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
        files.push(path.join(target, entry.name));
      }
    }
  };
  for (const target of targets) visit(path.resolve(cwd, target));
  return files;
}

export async function runMigrate({
  cwd,
  paths = [],
  from = null,
  json,
  yes,
  dryRun,
  version,
  paint,
  stdout = process.stdout,
  stdin = process.stdin,
}) {
  if (from && !SOURCES[from]) {
    stdout.write(
      `rnap: unknown migration \`--from ${from}\`. Use one of: ${MIGRATION_NAMES.join(', ')}.\n`
    );
    return 2;
  }
  const targets = paths.length > 0 ? paths : ['.'];
  for (const target of targets) {
    const absolute = path.resolve(cwd, target);
    if (!fs.existsSync(absolute)) {
      stdout.write(`rnap: no such path: ${target}\n`);
      return 2;
    }
    const relativePath = path.relative(cwd, absolute);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      stdout.write(`rnap: outside the project: ${target}\n`);
      return 2;
    }
  }

  const files = [...new Set(collectFiles(cwd, targets))];
  const changes = [];
  const unparsed = [];
  const results = [];

  for (const file of files) {
    const before = readText(file);
    if (before === null) continue;
    let result;
    try {
      result = migrateCode(before, { file, from });
    } catch (error) {
      unparsed.push({
        file: relative(cwd, file),
        reason: `could not parse: ${error.message}`,
      });
      continue;
    }
    if (!result) continue;
    const change = buildChange({
      cwd,
      file: relative(cwd, file),
      before,
      after: result.code,
      change: `rewrite ${result.source} calls (${result.changes} edit${result.changes === 1 ? '' : 's'})`,
      id: result.source,
    });
    changes.push(change);
    results.push({
      file: change.file,
      source: result.source,
      notes: result.notes,
    });
  }

  const effectiveDryRun = Boolean(dryRun || (json && !yes));
  if (!json) stdout.write(formatMigrateHeader({ cwd, version, paint }));
  const { applied, skipped: refused } = await reviewChanges({
    changes,
    yes: Boolean(yes) && !dryRun,
    dryRun: effectiveDryRun,
    quiet: Boolean(json),
    paint,
    stdout,
    stdin,
  });

  const report = {
    schemaVersion: 1,
    command: 'migrate',
    cwd,
    from: from ?? 'auto',
    dryRun: effectiveDryRun,
    files: results.map((result) => ({
      file: result.file,
      source: result.source,
      notes: result.notes.map((note) => note.text),
    })),
    applied: applied.map((change) => change.file),
    skipped: refused.map((change) => ({
      file: change.file,
      reason: 'not applied',
    })),
    unparsed,
  };

  if (json) {
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return unparsed.length > 0 ? 1 : 0;
  }

  if (changes.length === 0) {
    stdout.write(
      unparsed.length > 0
        ? '\nNothing rewritten: the files that need it could not be parsed.\n'
        : '\nNothing to rewrite: no file imports Track Player, expo-audio or expo-av.\n'
    );
  } else if (effectiveDryRun) {
    stdout.write(
      `\nDry run: ${changes.length} file${changes.length === 1 ? '' : 's'} would change, nothing written.\n`
    );
  } else {
    stdout.write(
      `\n${applied.length} of ${changes.length} file${changes.length === 1 ? '' : 's'} rewritten.\n`
    );
  }
  if (unparsed.length > 0) {
    stdout.write('\nCould not parse\n');
    for (const item of unparsed)
      stdout.write(`  ${item.file}: ${item.reason}\n`);
  }
  stdout.write(
    '\nNext: follow the guide for the parts marked `// rnap-migrate:`, then remove the old package and rebuild.\n'
  );
  return unparsed.length > 0 ? 1 : 0;
}
