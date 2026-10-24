// Every docs page with its sidebar label and the summary that search engines
// and link previews show. The sidebar, the meta tags and the social cards
// (scripts/og-images.mts) all read this list, so they cannot drift apart.

export interface DocPage {
  link: string;
  text: string;
  /** ≤ 160 characters: Google truncates longer snippets. */
  description: string;
  /** The markdown file, when it is not `<link>.md` (a rewritten page). */
  source?: string;
}

export interface DocSection {
  text: string;
  items: DocPage[];
}

export const HOME = {
  description:
    'React Native audio player for files, streams and internet radio that keeps playing through dead sockets, network switches, phone calls and frozen JavaScript.',
};

export const SECTIONS: DocSection[] = [
  {
    text: 'Start here',
    items: [
      {
        link: '/docs/why',
        text: 'Why RNAP',
        description:
          'Why RNAP exists: React Native Track Player 5 went commercial, and keeping a radio stream alive through network drops and phone calls took app code.',
      },
      {
        link: '/docs/getting-started',
        text: 'Getting started',
        description:
          'Install React Native Anything Player in a React Native or Expo app (New Architecture, iOS 15.1+, Android 7+) and play your first stream.',
      },
      {
        link: '/docs/features',
        text: 'Feature matrix',
        description:
          'What works where: iOS, Android, Expo web, React Native Web, React (Vite, Next.js) and plain web pages, feature by feature, with the limits of each.',
      },
      {
        link: '/docs/comparison',
        text: 'Comparison & benchmarks',
        description:
          'RNAP vs React Native Track Player, expo-audio, expo-av and others: built-in capabilities, npm size, native code and Android dependencies, measured.',
      },
    ],
  },
  {
    text: 'Migrating',
    items: [
      {
        link: '/docs/migrating-from-track-player',
        text: 'From Track Player',
        description:
          'Move from react-native-track-player 4 or 5 to RNAP: API and event mapping, lock-screen controls, the queue gap and the reconnect code you can delete.',
      },
      {
        link: '/docs/migrating-from-expo-audio',
        text: 'From expo-audio',
        description:
          'Move from expo-audio to RNAP: player, status and lock-screen mapping, plugin changes, and the retry and NetInfo code you can delete.',
      },
      {
        link: '/docs/migrating-from-expo-av',
        text: 'From expo-av',
        description:
          'Move from expo-av Audio.Sound to RNAP: status and audio-mode mapping, background and lock-screen playback, and the reconnect code you can delete.',
      },
    ],
  },
  {
    text: 'Guides',
    items: [
      {
        link: '/docs/playback',
        text: 'Playback',
        description:
          'Load URLs, assets and local files, control playback, read progress and run several players at once with the RNAP React Native audio API.',
      },
      {
        link: '/docs/internet-radio',
        text: 'Internet radio & ICY',
        description:
          'Internet radio in React Native: Icecast and Shoutcast streams, ICY now-playing metadata, the live edge and automatic reconnects with RNAP.',
      },
      {
        link: '/docs/background-and-system',
        text: 'Background & system',
        description:
          'Background audio in React Native: lock screen and notification controls, audio focus, phone calls and other interruptions, and iOS media services resets.',
      },
      {
        link: '/docs/routes-and-casting',
        text: 'Casting & AirPlay',
        description:
          'Google Cast, AirPlay and the system output picker in React Native and on the web: where the audio goes, the Cast button, and what casting keeps working.',
      },
      {
        link: '/docs/video',
        text: 'Video',
        description:
          'Video in React Native and on the web: a picture for the same Player, qualities on bad networks, Picture in Picture, fullscreen, AirPlay and Cast.',
      },
      {
        link: '/docs/subtitles',
        text: 'Subtitles',
        description:
          "Subtitles in React Native and on the web: SubRip, WebVTT, TTML and ASS files, a stream's own tracks, the user's caption style, and drawing them yourself.",
      },
      {
        link: '/docs/sound',
        text: 'Sound effects',
        description:
          'Play short effects with low latency in React Native and on the web: many copies at once, volume, rate and pan, mixed with other audio, no media session.',
      },
      {
        link: '/docs/voice',
        text: 'Voice assistants',
        description:
          'Let Siri, Google Assistant and Gemini play your stations and episodes, even with the app closed, and the same catalog search on the web.',
      },
      {
        link: '/docs/cars-and-watches',
        text: 'Cars & watches',
        description:
          'Browse and play your catalog in CarPlay, Android Auto, Android Automotive OS and on watches: groups, favorites, recently played, and what each platform needs.',
      },
      {
        link: '/docs/web',
        text: 'Web',
        description:
          'RNAP on the web: Expo web, React Native Web and plain pages, with ICY metadata over MSE, automatic recovery, the Media Session and autoplay handling.',
      },
      {
        link: '/docs/desktop',
        text: 'Desktop',
        description:
          'RNAP in desktop apps: Electron and Tauri run its web engine today, with what each OS web view supports. Native macOS and Windows are on the roadmap.',
      },
      {
        link: '/docs/visualizer',
        text: 'Visualizer',
        description:
          'Stream the decoded audio RNAP is playing to JavaScript for oscilloscopes, level meters and spectrum views. Off by default and free while off.',
      },
    ],
  },
  {
    text: 'Reference',
    items: [
      {
        link: '/docs/events',
        text: 'Status & events',
        description:
          "RNAP's player status snapshot and events (state, progress, metadata, errors), with their ordering guarantees and the threads they arrive on.",
      },
      {
        link: '/docs/errors',
        text: 'Errors',
        description:
          'Every RNAP PlayerError code, which errors the engine recovers from on its own and which are fatal, and how to handle them in your app.',
      },
      {
        link: '/docs/configuration',
        text: 'Configuration',
        description:
          'RNAP player options and build-time settings: recovery limits, live drift, progress interval, Android HLS and Media3 version, and the Expo config plugin.',
      },
    ],
  },
  {
    text: 'Under the hood',
    items: [
      {
        link: '/docs/recovery',
        text: 'Recovery policy',
        description:
          'How RNAP recovers audio streams without app code: dead-socket and stall detection, network changes, backoff with jitter, and the failure behind each rule.',
      },
      {
        link: '/docs/architecture',
        text: 'Architecture',
        description:
          "RNAP's architecture: a native engine over AVPlayer on iOS and Media3 ExoPlayer on Android is the source of truth, exposed to React Native as a TurboModule.",
      },
      {
        link: '/docs/video-design',
        text: 'Video (design)',
        description:
          'The design of RNAP video: the same engine and recovery, OS players with remux, subtitles, Picture in Picture, quality on bad networks, every platform.',
      },
      {
        link: '/docs/testing',
        text: 'Testing',
        description:
          'How RNAP is tested: a shared Swift and Kotlin conformance suite, on-device scenarios on the iOS simulator and Android emulator, system behaviour and soaks.',
      },
      {
        link: '/docs/debugging',
        text: 'Debugging & FAQ',
        description:
          'Debug RNAP playback: read the native decision log, inspect the Android media session, fix common problems, and answers to frequent questions.',
      },
      {
        link: '/docs/cli',
        text: 'CLI: rnap',
        description:
          'npx rnap checks an app\'s setup and stream URLs, switches build modules with their size, writes bug reports and rewrites migrations, each change as a diff.',
      },
    ],
  },
  {
    text: 'Project',
    items: [
      {
        link: '/docs/roadmap',
        text: 'Roadmap',
        description:
          'Where RNAP stands against React Native Track Player and expo-audio, and what comes next: a queue, caching and preloading, and native desktop apps.',
      },
      {
        link: '/docs/changelog',
        source: 'CHANGELOG.md',
        text: 'Changelog',
        description:
          'Every RNAP release and what changed in it, from 1.0.0, the version the Rádio Animu app shipped, onwards.',
      },
      {
        link: '/docs/releases',
        text: 'Versioning & releases',
        description:
          'How RNAP versions work: what is a breaking change, deprecations, supported platforms, how releases are cut, and project housekeeping.',
      },
    ],
  },
];

export const PAGES: (DocPage & { section: string })[] = SECTIONS.flatMap((s) =>
  s.items.map((p) => ({ ...p, section: s.text }))
);
