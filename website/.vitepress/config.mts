import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type HeadConfig } from 'vitepress';
import { HOME, PAGES, SECTIONS } from './pages.mts';

// The site renders the repository's own docs/ — one source of truth, readable
// on GitHub and here. Pages outside docs/ (the conformance spec, the licence,
// benchmarks) stay on GitHub: links to them are rewritten to the repository.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
const BASE = process.env.RNAP_DOCS_BASE ?? '/';
const REPO = (pkg.repository.url as string).replace(/^git\+/, '').replace(/\.git$/, '');

// Absolute origin for canonical links, the sitemap and link-preview images,
// which crawlers and chat apps only accept as full URLs. Vercel exposes the
// production domain to every build; RNAP_SITE_URL overrides it elsewhere.
const PRODUCTION = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const SITE = (process.env.RNAP_SITE_URL ?? (PRODUCTION ? `https://${PRODUCTION}` : 'http://localhost:4173')).replace(
  /\/$/,
  ''
);
const url = (p: string) => `${SITE}${BASE}${p.replace(/^\//, '')}`;

const NAME = 'React Native Anything Player';
const AUTHOR = {
  '@type': 'Person',
  name: 'Ricardo Freitas',
  url: 'https://rmotafreitas.dev',
  sameAs: ['https://github.com/rmotafreitas'],
};
const SOFTWARE = {
  '@type': 'SoftwareSourceCode',
  '@id': `${url('/')}#software`,
  name: NAME,
  alternateName: 'RNAP',
  description: pkg.description,
  url: url('/'),
  codeRepository: REPO,
  programmingLanguage: ['TypeScript', 'Swift', 'Kotlin'],
  runtimePlatform: ['React Native', 'iOS', 'Android'],
  license: 'https://polyformproject.org/licenses/noncommercial/1.0.0/',
  version: pkg.version,
  keywords: (pkg.keywords as string[]).join(', '),
  author: AUTHOR,
};

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

  lang: 'en-US',
  title: 'RNAP',
  titleTemplate: `:title | ${NAME}`,
  description: HOME.description,
  head: [
    // Favicons stay PNG (and ICO for /favicon.ico requests): Safari and
    // several crawlers do not accept WebP icons. The large icons are in the
    // manifest, so browsers do not download them on every page.
    ['link', { rel: 'icon', href: `${BASE}favicon.ico`, sizes: '48x48' }],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${BASE}favicon-32.png` }],
    ['link', { rel: 'apple-touch-icon', sizes: '180x180', href: `${BASE}apple-touch-icon.png` }],
    ['link', { rel: 'manifest', href: `${BASE}site.webmanifest` }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#fff8f2' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#1d0d0b' }],
    ['meta', { name: 'author', content: AUTHOR.name }],
  ],

  // Docs pages take their description from pages.mts, so the Markdown stays
  // free of front matter (GitHub renders it as a table).
  transformPageData(pageData) {
    const page = PAGES.find((p) => `${p.link.slice(1)}.md` === pageData.relativePath);
    if (page && !pageData.frontmatter.description) pageData.description = page.description;
  },

  // Canonical link, Open Graph / Twitter cards and JSON-LD for every page.
  transformHead({ pageData, title, description }) {
    if (pageData.isNotFound) return [['meta', { name: 'robots', content: 'noindex' }]];
    const route = pageData.relativePath.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
    const home = route === '';
    const href = url(route);
    const page = PAGES.find((p) => p.link === `/${route}`);
    // One card per page, drawn by scripts/og-images.mts; new pages fall back
    // to the site card until it is re-run.
    const card = home ? 'og/index.jpg' : `og/${route.replace(/\//g, '-')}.jpg`;
    const image = url(fs.existsSync(path.resolve(HERE, '../public', card)) ? card : 'og/index.jpg');
    const imageAlt = home ? `${NAME}: the audio player that doesn't give up` : `${page?.text ?? title} — ${NAME} docs`;
    const modified = pageData.lastUpdated ? new Date(pageData.lastUpdated).toISOString() : undefined;

    const graph: object[] = home
      ? [
          {
            '@type': 'WebSite',
            '@id': `${url('/')}#website`,
            name: NAME,
            alternateName: 'RNAP',
            url: url('/'),
            description,
            inLanguage: 'en',
            publisher: AUTHOR,
          },
          SOFTWARE,
        ]
      : [
          {
            '@type': 'TechArticle',
            headline: pageData.title,
            description,
            url: href,
            image,
            inLanguage: 'en',
            dateModified: modified,
            author: AUTHOR,
            publisher: AUTHOR,
            isPartOf: { '@id': `${url('/')}#website` },
            about: { '@id': `${url('/')}#software` },
          },
          {
            '@type': 'BreadcrumbList',
            itemListElement: [
              { '@type': 'ListItem', position: 1, name: NAME, item: url('/') },
              { '@type': 'ListItem', position: 2, name: pageData.title, item: href },
            ],
          },
        ];

    const head: HeadConfig[] = [
      ['link', { rel: 'canonical', href }],
      ['meta', { property: 'og:type', content: home ? 'website' : 'article' }],
      ['meta', { property: 'og:site_name', content: NAME }],
      ['meta', { property: 'og:locale', content: 'en_US' }],
      ['meta', { property: 'og:url', content: href }],
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: description }],
      ['meta', { property: 'og:image', content: image }],
      ['meta', { property: 'og:image:type', content: 'image/jpeg' }],
      ['meta', { property: 'og:image:width', content: '1200' }],
      ['meta', { property: 'og:image:height', content: '630' }],
      ['meta', { property: 'og:image:alt', content: imageAlt }],
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: description }],
      ['meta', { name: 'twitter:image', content: image }],
      ['meta', { name: 'twitter:image:alt', content: imageAlt }],
      ['script', { type: 'application/ld+json' }, JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })],
    ];
    if (modified) head.push(['meta', { property: 'article:modified_time', content: modified }]);
    return head;
  },

  sitemap: {
    hostname: url('/'),
    // The 404 page is not content.
    transformItems: (items) => items.filter((item) => !item.url.startsWith('404')),
  },

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
      const summary = PAGES.find((p) => `${p.link.slice(1)}.md` === page)?.description;
      index.push(`- [${title}](${url(page)})${summary ? `: ${summary}` : ''}`);
      sections.push(source.trim());
    }
    fs.writeFileSync(path.join(site.outDir, 'llms.txt'), index.join('\n') + '\n');
    fs.writeFileSync(path.join(site.outDir, 'llms-full.txt'), sections.join('\n\n---\n\n') + '\n');
    fs.writeFileSync(path.join(site.outDir, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${url('sitemap.xml')}\n`);
  },

  themeConfig: {
    logo: { src: '/logo.webp', alt: '', width: 24, height: 24 },
    nav: [
      { text: 'Docs', link: '/docs/getting-started', activeMatch: '^/docs/(?!comparison|roadmap)' },
      { text: 'Compare', link: '/docs/comparison' },
      { text: 'Roadmap', link: '/docs/roadmap' },
      { text: `v${pkg.version}`, items: [{ text: 'Changelog', link: `${REPO}/blob/main/CHANGELOG.md` }, { text: 'Licence', link: `${REPO}/blob/main/COMMERCIAL.md` }] },
    ],
    sidebar: SECTIONS.map((section) => ({
      text: section.text,
      items: section.items.map(({ text, link }) => ({ text, link })),
    })),
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
