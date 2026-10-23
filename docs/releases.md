# Versioning and releases

RNAP follows [Semantic Versioning](https://semver.org/): versions are `MAJOR.MINOR.PATCH`, and an upgrade within the same major never breaks an app. The [changelog](../CHANGELOG.md) lists every release.

**1.0.0** is the version the [Rádio Animu](https://www.animu.moe) app shipped in its v4.0.1 (October 2026), after running it in production. Earlier development versions (named `react-native-airwave`) are not part of this history.

## What a version number promises

| Release | When | Examples |
|---|---|---|
| **Major** (`2.0.0`) | Something an app relies on changes or goes away | a public export removed or renamed; a documented behaviour changed (a state, an event's timing, a recovery rule); a default an app can observe changed; a minimum platform raised |
| **Minor** (`1.2.0`) | Something is added; nothing breaks | a new method, option, event, status field, error code, route kind or platform; a new opt-in build flag; a deprecation |
| **Patch** (`1.1.1`) | Something is fixed to work as documented | a bug fix; a dependency patch; a documentation fix |

New values in an open set are minor: a new error code, `route.kind`, `interruption.reason` or `CastState`. Handle unknown values (a `default` branch).

### What is the public API

Covered by the promise:

- Everything exported from `react-native-anything-player`, `react-native-anything-player/web` and `react-native-anything-player/react`, with its types (the [API reference](api/)).
- `PlayerStatus` fields, event names and payloads, error codes, and the behaviour the guides document. The engine's behaviour is pinned by the [conformance suite](../conformance/README.md): changing an expected outcome there is a behaviour change.
- The Expo plugin's options, and the native setup names: Gradle properties (`rnapHls`, `rnapCast`, `rnapMedia3Version`), `RNAP_CAST` / `rnap.cast`, manifest meta-data and `Info.plist` keys (`com.anythingplayer.*`, `RNAPCastReceiverId`), `AnythingPlayer.handleIntent` and `RNAPVoice`.
- The CLI's commands, flags, finding ids, exit codes and `--json` schema.

Not covered: anything not exported (`src/core`, `src/web/platform`, the TurboModule spec), error *messages*, free-text fields (`reconnect.reason`, the diagnostics trace's `event` and `details`), log output, and the file layout.

## Deprecations

A deprecated API keeps working until the next major, with at least one minor release in between:

1. A minor release marks it `@deprecated` in its TSDoc (editors strike it through), names the replacement, and lists it under **Deprecated** in the changelog. In development builds it warns once in the console.
2. The next major removes it, listed under **Removed**, with upgrade notes.

## Supported platforms

| | Minimum |
|---|---|
| React Native | 0.80, New Architecture |
| Expo | an SDK with React Native ≥ 0.80 (development build or Expo web) |
| iOS | 15.1 (Siri shortcuts: 16) |
| Android | 7.0 (API 24) |
| Browsers | the current and previous version of Chrome / Edge, Firefox and Safari (iOS 17.1+ for radio titles) |
| Desktop | not a supported platform yet: Electron and Tauri run the web engine, untested ([Desktop](desktop.md)) |
| Node (CLI) | 20 |

Raising a minimum is a major release, unless the platform itself has stopped working on it (a store requirement, or a React Native release that drops it), which is called out in the changelog.

Fixes land on `main` and ship in the next release. There are no maintenance branches for older majors yet. Security fixes follow [SECURITY.md](../SECURITY.md).

## How a release is made

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/), and [release-please](https://github.com/googleapis/release-please) turns them into releases:

1. Every push to `main` updates an open **release pull request** with the next version and the changelog entries since the last release.
2. Before merging it, the maintainer checks the wording of the entries (they are written for app developers, not as commit logs), that CI is green on `main`, and, for native changes, the [hardware checklist](testing.md).
3. Merging it bumps `package.json`, updates `CHANGELOG.md`, tags `vX.Y.Z` and publishes the GitHub Release.

The commit type decides the version and the changelog section:

| Commit | Version | Changelog |
|---|---|---|
| `feat: …` | minor | Added |
| `fix: …` | patch | Fixed |
| `perf: …`, `deps: …`, `revert: …` | patch | Changed |
| `feat!: …`, or a `BREAKING CHANGE:` footer | major | the entry, plus upgrade notes in the release |
| `docs`, `test`, `ci`, `build`, `chore`, `refactor` | none on their own | not listed |

A breaking change states in its footer what changes for apps and how to migrate; the release notes repeat it.

The package is not on npm yet: releases are tags and GitHub Releases. Apps install it from the repository (as Rádio Animu does) until it is published.

## Housekeeping

- **Dependencies.** Dependabot opens weekly grouped updates for npm and the GitHub Actions (pinned by commit SHA). React Native, React and the toolchain majors are upgraded by hand, with the example apps. `yarn check:audit` fails on known advisories; `yarn.lock` and the Expo example's `package-lock.json` are installed frozen in CI, so a dependency change commits its lockfile.
- **Quality gates.** Every pull request runs the [quality gates](quality-gates.md): lint, types, the API reference, unit tests and coverage floors, React Doctor, the engine conformance suite on all three engines, native builds (Cast on and off), and the web end-to-end tests in Chromium, Firefox and WebKit.
- **Docs.** A change that adds or changes a feature updates its guide, the [feature matrix](features.md) and, when it lands on the roadmap, the [roadmap](roadmap.md). The changelog itself comes from the commit messages.
- **Security.** Vulnerabilities are reported privately, as described in [SECURITY.md](../SECURITY.md).
