// Draws the 1200×630 link-preview cards (Open Graph / Twitter) into
// public/og/: one for the home page and one per docs page in pages.mts.
// JPEG, not WebP: X, LinkedIn, WhatsApp and Slack all render JPEG previews,
// and it keeps each card well under WhatsApp's ~300 KB limit.
//
//   yarn workspace react-native-anything-player-website og
//
// Uses an installed Chrome/Chromium: set CHROME_PATH if Playwright's own
// browser is not installed. Re-run after adding a page or changing a title.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PAGES } from '../.vitepress/pages.mts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.resolve(HERE, '../public/og');

const dataUri = (file: string, type: string) =>
  `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
const FONTS = path.resolve(
  HERE,
  '../node_modules/vitepress/dist/client/theme-default/fonts'
);
const inter = dataUri(
  path.join(FONTS, 'inter-roman-latin.woff2'),
  'font/woff2'
);
const mascot = dataUri(
  path.join(ROOT, 'docs/assets/brand/mascot-480.webp'),
  'image/webp'
);
const icon = dataUri(path.resolve(HERE, '../public/icon-192.png'), 'image/png');

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

interface Card {
  file: string;
  eyebrow: string;
  title: string;
  description: string;
  big?: boolean;
}

function html(card: Card) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Inter; src: url(${inter}) format('woff2'); font-weight: 100 900; }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; overflow: hidden; font-family: Inter, sans-serif; color: #351512;
  background: radial-gradient(560px 460px at 960px 300px, rgba(255, 100, 40, 0.22), transparent 70%), #fff8f2; }
.bar { position: absolute; left: 0; right: 0; bottom: 0; height: 12px;
  background: linear-gradient(90deg, #c93c18, #ff6428 60%, #f4a51c); }
.copy { position: absolute; left: 72px; top: 64px; bottom: 76px; width: 640px;
  display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 16px; }
.brand img { width: 60px; height: 60px; border-radius: 15px; }
.brand b { font-size: 34px; font-weight: 800; letter-spacing: -0.02em;
  background: linear-gradient(120deg, #ff6428 20%, #f4a51c); -webkit-background-clip: text; color: transparent; }
.brand span { font-size: 21px; font-weight: 600; color: rgba(53, 21, 18, 0.64); letter-spacing: 0.02em; }
.eyebrow { margin-top: auto; font-size: 22px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: #b3330f; }
h1 { margin-top: 12px; font-size: ${card.big ? 68 : 58}px; line-height: 1.06; font-weight: 800;
  letter-spacing: -0.03em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
p { margin-top: 20px; font-size: 25px; line-height: 1.4; color: rgba(53, 21, 18, 0.74);
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.mascot { position: absolute; right: -10px; bottom: 12px; height: 600px;
  -webkit-mask-image: linear-gradient(to bottom, #000 80%, transparent); }
</style></head><body>
<img class="mascot" src="${mascot}" alt="">
<div class="copy">
  <div class="brand"><img src="${icon}" alt=""><b>RNAP</b><span>React Native Anything Player</span></div>
  <div class="eyebrow">${escape(card.eyebrow)}</div>
  <h1>${escape(card.title)}</h1>
  <p>${escape(card.description)}</p>
</div>
<div class="bar"></div>
</body></html>`;
}

const cards: Card[] = [
  {
    file: 'index.jpg',
    eyebrow: 'React Native audio player',
    title: 'The audio player that doesn’t give up.',
    description:
      'Files, streams and internet radio that keep playing through dead sockets, network switches, phone calls and frozen JavaScript.',
    big: true,
  },
  ...PAGES.map((page) => {
    const source = fs.readFileSync(
      path.join(ROOT, `${page.link.slice(1)}.md`),
      'utf8'
    );
    return {
      file: `${page.link.slice(1).replace(/\//g, '-')}.jpg`,
      eyebrow: page.section,
      // The page's own heading, as on the page.
      title: /^#\s+(.+)$/m.exec(source)?.[1] ?? page.text,
      description: page.description,
    };
  }),
];

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
});
const tab = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const card of cards) {
  await tab.setContent(html(card), { waitUntil: 'load' });
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({
    path: path.join(OUT, card.file),
    type: 'jpeg',
    quality: 86,
  });
  console.log(
    `og/${card.file}  ${(fs.statSync(path.join(OUT, card.file)).size / 1024).toFixed(0)} KB`
  );
}
await browser.close();
