<script setup lang="ts">
// A PlantUML diagram from docs/assets/diagrams, inlined so it follows the
// site theme: the colors PlantUML writes (as attributes and inline styles)
// are remapped to brand tokens by the stylesheet below. GitHub keeps showing
// the same SVG files as images.
import { computed, onMounted, ref } from 'vue';

const sources = import.meta.glob('../../../../../docs/assets/diagrams/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const props = defineProps<{ name: string; alt: string }>();

const source = computed(() => Object.entries(sources).find(([path]) => path.endsWith(`/${props.name}.svg`))?.[1] ?? '');

// Drawn width in px. PlantUML's smallest text is 11px at this size, so on a
// phone the diagram keeps it (slightly enlarged) and scrolls sideways instead
// of shrinking the text to 5px.
const width = computed(() => Number(/viewBox="0 0 ([\d.]+)/.exec(source.value)?.[1] ?? 0));

// When it scrolls, open on the middle of the drawing rather than its edge.
const canvas = ref<HTMLElement>();
onMounted(() => {
  const el = canvas.value;
  if (el && el.scrollWidth > el.clientWidth) el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
});

const svg = computed(() => {
  const entry = source.value;
  if (!entry) return '';
  // Accessible name for the drawing; the text inside stays selectable.
  return entry.replace('<svg ', `<svg role="img" aria-label="${props.alt.replace(/"/g, '&quot;')}" `);
});
</script>

<template>
  <figure class="aw-diagram">
    <!-- Focusable so keyboard users can scroll it on narrow screens. -->
    <div ref="canvas" class="canvas" tabindex="0" :style="{ '--d-width': `${width}px` }" v-html="svg" />
    <figcaption><span class="hint" aria-hidden="true">← scroll →</span>{{ alt }}</figcaption>
  </figure>
</template>

<style scoped>
.aw-diagram {
  --d-surface: var(--surface);
  --d-ink: var(--text);
  --d-ink2: var(--text-soft);
  --d-line: var(--text-dim);
  --d-border: var(--input-border);
  --d-hair: var(--hairline);
  --d-fill: var(--app-bg);
  --d-highlight: var(--row-active);
  --d-warn: var(--accent-subtle);
  --d-err: rgba(216, 60, 67, 0.14);
  margin: 24px 0;
  padding: 16px;
  border-radius: 14px;
  border: 1px solid var(--hairline-soft);
  background: var(--d-surface);
  /* Inline SVGs are hundreds of nodes: skip their layout until scrolled to. */
  content-visibility: auto;
  contain-intrinsic-size: auto 640px;
}
.canvas {
  overflow-x: auto;
  display: flex;
  justify-content: center;
}
.canvas :deep(svg) {
  width: 100% !important;
  height: auto !important;
  max-width: min(100%, 760px);
  background: transparent !important;
}
/* Fills (presentation attributes: any rule wins). */
.canvas :deep([fill='#351512']) { fill: var(--d-ink); }
.canvas :deep([fill='#6B4A45']) { fill: var(--d-ink2); }
.canvas :deep([fill='#FFF8F2']) { fill: var(--d-fill); }
.canvas :deep([fill='#FFFFFF']),
.canvas :deep([fill='#FFF']) { fill: var(--d-surface); }
.canvas :deep([fill='#222']),
.canvas :deep([fill='#000']) { fill: var(--d-ink); }
.canvas :deep([fill='#FFE4D5']) { fill: var(--d-highlight); }
.canvas :deep([fill='#FDEFD3']) { fill: var(--d-warn); }
.canvas :deep([fill='#FBE3E4']) { fill: var(--d-err); }
/* Strokes (inline styles: need !important). */
.canvas :deep([style*='stroke:#6B4A45']) { stroke: var(--d-line) !important; }
.canvas :deep([style*='stroke:#E2CBBF']) { stroke: var(--d-border) !important; }
.canvas :deep([style*='stroke:#F1E3DA']) { stroke: var(--d-hair) !important; }
.canvas :deep([style*='stroke:#351512']),
.canvas :deep([style*='stroke:#222']) { stroke: var(--d-ink) !important; }
.hint {
  display: none;
}
@media (max-width: 640px) {
  .canvas {
    justify-content: flex-start;
  }
  .hint {
    display: block;
    margin-bottom: 4px;
    font-weight: 600;
    color: var(--text-soft);
  }
  .canvas :deep(svg) {
    width: calc(var(--d-width) * 1.1) !important;
    max-width: none;
    flex: none;
  }
}
.canvas:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 4px;
}
figcaption {
  margin-top: 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-dim);
  text-align: center;
}
</style>
