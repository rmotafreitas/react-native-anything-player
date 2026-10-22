# Security policy

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: **Security → Report a vulnerability** on [the repository](https://github.com/rmotafreitas/react-native-anything-player/security/advisories/new). Include what is affected (platform, version), how to reproduce it, and the impact you see.

You will get an answer within a week. Once a fix is ready, it ships in a patch release, the advisory is published with credit to the reporter (unless you prefer otherwise), and the changelog links to it.

## Supported versions

Security fixes go into the latest release of the current major version (see [Versioning and releases](docs/releases.md)).

## Scope

The library, its Expo config plugin, the `rnap` CLI, and the example apps and test servers in this repository. The test stream server (`scripts/stream-server`) is a development tool meant for localhost; issues that need it to be exposed to a network are out of scope.
