<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';
import capabilities from '../../../../docs/assets/charts/capabilities.svg';

const install = 'npm i react-native-airwave';
const copied = ref(false);
async function copy() {
  try {
    await navigator.clipboard.writeText(install);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    // Clipboard blocked (insecure context): the command is still selectable.
  }
}

/** The status strip in the hero: what a radio does when the Wi-Fi drops. */
const timeline = [
  { state: 'playing', note: 'streaming the station' },
  { state: 'playing', note: 'Wi-Fi lost · buffer playing out' },
  { state: 'buffering', note: 'no data for 3 s · socket is dead' },
  { state: 'reconnecting', note: 'offline · probing, backoff 1 s → 2 s' },
  { state: 'loading', note: 'network back · re-open at the live edge' },
  { state: 'playing', note: 'back on air · zero lines of your code' },
];
const step = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    step.value = timeline.length - 1;
    return;
  }
  timer = setInterval(() => (step.value = (step.value + 1) % timeline.length), 1900);
});
onBeforeUnmount(() => clearInterval(timer));

const features = [
  {
    title: 'Bulletproof by default',
    body: 'Dead sockets, silent stalls, offline, Wi-Fi ↔ cellular, server kicks: detected and recovered natively with jittered backoff. You write no retry code.',
  },
  {
    title: 'Works while JS sleeps',
    body: 'State machine, timers, audio focus and the lock screen live in native code. A frozen or suspended JS thread changes nothing.',
  },
  {
    title: 'Radio-native',
    body: 'ICY titles timed to when they are heard, charset repair, one connection per stream, paused-stream release, song progress on the lock screen.',
  },
  {
    title: 'Lightweight',
    body: 'A TurboModule with zero JS dependencies and no framework requirement. Media3 only on Android; leave out HLS with one flag.',
  },
  {
    title: 'Honest state',
    body: 'Sequence-numbered snapshots, generations that drop stale native events, commands applied in call order. No flicker, no races.',
  },
  {
    title: 'Synchronous progress',
    body: 'getProgress() is a JSI read, about 10 µs. No progress events cross the bridge, so a progress bar costs nothing.',
  },
];

const stats = [
  { value: '59', label: 'engine scenarios, run on Swift and Kotlin' },
  { value: '0', label: 'runtime JS dependencies' },
  { value: '~10 µs', label: 'getProgress() over JSI (iOS p50)' },
  { value: '1', label: 'connection per stream, counted server-side' },
];
</script>

<template>
  <div class="aw">
    <section class="hero">
      <div class="hero-copy">
        <p class="badge">Built by a radio app developer, for app developers</p>
        <h1 class="name">Airwave</h1>
        <p class="slogan">The audio player that doesn’t give up.</p>
        <p class="lede">
          Native-first audio for React Native: files, streams and internet radio that keep playing through dead
          sockets, network switches, phone calls and frozen JavaScript.
        </p>
        <div class="actions">
          <a class="btn brand" :href="withBase('/docs/getting-started')">Get started</a>
          <a class="btn alt" :href="withBase('/docs/comparison')">Why Airwave</a>
        </div>
        <button class="install" type="button" :aria-label="`Copy: ${install}`" @click="copy">
          <span class="prompt">$</span>
          <code>{{ install }}</code>
          <span class="copy">{{ copied ? 'copied' : 'copy' }}</span>
        </button>
      </div>

      <div class="hero-demo" aria-label="Example: a radio recovering from a Wi-Fi drop">
        <div class="window">
          <div class="dots"><i /><i /><i /></div>
          <pre><code><span class="k">import</span> { Player } <span class="k">from</span> <span class="s">'react-native-airwave'</span>;

<span class="k">const</span> radio = <span class="k">new</span> <span class="f">Player</span>();
<span class="k">await</span> radio.<span class="f">load</span>(<span class="s">'https://radio.example.com/live'</span>);
<span class="k">await</span> radio.<span class="f">play</span>();
<span class="c">// that's the whole integration.</span></code></pre>
          <div class="status" aria-live="polite">
            <span class="pill" :class="timeline[step].state">{{ timeline[step].state }}</span>
            <span class="note">{{ timeline[step].note }}</span>
          </div>
          <div class="progress">
            <i v-for="(_, i) in timeline" :key="i" :class="{ on: i <= step }" />
          </div>
        </div>
      </div>
    </section>

    <section class="block">
      <h2>Delete your recovery code</h2>
      <p class="sub">
        Other players hand you a <code>retry()</code> and an error event. Then it is your job to notice the dead
        socket, back off, watch connectivity and do it all while JS timers are frozen in the background.
      </p>
      <div class="compare">
        <div class="pane">
          <div class="pane-title">What apps write around other players</div>
          <pre><code><span class="f">NetInfo</span>.<span class="f">addEventListener</span>((net) =&gt; {
  <span class="k">if</span> (net.isInternetReachable &amp;&amp; wasPlaying) <span class="f">retry</span>();
});
<span class="f">onError</span>(<span class="k">async</span> () =&gt; {
  <span class="k">for</span> (<span class="k">let</span> i = 0; i &lt; 6; i++) {
    <span class="k">await</span> <span class="f">sleep</span>(1000 * 2 ** i); <span class="c">// frozen in the background</span>
    <span class="k">try</span> { <span class="k">await</span> <span class="f">reload</span>(); <span class="k">return</span>; } <span class="k">catch</span> {}
  }
});
<span class="f">setInterval</span>(() =&gt; { <span class="c">// stalls nobody reports</span>
  <span class="k">if</span> (<span class="f">position</span>() === lastPosition) <span class="f">reload</span>();
}, 4000);
<span class="c">// …and the phone call, the handoff, the stale event…</span></code></pre>
        </div>
        <div class="pane ours">
          <div class="pane-title">What you write with Airwave</div>
          <pre><code><span class="k">await</span> radio.<span class="f">play</span>();</code></pre>
          <p class="pane-foot">
            Every rule above, and the production failure behind it, lives natively in the engine.
            <a :href="withBase('/docs/recovery')">Read the recovery policy →</a>
          </p>
        </div>
      </div>
    </section>

    <section class="block">
      <div class="grid">
        <article v-for="f in features" :key="f.title" class="card">
          <h3>{{ f.title }}</h3>
          <p>{{ f.body }}</p>
        </article>
      </div>
    </section>

    <section class="stats" aria-label="Facts">
      <div v-for="s in stats" :key="s.label" class="stat">
        <div class="value">{{ s.value }}</div>
        <div class="label">{{ s.label }}</div>
      </div>
    </section>

    <section class="block">
      <h2>How it compares</h2>
      <p class="sub">
        Read from each library’s published source, not marketing. Where Airwave is behind (queues, caching,
        CarPlay) is on the <a :href="withBase('/docs/roadmap')">roadmap</a>.
      </p>
      <a class="chart" :href="withBase('/docs/comparison')">
        <img :src="capabilities" alt="Capability matrix comparing Airwave, RNTP 5, RNTP 4 and expo-audio" loading="lazy" />
      </a>
    </section>

    <section class="cta">
      <h2>Ship the player you stop thinking about.</h2>
      <div class="actions">
        <a class="btn brand" :href="withBase('/docs/getting-started')">Get started</a>
        <a class="btn alt" :href="withBase('/docs/architecture')">How it works</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.aw {
  --aw-grad: linear-gradient(120deg, #3b9bff 10%, #7c5cff 90%);
  max-width: 1152px;
  margin: 0 auto;
  padding: 48px 24px 96px;
}
.hero > *,
.compare > *,
.grid > *,
.stats > * {
  min-width: 0;
}
.hero {
  display: grid;
  grid-template-columns: 1.05fr 1fr;
  gap: 48px;
  align-items: center;
  min-height: 520px;
}
.badge {
  display: inline-block;
  margin: 0 0 18px;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
}
.name {
  margin: 0;
  font-size: 76px;
  line-height: 1;
  font-weight: 800;
  letter-spacing: -0.03em;
  background: var(--aw-grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.slogan {
  margin: 14px 0 0;
  font-size: 40px;
  line-height: 1.15;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--vp-c-text-1);
}
.lede {
  margin: 20px 0 0;
  max-width: 560px;
  font-size: 18px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}
.btn {
  display: inline-block;
  padding: 0 22px;
  line-height: 44px;
  border-radius: 22px;
  font-weight: 600;
  font-size: 15px;
  text-decoration: none;
  transition: background-color 0.2s, border-color 0.2s;
}
.btn.brand {
  color: #fff;
  background: var(--vp-button-brand-bg);
}
.btn.brand:hover {
  background: var(--vp-button-brand-hover-bg);
}
.btn.alt {
  color: var(--vp-c-text-1);
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}
.btn.alt:hover {
  border-color: var(--vp-c-brand-2);
}
.install {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  cursor: pointer;
}
.install code {
  background: none;
  padding: 0;
  color: var(--vp-c-text-1);
}
.install .prompt {
  color: var(--vp-c-text-3);
}
.install .copy {
  margin-left: 8px;
  font-family: var(--vp-font-family-base);
  font-size: 12px;
  color: var(--vp-c-brand-1);
}

.window {
  border-radius: 16px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-alt);
  box-shadow: 0 24px 64px -24px rgba(42, 120, 214, 0.35);
  overflow: hidden;
}
.dots {
  display: flex;
  gap: 6px;
  padding: 12px 16px 0;
}
.dots i {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--vp-c-divider);
}
pre {
  margin: 0;
  padding: 16px 20px;
  overflow-x: auto;
  font-family: var(--vp-font-family-mono);
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--vp-c-text-1);
}
pre code {
  background: none;
  padding: 0;
  font-size: inherit;
}
.k {
  color: #a347d6;
}
.s {
  color: #1c8a4f;
}
.f {
  color: #2468bd;
}
.c {
  color: var(--vp-c-text-3);
  font-style: italic;
}
.dark .k {
  color: #d39cf2;
}
.dark .s {
  color: #7fd6a2;
}
.dark .f {
  color: #7fb4f5;
}
.status {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 12px 20px;
  border-top: 1px solid var(--vp-c-divider);
}
.pill {
  flex: none;
  min-width: 108px;
  padding: 3px 10px;
  border-radius: 999px;
  text-align: center;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  font-weight: 600;
  transition: background-color 0.3s, color 0.3s;
}
.pill.playing {
  color: #fff;
  background: #0ca30c;
}
.pill.buffering,
.pill.loading {
  color: #0b0b0b;
  background: #fab219;
}
.pill.reconnecting {
  color: #0b0b0b;
  background: #ec835a;
}
.note {
  font-size: 14px;
  color: var(--vp-c-text-2);
}
.progress {
  display: flex;
  gap: 4px;
  padding: 0 20px 16px;
}
.progress i {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: var(--vp-c-divider);
  transition: background-color 0.3s;
}
.progress i.on {
  background: var(--vp-c-brand-2);
}

.block {
  margin-top: 96px;
}
.block h2,
.cta h2 {
  margin: 0;
  font-size: 32px;
  line-height: 1.2;
  font-weight: 700;
  letter-spacing: -0.02em;
  border: 0;
  padding: 0;
}
.sub {
  max-width: 720px;
  margin: 12px 0 0;
  font-size: 17px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.sub code {
  font-size: 15px;
}
.compare {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 20px;
  margin-top: 28px;
}
.pane {
  border-radius: 14px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-alt);
  overflow: hidden;
}
.pane.ours {
  border-color: var(--vp-c-brand-2);
  background: var(--vp-c-brand-soft);
}
.pane-title {
  padding: 12px 20px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}
.pane-foot {
  margin: 0;
  padding: 0 20px 20px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.pane-foot a,
.sub a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}
.card {
  padding: 24px;
  border-radius: 14px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
}
.card h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.card p {
  margin: 8px 0 0;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 16px;
  margin-top: 64px;
  padding: 28px;
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
}
.stat .value {
  font-size: 36px;
  font-weight: 700;
  letter-spacing: -0.02em;
  background: var(--aw-grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.stat .label {
  margin-top: 4px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
.chart {
  display: block;
  margin-top: 28px;
}
.chart img {
  display: block;
  width: 100%;
  max-width: 920px;
  border-radius: 12px;
}
.dark .chart img {
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.cta {
  margin-top: 112px;
  text-align: center;
}
.cta .actions {
  justify-content: center;
}

@media (max-width: 960px) {
  .hero,
  .compare {
    grid-template-columns: 1fr;
  }
  .grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 640px) {
  .aw {
    padding: 32px 16px 72px;
  }
  .name {
    font-size: 56px;
  }
  .slogan {
    font-size: 30px;
  }
  .grid {
    grid-template-columns: 1fr;
  }
  .install {
    max-width: 100%;
  }
}
</style>
