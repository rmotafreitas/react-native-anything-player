<script setup lang="ts">
// A PlantUML diagram from docs/assets/diagrams, inlined so it follows the
// site theme: the colors PlantUML writes (as attributes and inline styles)
// are remapped to brand tokens by the stylesheet below. GitHub keeps showing
// the same SVG files as images.
import { computed } from 'vue';

const sources = import.meta.glob('../../../../../docs/assets/diagrams/*.svg', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const props = defineProps<{ name: string; alt: string }>();

const svg = computed(() => {
  const entry = Object.entries(sources).find(([path]) => path.endsWith(`/${props.name}.svg`));
  if (!entry) return '';
  // Accessible name for the drawing; the text inside stays selectable.
  return entry[1].replace('<svg ', `<svg role="img" aria-label="${props.alt.replace(/"/g, '&quot;')}" `);
});
</script>

<template>
  <figure class="aw-diagram">
    <div class="canvas" v-html="svg" />
    <figcaption>{{ alt }}</figcaption>
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
figcaption {
  margin-top: 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-dim);
  text-align: center;
}
</style>
