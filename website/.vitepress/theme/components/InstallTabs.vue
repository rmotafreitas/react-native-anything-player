<script setup lang="ts">
// Package-manager tabs for an install command. The choice is shared by every
// instance on the site and remembered per browser.
import { computed, onMounted, ref, watch } from 'vue';

const props = defineProps<{ pkg: string }>();

const MANAGERS = [
  { id: 'npm', cmd: (p: string) => `npm install ${p}` },
  { id: 'yarn', cmd: (p: string) => `yarn add ${p}` },
  { id: 'pnpm', cmd: (p: string) => `pnpm add ${p}` },
  { id: 'bun', cmd: (p: string) => `bun add ${p}` },
  { id: 'expo', cmd: (p: string) => `npx expo install ${p}` },
] as const;
type Id = (typeof MANAGERS)[number]['id'];

const KEY = 'airwave-package-manager';
const selected = useShared();
const copied = ref(false);

const command = computed(() => MANAGERS.find((m) => m.id === selected.value)!.cmd(props.pkg));

onMounted(() => {
  try {
    const saved = localStorage.getItem(KEY) as Id | null;
    if (saved && MANAGERS.some((m) => m.id === saved)) selected.value = saved;
  } catch {
    // Storage unavailable: keep npm.
  }
});
watch(selected, (id) => {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not remembered; nothing else depends on it.
  }
});

async function copy() {
  try {
    await navigator.clipboard.writeText(command.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // The command stays selectable.
  }
}
</script>

<script lang="ts">
const shared = ref<'npm' | 'yarn' | 'pnpm' | 'bun' | 'expo'>('npm');
function useShared() {
  return shared;
}
</script>

<template>
  <div class="aw-install">
    <div class="tabs" role="tablist" aria-label="Package manager">
      <button
        v-for="m in MANAGERS"
        :key="m.id"
        type="button"
        role="tab"
        :aria-selected="selected === m.id"
        @click="selected = m.id"
      >
        {{ m.id }}
      </button>
    </div>
    <div class="line" role="tabpanel">
      <code><span class="prompt">$</span> {{ command }}</code>
      <button type="button" class="copy" :aria-label="`Copy ${command}`" @click="copy">
        {{ copied ? 'Copied' : 'Copy' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.aw-install {
  margin: 16px 0;
  border-radius: 12px;
  border: 1px solid var(--hairline);
  background: var(--vp-code-block-bg);
  overflow: hidden;
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 0 10px;
  border-bottom: 1px solid var(--hairline-soft);
  overflow-x: auto;
}
.tabs button {
  padding: 9px 10px 8px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: none;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  color: var(--text-dim);
  cursor: pointer;
}
.tabs button[aria-selected='true'] {
  color: var(--text);
  border-bottom-color: var(--brand);
}
.tabs button:focus-visible,
.copy:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: -2px;
}
.line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px 14px 20px;
}
.line code {
  min-width: 0;
  overflow-x: auto;
  padding: 0;
  background: none;
  font-size: 14px;
  color: var(--text);
  white-space: nowrap;
}
.prompt {
  color: var(--text-dim);
  user-select: none;
}
.copy {
  flex: none;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--hairline);
  background: var(--surface);
  font-size: 12px;
  color: var(--text-soft);
  cursor: pointer;
}
</style>
