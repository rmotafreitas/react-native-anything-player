<script setup lang="ts">
// A horizontal bar chart drawn with HTML and CSS from
// benchmarks/results/size.json: the React Native charts (install-size, …) and
// one per kind of web page (web-rn, web-react, web-vanilla). GitHub shows the
// same chart as the SVG that benchmarks/charts/render.mjs draws from that file.
import { computed } from 'vue';
import size from '../../../../../benchmarks/results/size.json';
import apk from '../../../../../benchmarks/results/apk.json';

type Pkg = (typeof size.packages)[number];
type WebPkg = (typeof size.web)[number]['packages'][number];

/** The web charts: one per kind of page, each library against its own kind. */
const WEB: Record<string, { id: string; title: string; subtitle: string; note?: string }> = {
  'web-rn': {
    id: 'rnWeb',
    title: 'Expo web and React Native Web: JavaScript in the page',
    subtitle: 'React Native packages bundled for the browser. Minified + gzipped KB on page load; lighter: fetched before it plays.',
    note: 'Not counted, for HLS outside Safari: hls.js for RNAP (the app adds it), shaka-player for RNTP 5.',
  },
  'web-react': {
    id: 'react',
    title: 'React (react-dom): JavaScript in the page',
    subtitle: 'RNAP’s /react entry and the React audio libraries. Minified + gzipped KB on page load.',
  },
  'web-vanilla': {
    id: 'vanilla',
    title: 'Any web page: JavaScript in the page',
    subtitle: 'RNAP’s /web entry and the plain-JavaScript audio libraries. Minified + gzipped KB on page load.',
  },
};

interface ChartSpec {
  title: string;
  subtitle: string;
  /** Where the numbers come from (default: the npm size benchmark). */
  source?: { date: string; script: string; text: string };
  unit: string;
  value: (p: Pkg) => number;
  digits?: number;
  /** Values above this are drawn clipped, with an axis break. */
  cap?: number;
  note?: string;
}

const CHARTS: Record<string, ChartSpec> = {
  'install-size': {
    title: 'Download size',
    subtitle: 'The npm tarball an install fetches. Smaller is better.',
    unit: 'KB',
    value: (p) => p.tarballBytes / 1024,
  },
  'native-code': {
    title: 'Native code compiled into your app',
    subtitle: 'Non-blank lines of Swift, Obj-C, Kotlin, Java and C++ the package ships, tests excluded.',
    unit: 'lines',
    value: (p) => p.native.lines,
    cap: 16000,
    note: 'react-native-audio-api also fetches FFmpeg binaries at pod install.',
  },
  'android-dependencies': {
    title: 'Android libraries pulled into your APK',
    subtitle: 'Maven artifacts the package declares (React Native and the Kotlin stdlib excluded).',
    unit: 'artifacts',
    value: (p) => p.androidDependencies.length,
    note: 'RNAP: Media3 and MediaRouter; HLS is optional (rnapHls=false), Cast opt-in.',
  },
  'js-cost': {
    title: 'JavaScript added to your bundle',
    subtitle: 'Minified + gzipped. Peers such as react-native and expo excluded.',
    unit: 'KB gzip',
    value: (p) => (p.jsGzipBytes ?? 0) / 1024,
    digits: 1,
  },
};

const props = defineProps<{
  name: string;
  alt?: string;
  /** Restrict to these package names (in this order of priority: sorted by value). */
  only?: string[];
  /** Hide title and subtitle (when the surrounding section already says it). */
  bare?: boolean;
}>();

/** A release APK: what each library adds with R8, and the rest without it (benchmarks/results/apk.json). */
const APK: ChartSpec = {
  title: 'Added to a release APK',
  subtitle: `React Native ${apk.reactNative}, ${apk.abi}, against an empty app. KB with R8 (solid) / without R8 (whole bar).`,
  unit: 'KB',
  value: () => 0,
  note: 'RNAP without HLS, with Cast, and the libraries that did not build are listed on the page.',
  source: { date: apk.measuredAt, script: 'benchmarks/android/measure-apk.mjs', text: 'Built' },
};

const web = computed(() => WEB[props.name]);
const spec = computed<ChartSpec | undefined>(() => {
  if (props.name === 'apk-size') return APK;
  return web.value
    ? { ...web.value, unit: 'KB gzip', value: () => 0, digits: 1, cap: 60 }
    : CHARTS[props.name];
});

function licence(p: { license: string | null }): string {
  if (p.license == null) return '';
  const l = p.license ?? '';
  if (l.startsWith('SEE LICENSE')) return 'commercial';
  if (l.startsWith('PolyForm')) return 'PolyForm NC';
  return l;
}

interface Item {
  name: string;
  label: string;
  license: string | null;
  version: string;
  detail: string;
  value: number;
  /** What it must fetch before it plays anything (drawn lighter, after the bar). */
  later: number;
  /** The value label, when it says more than the number. */
  text?: string;
  /** What orders the bars, when not their length. */
  sortBy?: number;
}

function items(s: ChartSpec): Item[] {
  if (props.name === 'apk-size') {
    const kb = (bytes: number) => Math.round(bytes / 1024);
    return apk.libraries
      .filter((l) => !('failed' in l && l.failed) && l.id !== 'rnapNoHls' && l.id !== 'rnapCast')
      .map((l) => {
        const lib = l as Extract<(typeof apk.libraries)[number], { r8: unknown }>;
        return {
          name: lib.name,
          label: lib.label,
          license: null,
          version: lib.version,
          detail: `${lib.name}@${lib.version} · dex ${kb(lib.r8.dexBytes)} KB, native ${kb(lib.r8.nativeBytes)} KB, resources ${kb(lib.r8.resourceBytes)} KB with R8`,
          value: lib.r8.apkBytes / 1024,
          later: Math.max(0, lib.noR8.apkBytes - lib.r8.apkBytes) / 1024,
          text: `${kb(lib.r8.apkBytes).toLocaleString('en-US')} / ${kb(lib.noR8.apkBytes).toLocaleString('en-US')}`,
          sortBy: lib.r8.apkBytes,
        };
      });
  }
  if (web.value) {
    const category = size.web.find((c) => c.id === web.value!.id);
    return (category?.packages ?? []).map((p: WebPkg) => ({
      name: p.name,
      label: p.label,
      license: p.license,
      version: p.version,
      detail: `${p.name}@${p.version} · ${(p.totalGzipBytes / 1024).toFixed(1)} KB with every optional part loaded`,
      value: p.initialGzipBytes / 1024,
      later: p.later.filter((l) => l.required).reduce((n, l) => n + l.gzipBytes, 0) / 1024,
    }));
  }
  return size.packages.map((p: Pkg) => ({
    name: p.name,
    label: p.label,
    license: p.license,
    version: p.version,
    detail: `${p.name}@${p.version} · ${p.role}`,
    value: s.value(p),
    later: 0,
  }));
}

const rows = computed(() => {
  const s = spec.value;
  if (!s) return [];
  const list = items(s).filter((p) => !props.only || props.only.includes(p.name));
  const max = s.cap ?? Math.max(...list.map((p) => p.value + p.later));
  const pct = (v: number) => Math.max(1.5, (Math.min(v, max) / max) * 100);
  const num = (v: number) =>
    v.toLocaleString('en-US', { maximumFractionDigits: s.digits ?? 0, minimumFractionDigits: s.digits ?? 0 });
  return list
    .map((p) => {
      const total = p.value + p.later;
      return {
        key: p.name,
        sortBy: p.sortBy ?? total,
        label: p.label,
        tag: licence(p),
        version: p.version,
        detail: p.detail,
        value: total,
        text: p.text ?? num(p.value) + (p.later ? ` + ${num(p.later)} to play` : ''),
        pct: pct(total),
        solid: p.later ? (pct(p.value) / pct(total)) * 100 : 100,
        clipped: total > max,
        ours: p.name === 'react-native-anything-player',
      };
    })
    .sort((a, b) => a.sortBy - b.sortBy);
});
</script>

<template>
  <figure v-if="spec" class="aw-bars" :aria-label="alt ?? spec.title">
    <figcaption v-if="!bare" class="head">
      <strong>{{ spec.title }}</strong>
      <span>{{ spec.subtitle }}</span>
    </figcaption>
    <ol class="rows">
      <li
        v-for="r in rows"
        :key="r.key"
        class="row"
        :class="{ ours: r.ours }"
        tabindex="0"
        :title="r.detail"
        :aria-label="`${r.label}: ${r.text} ${spec.unit}${r.clipped ? ' (off scale)' : ''}`"
      >
        <span class="name">
          {{ r.label }} <small>{{ r.tag }}</small>
        </span>
        <span class="track">
          <span
            class="bar"
            :style="{ width: `${r.pct}%`, '--solid': `${r.solid}%` }"
            :class="{ clipped: r.clipped, later: r.solid < 100 }"
          />
          <!-- A clipped bar carries its label inside, at the break. -->
          <span class="value" :class="{ inside: r.clipped }" :style="r.clipped ? {} : { left: `${r.pct}%` }">
            {{ r.text + (r.ours && !r.text.includes('/') ? ` ${spec.unit}` : '') + (r.clipped && !r.text.includes('+') ? ' · off scale' : '') }}
          </span>
        </span>
      </li>
    </ol>
    <p class="foot">
      <span v-if="spec.note">{{ spec.note }} </span>
      {{ spec.source?.text ?? 'Latest npm releases as of' }} {{ spec.source?.date ?? size.measuredAt }} ·
      <code>{{ spec.source?.script ?? 'benchmarks/size/measure.mjs' }}</code>
    </p>
    <details class="table">
      <summary>Show the numbers</summary>
      <table>
        <thead>
          <tr><th>Package</th><th>Version</th><th>Licence</th><th class="num">{{ spec.unit }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in [...rows].reverse()" :key="r.key">
            <td>{{ r.label }}</td><td>{{ r.version }}</td><td>{{ r.tag }}</td><td class="num">{{ r.text }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </figure>
</template>

<style scoped>
.aw-bars {
  margin: 24px 0;
  padding: 20px 20px 14px;
  border-radius: 14px;
  border: 1px solid var(--hairline-soft);
  background: var(--surface);
}
.head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 16px;
}
.head strong {
  font-size: 16px;
  color: var(--text);
}
.head span {
  font-size: 13.5px;
  color: var(--text-soft);
}
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.row {
  display: grid;
  grid-template-columns: 15.5rem 1fr;
  align-items: center;
  gap: 12px;
  margin: 0;
  padding: 2px 6px;
  border-radius: 8px;
  outline: none;
}
.row:hover,
.row:focus-visible {
  background: var(--surface-subtle);
}
.row:focus-visible {
  box-shadow: 0 0 0 2px var(--brand);
}
.name {
  min-width: 0;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  color: var(--text-soft);
  text-align: right;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.name small {
  margin-left: 4px;
  font-size: 12px;
  color: var(--text-dim);
}
.ours .name {
  color: var(--brand-ink);
  font-weight: 700;
}
.dark .ours .name {
  color: var(--brand);
}
.track {
  position: relative;
  height: 20px;
  margin-right: 104px;
}
.bar {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 0 999px 999px 0;
  background: var(--switch-off);
  transition: width 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.ours .bar {
  background: linear-gradient(90deg, var(--brand-deep), var(--brand) 60%, var(--accent));
}
/* The part fetched on first play: the same bar, washed, after the solid part. */
.bar.later {
  background: linear-gradient(90deg, var(--switch-off) var(--solid), color-mix(in srgb, var(--switch-off) 45%, transparent) var(--solid));
}
.ours .bar.later {
  background: linear-gradient(90deg, var(--brand) var(--solid), color-mix(in srgb, var(--brand) 35%, transparent) var(--solid));
}
.bar.clipped {
  border-radius: 0;
  -webkit-mask-image: linear-gradient(90deg, #000 92%, transparent 92%, transparent 94%, #000 94%, #000 96%, transparent 96%);
  mask-image: linear-gradient(90deg, #000 92%, transparent 92%, transparent 94%, #000 94%, #000 96%, transparent 96%);
}
.value {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  padding-left: 8px;
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  white-space: nowrap;
}
.ours .value {
  color: var(--text);
  font-weight: 700;
}
.value.inside {
  right: 12%;
  padding: 0 8px;
  border-radius: 6px;
  color: var(--text);
  background: var(--surface);
}
.foot {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
}
.foot code {
  font-size: 12px;
}
.table {
  margin-top: 6px;
  font-size: 13px;
}
.table summary {
  cursor: pointer;
  color: var(--brand-ink);
  font-weight: 500;
}
.dark .table summary {
  color: var(--brand);
}
.table table {
  display: table;
  width: 100%;
  margin: 10px 0 0;
}
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
@media (max-width: 640px) {
  .row {
    grid-template-columns: 1fr;
    gap: 2px;
  }
  .name {
    text-align: left;
  }
  .track {
    margin-right: 104px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bar {
    transition: none;
  }
}
</style>
