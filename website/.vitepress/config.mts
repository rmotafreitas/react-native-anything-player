import fs from 'node:fs';
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
const BASE = process.env.RNAP_DOCS_BASE ?? '/';
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
  base: BASE,
  cleanUrls: true,
  lastUpdated: true,

  title: 'RNAP',
  titleTemplate: ':title · RNAP',
  description:
    'The React Native audio player that does not give up: files, streams and internet radio that survive dead sockets, network switches, calls and frozen JavaScript.',
  head: [
    // Favicons stay PNG: Safari does not accept WebP icons.
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${BASE}favicon-32.png` }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '192x192', href: `${BASE}icon-192.png` }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: `${BASE}apple-touch-icon.png` }],
    ['meta', { property: 'og:image', content: `${BASE}icon-512.webp` }],
    ['meta', { name: 'theme-color', content: '#ff6428' }],
    ['meta', { property: 'og:title', content: 'React Native Anything Player (RNAP)' }],
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
      // A paragraph that is only a chart or diagram image becomes the native
      // component on the site (HTML bars, an HTML table, an inline themable
      // SVG). GitHub keeps rendering the image itself.
      md.core.ruler.after('inline', 'rnap-native-figures', (state) => {
        const t = state.tokens;
        for (let i = 0; i + 2 < t.length; i++) {
          if (t[i].type !== 'paragraph_open' || t[i + 1].type !== 'inline' || t[i + 2].type !== 'paragraph_close') continue;
          const kids = (t[i + 1].children ?? []).filter((c) => !(c.type === 'text' && c.content.trim() === ''));
          if (kids.length !== 1 || kids[0].type !== 'image') continue;
          const m = /assets\/(charts|diagrams)\/([\w-]+)\.svg$/.exec(kids[0].attrGet('src') ?? '');
          if (!m) continue;
          const alt = kids[0].content.replace(/"/g, '&quot;');
          const tag =
            m[1] === 'diagrams' ? 'Diagram' : m[2] === 'capabilities' ? 'CapabilityMatrix' : 'BarChart';
          const block = new state.Token('html_block', '', 0);
          block.content = `<${tag} name="${m[2]}" alt="${alt}" />\n`;
          t.splice(i, 3, block);
        }
      });
      // ```sh with a single `npm install <pkg>` → npm / yarn / pnpm / bun tabs.
      const fence = md.renderer.rules.fence!;
      md.renderer.rules.fence = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const m = /^npm install (\S+)\s*$/.exec(token.content);
        if (token.info.trim() === 'sh' && m) return `<InstallTabs pkg="${m[1]}" />\n`;
        return fence(tokens, idx, options, env, self);
      };

      // `../conformance/README.md` from docs/x.md → the file on GitHub.
      md.core.ruler.after('inline', 'rnap-repo-links', (state) => {
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

  // Plain Markdown next to every docs page (for "Copy page" and AI tools),
  // plus llms.txt / llms-full.txt indexes, as the Expo and Elysia docs publish.
  buildEnd(site) {
    const pages = site.pages.filter((p) => p.startsWith('docs/')).sort();
    const sections: string[] = [];
    const index: string[] = [
      `# React Native Anything Player (RNAP)`,
      '',
      `> ${pkg.description}`,
      '',
      '## Docs',
      '',
    ];
    for (const page of pages) {
      const source = fs.readFileSync(path.join(site.srcDir, page), 'utf8');
      fs.mkdirSync(path.dirname(path.join(site.outDir, page)), { recursive: true });
      fs.writeFileSync(path.join(site.outDir, page), source);
      const title = /^#\s+(.+)$/m.exec(source)?.[1] ?? page;
      index.push(`- [${title}](${BASE}${page})`);
      sections.push(source.trim());
    }
    fs.writeFileSync(path.join(site.outDir, 'llms.txt'), index.join('\n') + '\n');
    fs.writeFileSync(path.join(site.outDir, 'llms-full.txt'), sections.join('\n\n---\n\n') + '\n');
  },

  themeConfig: {
    logo: { src: '/logo.webp', alt: 'RNAP' },
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
          { text: 'Why RNAP', link: '/docs/why' },
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
      copyright: 'Copyright © 2026 Ricardo Freitas',
    },
  },
});
