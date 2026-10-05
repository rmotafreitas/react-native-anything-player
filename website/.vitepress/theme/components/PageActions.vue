<script setup lang="ts">
// Page tools above every docs page, as on the Expo and Elysia docs: copy the
// page as Markdown (for pasting into an AI chat), open it in Claude or
// ChatGPT, or read the source on GitHub.
import { computed, ref } from 'vue';
import { useData, withBase } from 'vitepress';

const { page, theme } = useData();
const state = ref<'idle' | 'copied' | 'failed'>('idle');

/** The plain Markdown copy written next to each page at build time. */
const markdownPath = computed(() => withBase(`/${page.value.relativePath}`));
const sourceUrl = computed(() =>
  (theme.value.editLink?.pattern as string | undefined)?.replace('/edit/', '/blob/').replace(':path', page.value.filePath)
);

function absolute(path: string): string {
  return typeof window === 'undefined' ? path : new URL(path, window.location.origin).toString();
}
const prompt = computed(
  () => `Read ${absolute(markdownPath.value)} (react-native-airwave documentation) so I can ask questions about it.`
);
const claudeUrl = computed(() => `https://claude.ai/new?q=${encodeURIComponent(prompt.value)}`);
const chatgptUrl = computed(() => `https://chatgpt.com/?q=${encodeURIComponent(prompt.value)}`);

async function copyMarkdown() {
  try {
    const res = await fetch(markdownPath.value);
    if (!res.ok) throw new Error(String(res.status));
    await navigator.clipboard.writeText(await res.text());
    state.value = 'copied';
  } catch {
    state.value = 'failed';
  }
  setTimeout(() => (state.value = 'idle'), 1800);
}
</script>

<template>
  <div v-if="page.relativePath.startsWith('docs/')" class="aw-actions">
    <button type="button" @click="copyMarkdown">
      <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.6" /><path d="M10.5 5V3.6c0-.6-.5-1.1-1.1-1.1H3.6c-.6 0-1.1.5-1.1 1.1v5.8c0 .6.5 1.1 1.1 1.1H5" /></svg>
      {{ state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy page' }}
    </button>
    <a :href="markdownPath" target="_blank" rel="noopener">Markdown</a>
    <a :href="claudeUrl" target="_blank" rel="noopener">Open in Claude</a>
    <a :href="chatgptUrl" target="_blank" rel="noopener">Open in ChatGPT</a>
    <a v-if="sourceUrl" :href="sourceUrl" target="_blank" rel="noopener">Source</a>
  </div>
</template>

<style scoped>
.aw-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  margin-bottom: 12px;
}
.aw-actions button,
.aw-actions a {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--hairline);
  background: transparent;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-soft);
  text-decoration: none;
  cursor: pointer;
}
.aw-actions button:hover,
.aw-actions a:hover {
  color: var(--brand-deep);
  border-color: var(--brand);
}
.dark .aw-actions button:hover,
.dark .aw-actions a:hover {
  color: var(--brand);
}
svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
}
</style>
