<script setup lang="ts">
// The capability matrix as a real table, from
// benchmarks/results/capabilities.json. GitHub shows the SVG drawn from the
// same file by benchmarks/charts/render.mjs.
import { computed, ref } from 'vue';
import data from '../../../../../benchmarks/results/capabilities.json';

defineProps<{ alt?: string }>();

type Value = 'yes' | 'partial' | 'app' | 'no';
const LABEL: Record<Value, string> = { yes: 'Built in', partial: 'Partial', app: 'Your code', no: 'No' };

const filter = ref<string>('all');
const open = ref<Set<string>>(new Set());

const groups = computed(() =>
  data.groups.filter((g) => filter.value === 'all' || g.title === filter.value)
);

function toggle(label: string) {
  const next = new Set(open.value);
  if (next.has(label)) next.delete(label);
  else next.add(label);
  open.value = next;
}

function value(row: (typeof data.groups)[number]['rows'][number], id: string): Value {
  return (row.values as Record<string, Value>)[id];
}
</script>

<template>
  <figure class="aw-matrix" :aria-label="alt ?? 'What you get out of the box'">
    <div class="top">
      <div class="title">
        <strong>What you get out of the box</strong>
        <span>{{ data.libraries.map((l) => `${l.label} ${l.version}`).join(' · ') }}</span>
      </div>
      <div class="chips" role="group" aria-label="Show">
        <button type="button" :aria-pressed="filter === 'all'" @click="filter = 'all'">All</button>
        <button
          v-for="g in data.groups"
          :key="g.title"
          type="button"
          :aria-pressed="filter === g.title"
          @click="filter = g.title"
        >
          {{ g.title }}
        </button>
      </div>
    </div>

    <div class="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col" class="feature"><span class="sr">Capability</span></th>
            <th v-for="lib in data.libraries" :key="lib.id" scope="col" :class="{ ours: lib.id === 'rnap' }">
              {{ lib.label }}
            </th>
          </tr>
        </thead>
        <tbody v-for="g in groups" :key="g.title">
          <tr class="group">
            <th :colspan="data.libraries.length + 1" scope="colgroup">{{ g.title }}</th>
          </tr>
          <template v-for="row in g.rows" :key="row.label">
            <tr>
              <th scope="row" class="feature">
                <button type="button" :aria-expanded="open.has(row.label)" @click="toggle(row.label)">
                  <span>{{ row.label }}</span>
                  <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" /></svg>
                </button>
              </th>
              <td v-for="lib in data.libraries" :key="lib.id" :class="[value(row, lib.id), { ours: lib.id === 'rnap' }]">
                <span class="cell">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <circle cx="8" cy="8" r="7" />
                    <path v-if="value(row, lib.id) === 'yes'" d="M4.8 8.2l2.1 2.2 4.3-4.6" />
                    <path v-else-if="value(row, lib.id) === 'partial'" d="M4.8 8h6.4" />
                    <path v-else-if="value(row, lib.id) === 'app'" d="M8 4.4v4.4M8 11.2v.4" />
                    <path v-else d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" />
                  </svg>
                  {{ LABEL[value(row, lib.id)] }}
                </span>
              </td>
            </tr>
            <tr v-if="open.has(row.label)" class="evidence">
              <td :colspan="data.libraries.length + 1">{{ row.evidence }}</td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
    <p class="foot">{{ data.method }} Click a row to see its evidence.</p>
  </figure>
</template>

<style scoped>
.aw-matrix {
  --ok: #138a13;
  --own: var(--brand-deep);
  margin: 24px 0;
  padding: 20px;
  border-radius: 14px;
  border: 1px solid var(--hairline-soft);
  background: var(--surface);
}
.dark .aw-matrix {
  --ok: #4fcf4f;
  --own: var(--brand);
}
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}
.title {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.title strong {
  font-size: 16px;
  color: var(--text);
}
.title span {
  font-size: 12.5px;
  color: var(--text-dim);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chips button {
  padding: 4px 12px;
  border-radius: 999px;
  border: 1px solid var(--hairline);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-soft);
  background: transparent;
  cursor: pointer;
}
.chips button[aria-pressed='true'] {
  color: var(--text-on-brand);
  border-color: var(--brand-deep);
  background: var(--brand-deep);
}
.chips button:focus-visible,
.feature button:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.scroll {
  overflow-x: auto;
}
table {
  display: table;
  width: 100%;
  margin: 0;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 13px;
}
th,
td {
  border: 0;
  border-bottom: 1px solid var(--hairline-soft);
  padding: 7px 8px;
  background: transparent;
}
tr {
  background: transparent !important;
  border: 0;
}
thead th {
  font-size: 13px;
  font-weight: 700;
  color: var(--text);
  text-align: left;
  white-space: nowrap;
}
th.ours,
td.ours {
  background: var(--row-active);
}
thead th.ours {
  border-radius: 10px 10px 0 0;
  color: var(--own);
}
tr.group th {
  padding-top: 18px;
  text-align: left;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
th.feature {
  min-width: 190px;
  text-align: left;
  font-weight: 400;
}
.feature button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.chev {
  flex: none;
  width: 12px;
  height: 12px;
  fill: none;
  stroke: var(--text-dim);
  stroke-width: 1.8;
  transition: transform 0.2s;
}
[aria-expanded='true'] .chev {
  transform: rotate(90deg);
}
.cell {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
  color: var(--text-soft);
}
.cell svg {
  flex: none;
  width: 16px;
  height: 16px;
  fill: none;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.yes svg circle { fill: var(--ok); stroke: none; }
.yes svg path { stroke: #fff; }
.partial svg circle { fill: var(--accent); stroke: none; }
.partial svg path { stroke: #351512; }
.app svg circle { fill: var(--brand); stroke: none; }
.app svg path { stroke: #fff; }
.no svg circle { stroke: var(--text-dim); stroke-width: 1.2; }
.no svg path { stroke: var(--text-dim); }
.no .cell { color: var(--text-dim); }
.evidence td {
  padding: 4px 10px 10px;
  font-size: 12.5px;
  color: var(--text-soft);
  background: var(--surface-subtle);
}
.foot {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
}
.sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
