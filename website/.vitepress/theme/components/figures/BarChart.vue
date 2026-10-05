<script setup lang="ts">
// A horizontal bar chart drawn with HTML and CSS from
// benchmarks/results/size.json. GitHub shows the same chart as the SVG that
// benchmarks/charts/render.mjs draws from that file.
import { computed } from 'vue';
import size from '../../../../../benchmarks/results/size.json';

type Pkg = (typeof size.packages)[number];

interface ChartSpec {
  title: string;
  subtitle: string;
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
    note: 'RNAP: Media3 only; HLS is optional (rnapHls=false).',
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

const spec = computed(() => CHARTS[props.name]);

function licence(p: Pkg): string {
  const l = p.license ?? '';
  if (l.startsWith('SEE LICENSE')) return 'commercial';
  if (l.startsWith('PolyForm')) return 'PolyForm NC';
  return l;
}

const rows = computed(() => {
  const s = spec.value;
  if (!s) return [];
  const list = size.packages.filter((p) => !props.only || props.only.includes(p.name));
  const values = list.map((p) => s.value(p));
  const max = s.cap ?? Math.max(...values);
  return list
    .map((p) => {
      const v = s.value(p);
      return {
        key: p.name,
        label: p.label,
        tag: licence(p),
        version: p.version,
        detail: `${p.name}@${p.version} · ${p.role}`,
        value: v,
        text: v.toLocaleString('en-US', { maximumFractionDigits: s.digits ?? 0, minimumFractionDigits: s.digits ?? 0 }),
        pct: Math.max(1.5, (Math.min(v, max) / max) * 100),
        clipped: v > max,
        ours: p.name === 'react-native-anything-player',
      };
    })
    .sort((a, b) => a.value - b.value);
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
          <span class="bar" :style="{ width: `${r.pct}%` }" :class="{ clipped: r.clipped }" />
          <!-- A clipped bar carries its label inside, at the break. -->
          <span class="value" :class="{ inside: r.clipped }" :style="r.clipped ? {} : { left: `${r.pct}%` }">
            {{ r.text + (r.ours ? ` ${spec.unit}` : '') + (r.clipped ? ' · off scale' : '') }}
          </span>
        </span>
      </li>
    </ol>
    <p class="foot">
      <span v-if="spec.note">{{ spec.note }} </span>
      Latest npm releases as of {{ size.measuredAt }} · <code>benchmarks/size/measure.mjs</code>
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
