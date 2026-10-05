import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';

// The site renders the repository's own docs/ — one source of truth, readable
// on GitHub and here. Pages outside docs/ (the conformance spec, the licence,
// benchmarks) stay on GitHub: links to them are rewritten to the repository.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
const REPO = (pkg.repository.url as string).replace(/^git\+/, '').replace(/\.git$/, '');

export default defineConfig({
  srcDir: '..',
  srcExclude: [
    '**/node_modules/**',
    '*.md',
    '.github/**',
    'android/**',
    'benchmarks/**',
    'conformance/**',
    'example/**',
    'example-expo/**',
    'ios/**',
    'lib/**',
    'scripts/**',
    'src/**',
    'docs/diagrams/**',
  ],
  rewrites: { 'website/index.md': 'index.md' },
  vite: {
    // srcDir is the repository root, whose public/ would be the default.
    publicDir: path.resolve(HERE, '../public'),
    // Pages in docs/ import Vue; the root workspace does not hoist it
    // (nmHoistingLimits: workspaces), so point them at this package's copy.
    resolve: {
      alias: [{ find: /^vue(\/.*)?$/, replacement: `${path.resolve(HERE, '../node_modules/vue')}$1` }],
    },
  },
  base: process.env.AIRWAVE_DOCS_BASE ?? '/',
  cleanUrls: true,
  lastUpdated: true,

  title: 'Airwave',
  titleTemplate: ':title · Airwave',
  description:
    'The React Native audio player that does not give up: files, streams and internet radio that survive dead sockets, network switches, calls and frozen JavaScript.',
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${process.env.AIRWAVE_DOCS_BASE ?? '/'}logo.svg` }],
    ['meta', { name: 'theme-color', content: '#ff6428' }],
    ['meta', { property: 'og:title', content: 'Airwave — the audio player that does not give up' }],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Native-first audio for React Native. Built by a radio app developer, for app developers.',
      },
    ],
  ],

  markdown: {
    config(md) {
      // `../conformance/README.md` from docs/x.md → the file on GitHub.
      md.core.ruler.after('inline', 'airwave-repo-links', (state) => {
        const from = path.posix.dirname((state.env as { relativePath?: string }).relativePath ?? '');
        const visit = (tokens: typeof state.tokens) => {
          for (const token of tokens) {
            if (token.children) visit(token.children);
            if (token.type !== 'link_open') continue;
            const href = token.attrGet('href');
            if (!href || /^[a-z]+:|^#|^\//i.test(href)) continue;
            const [file, hash] = href.split('#');
            const target = path.posix.normalize(path.posix.join(from, file));
            if (target.startsWith('docs/') && !target.startsWith('docs/diagrams/')) continue;
            token.attrSet('href', `${REPO}/blob/main/${target}${hash ? `#${hash}` : ''}`);
          }
        };
        visit(state.tokens);
      });
    },
  },

  themeConfig: {
    logo: '/logo.svg',
    nav: [
      { text: 'Docs', link: '/docs/getting-started', activeMatch: '^/docs/(?!comparison|roadmap)' },
      { text: 'Compare', link: '/docs/comparison' },
      { text: 'Roadmap', link: '/docs/roadmap' },
      { text: `v${pkg.version}`, items: [{ text: 'Changelog', link: `${REPO}/blob/main/CHANGELOG.md` }, { text: 'Licence', link: `${REPO}/blob/main/COMMERCIAL.md` }] },
    ],
    sidebar: [
      {
        text: 'Start here',
        items: [
          { text: 'Getting started', link: '/docs/getting-started' },
          { text: 'Comparison & benchmarks', link: '/docs/comparison' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Playback', link: '/docs/playback' },
          { text: 'Internet radio & ICY', link: '/docs/internet-radio' },
          { text: 'Background & system', link: '/docs/background-and-system' },
          { text: 'Visualizer', link: '/docs/visualizer' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'Status & events', link: '/docs/events' },
          { text: 'Errors', link: '/docs/errors' },
          { text: 'Configuration', link: '/docs/configuration' },
        ],
      },
      {
        text: 'Under the hood',
        items: [
          { text: 'Recovery policy', link: '/docs/recovery' },
          { text: 'Architecture', link: '/docs/architecture' },
          { text: 'Testing', link: '/docs/testing' },
          { text: 'Debugging & FAQ', link: '/docs/debugging' },
        ],
      },
      {
        text: 'Project',
        items: [{ text: 'Roadmap', link: '/docs/roadmap' }],
      },
    ],
    outline: { level: [2, 3] },
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: REPO }],
    editLink: { pattern: `${REPO}/edit/main/:path`, text: 'Edit this page on GitHub' },
    footer: {
      message: 'Source-available under PolyForm Noncommercial 1.0.0.',
      copyright: 'Built from years of Rádio Animu production failure reports.',
    },
  },
});
