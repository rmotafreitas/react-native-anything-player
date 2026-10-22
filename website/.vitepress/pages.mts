// Every docs page with its sidebar label and the summary that search engines
// and link previews show. The sidebar, the meta tags and the social cards
// (scripts/og-images.mts) all read this list, so they cannot drift apart.

export interface DocPage {
  link: string;
  text: string;
  /** ≤ 160 characters: Google truncates longer snippets. */
  description: string;
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
        link: '/docs/voice',
        text: 'Voice assistants',
        description:
          'Let Siri, Google Assistant and Gemini play your stations and episodes, even with the app closed, and the same catalog search on the web.',
      },
      {
        link: '/docs/web',
        text: 'Web',
        description:
          'RNAP on the web: Expo web, React Native Web and plain pages, with ICY metadata over MSE, automatic recovery, the Media Session and autoplay handling.',
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
        text: 'CLI: doctor & init',
        description:
          'npx react-native-anything-player doctor checks an app\'s setup, native build and stream URLs; init applies the safe fixes, each shown as a diff.',
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
          'Where RNAP stands against React Native Track Player and expo-audio, and what comes before 1.0: queues, CarPlay and Android Auto, Cast and more.',
      },
    ],
  },
];

export const PAGES: (DocPage & { section: string })[] = SECTIONS.flatMap((s) =>
  s.items.map((p) => ({ ...p, section: s.text }))
);
