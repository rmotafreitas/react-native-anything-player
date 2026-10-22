<!-- Title: a Conventional Commit, e.g. `feat(web): …` or `fix(android): …` (it becomes the changelog entry). -->

## What and why

## Checklist

- [ ] Works on iOS, Android **and** the web (Expo web / React Native Web, `/react`, `/web`), or the [feature matrix](../docs/features.md) says why not
- [ ] Engine behaviour changes come with conformance scenarios, passing on all three engines
- [ ] Tests for the change; `yarn check:quality` passes
- [ ] Docs updated (the guide, the feature matrix, the roadmap if it moves)
- [ ] Breaking? Marked `!` / `BREAKING CHANGE:` with upgrade notes ([what counts](../docs/releases.md#what-a-version-number-promises))
- [ ] Native changes: hardware checklist items noted ([Testing](../docs/testing.md))
