<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';
import CapabilityMatrix from './figures/CapabilityMatrix.vue';
import BarChart from './figures/BarChart.vue';
import mascot400 from '../../../../docs/assets/brand/mascot-400.webp';
import mascot480 from '../../../../docs/assets/brand/mascot-480.webp';

const install = 'npm i react-native-anything-player';
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
    body: 'getProgress() is a JSI read, about 10 µs, so a progress bar needs no events. Native-timed progress events are opt-in, for JS that must follow the audio in the background.',
  },
];

/** "Pull the plug": what happens, in order, when a radio loses Wi-Fi. */
const outage = [
  {
    at: '0 s',
    state: 'playing',
    title: 'Streaming the station',
    body: 'Audio flows from a buffer several seconds deep. Nothing is polled from JavaScript.',
  },
  {
    at: 'Wi-Fi lost',
    state: 'playing',
    title: 'The buffer plays out',
    body: 'The network monitor records the edge and stall detection turns eager for 20 s. Listeners hear nothing yet.',
  },
  {
    at: '+3 s, no data',
    state: 'reconnecting',
    title: 'Dead socket detected',
    body: 'No buffered progress for 3 s while the device is offline. Attempts are skipped; every third one runs as a probe.',
  },
  {
    at: 'Network back',
    state: 'loading',
    title: 'Re-open at the live edge',
    body: 'The restore edge re-opens at once with backoff reset. A late error from the dead connection is dropped by its generation.',
  },
  {
    at: '+0.6 s',
    state: 'playing',
    title: 'Back on air',
    body: 'Measured on the Android 16 emulator. Your JavaScript ran zero lines; it could have been frozen the whole time.',
  },
];

const PLAYERS = ['react-native-anything-player', '@rntp/player', 'react-native-track-player', 'expo-audio', 'react-native-audio-pro'];

const stats = [
  { value: '59', label: 'engine scenarios, run on Swift and Kotlin' },
  { value: '3 s', label: 'to detect a dead socket and re-open' },
  { value: '~10 µs', label: 'getProgress() over JSI (iOS p50)' },
  { value: '1', label: 'connection per stream, counted server-side' },
];
</script>

<template>
  <main class="aw">
    <section class="hero">
      <div class="hero-copy">
        <p class="badge">Built by a radio app developer, for app developers</p>
        <h1 class="name">RNAP</h1>
        <p class="fullname">React Native Anything Player</p>
        <p class="slogan">The audio player that doesn’t give up.</p>
        <p class="lede">
          Native-first audio for React Native: files, streams and internet radio that keep playing through dead
          sockets, network switches, phone calls and frozen JavaScript.
        </p>
        <div class="actions">
          <a class="btn brand" :href="withBase('/docs/getting-started')">Get started</a>
          <a class="btn alt" :href="withBase('/docs/why')">Why RNAP</a>
        </div>
        <button class="install" type="button" title="Copy the install command" @click="copy">
          <span class="prompt" aria-hidden="true">$</span>
          <code>{{ install }}</code>
          <span class="copy" aria-live="polite">{{ copied ? 'copied' : 'copy' }}</span>
        </button>
      </div>

      <div class="hero-art">
        <div class="halo" aria-hidden="true" />
        <!-- The LCP element: fetched first, 400w for 1x screens. -->
        <img
          class="mascot"
          :src="mascot480"
          :srcset="`${mascot400} 400w, ${mascot480} 480w`"
          sizes="(max-width: 432px) calc(100vw - 32px), 400px"
          fetchpriority="high"
          alt="RNAP's mascot, a fox girl in orange headphones, tapping play on her phone"
          width="480"
          height="596"
        />
        <div class="window" aria-label="Example: a radio recovering from a Wi-Fi drop">
          <div class="dots"><i /><i /><i /></div>
          <pre><code><span class="k">import</span> { Player } <span class="k">from</span> <span class="s">'react-native-anything-player'</span>;

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

    <section class="block origin">
      <p class="eyebrow">Why it exists</p>
      <h2>Born at a radio app</h2>
      <p class="sub">
        RNAP was built by <a href="https://github.com/rmotafreitas" target="_blank" rel="noopener">@rmotafreitas</a>,
        developer of the Rádio Animu mobile app and part of the
        <a href="https://www.animu.moe" target="_blank" rel="noopener">animu.moe</a> team, when two things happened at once.
      </p>
      <div class="reasons">
        <article>
          <h3>The default player went commercial</h3>
          <p>
            React Native Track Player 5 is free only for personal or educational use. A free app from a radio station
            or a non-profit needs a paid licence: €99 a month per app.
          </p>
        </article>
        <article>
          <h3>Staying on air took a pile of app code</h3>
          <p>
            Wi-Fi drops, a switch to mobile data, opening Instagram, a phone call, the voice assistant: with every
            available player, the app had to notice, back off, retry and resume by itself.
          </p>
        </article>
      </div>
      <p class="sub small"><a :href="withBase('/docs/why')">The full story, with sources →</a></p>
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
          <div class="pane-title">What you write with RNAP</div>
          <pre><code><span class="k">await</span> radio.<span class="f">play</span>();</code></pre>
          <p class="pane-foot">
            Every rule above, and the production failure behind it, lives natively in the engine.
            <a :href="withBase('/docs/recovery')">Read the recovery policy →</a>
          </p>
        </div>
      </div>
    </section>

    <section class="block">
      <p class="eyebrow">Pull the plug</p>
      <h2>What happens when the Wi-Fi drops</h2>
      <p class="sub">The engine runs this sequence natively. It is the same on iOS and Android, because both engines pass one shared conformance suite.</p>
      <ol class="timeline">
        <li v-for="(s, i) in outage" :key="i">
          <span class="dot" :class="s.state" aria-hidden="true" />
          <div class="when">{{ s.at }}</div>
          <div class="what">
            <span class="pill" :class="s.state">{{ s.state }}</span>
            <h3>{{ s.title }}</h3>
            <p>{{ s.body }}</p>
          </div>
        </li>
      </ol>
      <p class="sub small"><a :href="withBase('/docs/recovery')">Every recovery rule and the production failure behind it →</a></p>
    </section>

    <section class="block lean">
      <div class="lean-stats">
        <p class="eyebrow">Lean by design</p>
        <div class="big"><span>4</span> Android libraries</div>
        <p>Media3 and nothing else. HLS is optional.</p>
        <div class="big"><span>0</span> JS dependencies</div>
        <p>No framework, no Nitro, no state library. Expo is optional.</p>
      </div>
      <BarChart name="android-dependencies" :only="PLAYERS" bare />
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
        Read from each library’s published source, not marketing. Where RNAP is behind (queues, caching,
        CarPlay) is on the <a :href="withBase('/docs/roadmap')">roadmap</a>.
      </p>
      <CapabilityMatrix />
    </section>

    <section class="cta">
      <h2>Ship the player you stop thinking about.</h2>
      <div class="actions">
        <a class="btn brand" :href="withBase('/docs/getting-started')">Get started</a>
        <a class="btn alt" :href="withBase('/docs/architecture')">How it works</a>
      </div>
    </section>
  </main>
</template>

<style scoped>
.aw {
  --aw-grad: linear-gradient(110deg, var(--brand) 25%, var(--accent));
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
  grid-template-columns: 1fr 1fr;
  gap: 32px;
  align-items: center;
}
.hero-art {
  position: relative;
  display: flex;
  justify-content: center;
  /* Room for the demo card, which overlaps only the faded waist. */
  padding-bottom: 190px;
}
.halo {
  position: absolute;
  inset: 6% 8% 22%;
  border-radius: 50%;
  background: radial-gradient(closest-side, var(--brand-subtle), transparent);
}
.mascot {
  position: relative;
  width: min(100%, 400px);
  height: auto;
  /* The artwork is cropped at the waist: fade that edge into the page. */
  -webkit-mask-image: linear-gradient(to bottom, #000 78%, transparent);
  mask-image: linear-gradient(to bottom, #000 78%, transparent);
}
.badge {
  display: inline-block;
  margin: 0 0 18px;
  padding: 4px 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 500;
  color: var(--brand-ink);
  background: var(--brand-subtle);
}
.dark .badge {
  color: var(--brand);
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
.fullname {
  margin: 10px 0 0;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-soft);
}
.reasons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 24px;
}
.reasons article {
  min-width: 0;
  padding: 22px 24px;
  border-radius: 14px;
  border: 1px solid var(--hairline);
  background: var(--surface);
}
.reasons h3 {
  margin: 0;
  font-size: 17px;
  font-weight: 600;
}
.reasons p {
  margin: 8px 0 0;
  font-size: 15px;
  line-height: 1.6;
  color: var(--text-soft);
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
  position: absolute;
  left: 0;
  right: 8%;
  bottom: 0;
  border-radius: 16px;
  border: 1px solid var(--hairline);
  background: var(--surface);
  box-shadow: 0 24px 64px -28px var(--scrim);
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
  color: var(--frame);
  font-weight: 600;
}
.s {
  color: #8f5508;
}
.f {
  color: var(--brand-ink);
}
.c {
  color: var(--vp-c-text-3);
  font-style: italic;
}
.dark .k {
  color: #ff9a76;
}
.dark .s {
  color: var(--accent);
}
.dark .f {
  color: #ffd2bd;
}
.status {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 12px 20px;
  border-top: 1px solid var(--hairline);
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
  color: var(--text-on-brand);
  background: var(--brand-deep);
}
.pill.playing::before {
  content: '● ';
  color: #ffd2bd;
}
.pill.buffering,
.pill.loading {
  color: var(--text-on-light);
  background: var(--accent);
}
.pill.reconnecting {
  color: var(--text-on-brand);
  background: var(--frame);
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
  background: var(--visualizer);
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
  border-color: var(--brand);
  background: var(--brand-subtle);
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
.eyebrow {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--brand-ink);
}
.dark .eyebrow {
  color: var(--brand);
}
.sub.small {
  font-size: 15px;
}
.timeline {
  position: relative;
  list-style: none;
  margin: 32px 0 0;
  padding: 0 0 0 28px;
  display: grid;
  gap: 22px;
}
.timeline::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 1px;
  background: linear-gradient(var(--brand), var(--frame) 50%, var(--accent) 75%, var(--brand));
  opacity: 0.5;
}
.timeline li {
  position: relative;
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 20px;
  margin: 0;
}
.timeline .dot {
  position: absolute;
  left: -28px;
  top: 4px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 3px solid var(--app-bg);
  background: var(--brand-deep);
  box-shadow: 0 0 0 1px var(--hairline);
}
.timeline .dot.reconnecting {
  background: var(--frame);
}
.timeline .dot.loading {
  background: var(--accent);
}
.when {
  padding-top: 1px;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  color: var(--text-dim);
}
.what h3 {
  margin: 8px 0 0;
  font-size: 17px;
  font-weight: 600;
}
.what p {
  margin: 4px 0 0;
  max-width: 620px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--text-soft);
}
.lean {
  display: grid;
  grid-template-columns: 1fr 1.6fr;
  gap: 40px;
  align-items: center;
}
.lean-stats p {
  margin: 4px 0 18px;
  font-size: 15px;
  color: var(--text-soft);
}
.big {
  font-size: 22px;
  font-weight: 600;
  color: var(--text);
}
.big span {
  margin-right: 6px;
  font-size: 64px;
  font-weight: 800;
  line-height: 1;
  letter-spacing: -0.03em;
  background: var(--aw-grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.cta {
  margin-top: 112px;
  text-align: center;
}
.cta .actions {
  justify-content: center;
}

@media (max-width: 960px) {
  .reasons {
    grid-template-columns: 1fr;
  }
  .lean {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  .hero,
  .compare {
    grid-template-columns: 1fr;
  }
  .hero-art {
    flex-direction: column;
    align-items: center;
    padding-bottom: 0;
  }
  .window {
    position: relative;
    left: auto;
    right: auto;
    width: 100%;
    margin-top: -64px;
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
  .timeline li {
    grid-template-columns: 1fr;
    gap: 2px;
  }
  .install {
    max-width: 100%;
  }
}
</style>
