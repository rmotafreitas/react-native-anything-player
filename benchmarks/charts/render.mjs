#!/usr/bin/env node
// Renders the comparison charts in docs/assets/charts/ from benchmarks/results/.
//
//   node benchmarks/charts/render.mjs
//
// Plain SVG, no dependencies: white cards that read the same on a light or a
// dark page (GitHub, npm, the docs site). Emphasis form: Airwave in the accent
// blue, every other library in the de-emphasis gray, values at the bar tips.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RESULTS = path.join(ROOT, 'benchmarks/results');
const OUT = path.join(ROOT, 'docs/assets/charts');

const C = {
  surface: '#ffffff',
  border: 'rgba(11,11,11,0.10)',
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  axis: '#c3c2b7',
  accent: '#2a78d6',
  accentWash: '#eef4fc',
  other: '#c3c2b7',
  good: '#0ca30c',
  serious: '#ec835a',
  warning: '#fab219',
};
const FONT = 'system-ui, -apple-system, &quot;Segoe UI&quot;, Roboto, sans-serif';

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (n) => Math.round(n).toLocaleString('en-US');
/** Rough advance width of system-ui text (px) — for layout, not typesetting. */
const textWidth = (s, size) => [...String(s)].length * size * 0.56;

function niceStep(max, ticks = 5) {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
}

function card(width, height, body, { title, subtitle, note }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}" role="img" aria-labelledby="t d">
<title id="t">${esc(title)}</title>
<desc id="d">${esc(subtitle)}${note ? ` — ${esc(note)}` : ''}</desc>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${C.surface}" stroke="${C.border}"/>
<text x="24" y="36" font-size="17" font-weight="600" fill="${C.ink}">${esc(title)}</text>
<text x="24" y="58" font-size="13" fill="${C.ink2}">${esc(subtitle)}</text>
${body}
${note ? `<text x="24" y="${height - 18}" font-size="11" fill="${C.muted}">${esc(note)}</text>` : ''}
</svg>
`;
}

/** Horizontal bars from one baseline, 4px rounded data end, square at the baseline. */
function barPath(x, y, w, h) {
  const r = Math.min(4, w);
  return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z`;
}

function hbar({ title, subtitle, note, rows, unit, cap }) {
  const width = 800;
  const labelW = 210;
  const valueW = 150;
  const rowH = 30;
  const bar = 18;
  const top = 92;
  const plotW = width - 24 - labelW - valueW;
  const max = cap ?? Math.max(...rows.map((r) => r.value));
  const step = niceStep(max);
  const axisMax = Math.ceil(max / step) * step;
  const x0 = 24 + labelW;
  const sx = (v) => (Math.min(v, axisMax) / axisMax) * plotW;
  const plotBottom = top + rows.length * rowH;
  const height = plotBottom + 30 + (note ? 34 : 14);

  let body = '';
  for (let v = 0; v <= axisMax + 1e-9; v += step) {
    const x = x0 + sx(v);
    body += `<line x1="${x}" y1="${top - 8}" x2="${x}" y2="${plotBottom}" stroke="${v === 0 ? C.axis : C.grid}" stroke-width="1"/>`;
    body += `<text x="${x}" y="${plotBottom + 18}" font-size="11" fill="${C.muted}" text-anchor="middle" style="font-variant-numeric:tabular-nums">${fmt(v)}</text>`;
  }
  body += `<text x="${x0 + plotW}" y="${top - 16}" font-size="11" fill="${C.muted}" text-anchor="end">${esc(unit)}</text>`;
  rows.forEach((r, i) => {
    const y = top + i * rowH + (rowH - bar) / 2;
    const w = Math.max(2, sx(r.value));
    const off = r.value > axisMax;
    body += `<text x="${x0 - 12}" y="${y + bar / 2 + 4.5}" font-size="13" fill="${r.highlight ? C.ink : C.ink2}" font-weight="${r.highlight ? 600 : 400}" text-anchor="end">${esc(r.label)}</text>`;
    body += `<path d="${barPath(x0 + 0.5, y, w, bar)}" fill="${r.highlight ? C.accent : C.other}"><title>${esc(r.label)}: ${fmt(r.value)} ${esc(unit)}</title></path>`;
    if (off) {
      // Axis break: two surface-colored slashes near the clipped end.
      const bx = x0 + w - 22;
      body += `<path d="M${bx},${y + bar + 2}l6,-${bar + 4}M${bx + 6},${y + bar + 2}l6,-${bar + 4}" stroke="${C.surface}" stroke-width="3"/>`;
    }
    const label = `${fmt(r.value)}${off ? ' (off scale)' : ''}`;
    body += `<text x="${x0 + w + 8}" y="${y + bar / 2 + 4.5}" font-size="12" fill="${r.highlight ? C.ink : C.ink2}" font-weight="${r.highlight ? 600 : 400}" style="font-variant-numeric:tabular-nums">${label}</text>`;
  });
  return card(width, height, body, { title, subtitle, note });
}

const CELL = {
  yes: { text: 'Built in', color: C.good, glyph: 'M-3.2,0.2l2.2,2.3l4.4,-4.8' },
  partial: { text: 'Partial', color: C.warning, glyph: 'M-3.5,0h7' },
  app: { text: 'Your code', color: C.serious, glyph: 'M0,-3.6v4M0,2.9v0.4' },
  no: { text: 'No', color: null, glyph: 'M-2.6,-2.6l5.2,5.2M2.6,-2.6l-5.2,5.2' },
};

function matrix(data) {
  const libs = data.libraries;
  const labelW = 330;
  const colW = 112;
  const rowH = 28;
  const width = 24 + labelW + libs.length * colW + 24;
  const x0 = 24 + labelW;
  let y = 100;
  let body = '';
  // Airwave column wash (the emphasis), drawn under everything.
  const rowsTotal = data.groups.reduce((n, g) => n + g.rows.length, 0);
  const groupsH = data.groups.length * 34;
  const heightPlot = rowsTotal * rowH + groupsH;
  body += `<rect x="${x0}" y="${y - 30}" width="${colW}" height="${heightPlot + 36}" rx="8" fill="${C.accentWash}"/>`;
  libs.forEach((lib, i) => {
    const cx = x0 + i * colW + colW / 2;
    body += `<text x="${cx}" y="${y - 10}" font-size="13" font-weight="600" fill="${C.ink}" text-anchor="middle">${esc(lib.label)}</text>`;
  });
  for (const group of data.groups) {
    y += 26;
    body += `<text x="24" y="${y}" font-size="12" font-weight="600" fill="${C.muted}" letter-spacing="0.4">${esc(group.title.toUpperCase())}</text>`;
    y += 8;
    for (const row of group.rows) {
      body += `<line x1="24" y1="${y}" x2="${width - 24}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>`;
      const cy = y + rowH / 2;
      body += `<text x="24" y="${cy + 4.5}" font-size="13" fill="${C.ink}">${esc(row.label)}<title>${esc(row.evidence)}</title></text>`;
      libs.forEach((lib, i) => {
        const v = CELL[row.values[lib.id]];
        const cx = x0 + i * colW + 22;
        const fill = v.color ?? 'none';
        const stroke = v.color ? 'none' : C.muted;
        const glyphColor = v.color ? '#ffffff' : C.muted;
        body += `<g transform="translate(${cx},${cy})"><circle r="7.5" fill="${fill}" stroke="${stroke}" stroke-width="1"/><path d="${v.glyph}" stroke="${glyphColor}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></g>`;
        body += `<text x="${cx + 13}" y="${cy + 4.5}" font-size="12" fill="${v.color ? C.ink2 : C.muted}">${v.text}<title>${esc(lib.label)} — ${esc(row.label)}: ${v.text}</title></text>`;
      });
      y += rowH;
    }
  }
  const height = y + 50;
  return card(width, height, body, {
    title: 'What you get out of the box',
    subtitle: libs.map((l) => `${l.label} ${l.version}`).join(' · '),
    note: 'Read from each package’s published source (TypeScript API + native code); not device-measured. Hover a row for its evidence.',
  });
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const size = JSON.parse(fs.readFileSync(path.join(RESULTS, 'size.json'), 'utf8'));
  const pkgs = size.packages;
  const label = (p) => `${p.label}`;
  const sorted = (key) =>
    [...pkgs].sort((a, b) => key(a) - key(b)).map((p) => ({ label: label(p), value: key(p), highlight: p.name === 'react-native-airwave' }));
  const source = `npm latest as of ${size.measuredAt} · benchmarks/size/measure.mjs`;

  const charts = {
    'install-size.svg': hbar({
      title: 'Download size',
      subtitle: 'The npm tarball an install fetches, in KB (smaller is better)',
      unit: 'KB',
      rows: sorted((p) => p.tarballBytes / 1024),
      note: source,
    }),
    'native-code.svg': hbar({
      title: 'Native code compiled into your app',
      subtitle: 'Non-blank lines of Swift / Obj-C / Kotlin / Java / C++ the package ships (tests excluded)',
      unit: 'lines',
      cap: 16000,
      rows: sorted((p) => p.native.lines),
      note: `${source} · react-native-audio-api also fetches FFmpeg binaries at pod install`,
    }),
    'android-dependencies.svg': hbar({
      title: 'Android libraries pulled into your APK',
      subtitle: 'Maven artifacts declared by the package (React Native and the Kotlin stdlib excluded)',
      unit: 'artifacts',
      rows: sorted((p) => p.androidDependencies.length),
      note: `${source} · Airwave: Media3 only, HLS optional (airwaveHls=false)`,
    }),
    'js-cost.svg': hbar({
      title: 'JavaScript added to your bundle',
      subtitle: 'Minified + gzipped, in KB (peers such as react-native and expo excluded)',
      unit: 'KB gzip',
      rows: sorted((p) => (p.jsGzipBytes ?? 0) / 1024),
      note: source,
    }),
  };
  const caps = JSON.parse(fs.readFileSync(path.join(RESULTS, 'capabilities.json'), 'utf8'));
  charts['capabilities.svg'] = matrix(caps);

  for (const [file, svg] of Object.entries(charts)) {
    fs.writeFileSync(path.join(OUT, file), svg);
    console.log(`wrote docs/assets/charts/${file}`);
  }
}

main();
