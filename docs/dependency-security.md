# Dependency security maintenance — 2026-10-12

Published fixes are installed through the lockfiles. No quality threshold is reduced.
Upstream has not published fixes for the advisories below; the installed packages
carry local patches, with executable regressions before dependency audits.
GitHub matches upstream versions and cannot detect these package-manager patches.
Alert reviews therefore link to the patch and its tests rather than claiming an
upstream fixed version exists. Remove the backports when upstream fixes ship.

| Advisory | Local mitigation | Regression |
| --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | `braces@3.0.3`: reject structural nesting at 128 levels before recursive walkers execute; validate direct ASTs and reject cycles | Normal nested expansion succeeds; 5,000-level patterns/ASTs and cyclic ASTs fail with a bounded SyntaxError instead of stack exhaustion |
| [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv) | `node-forge@1.4.0`: require the nested DigestAlgorithm sequence to contain exactly the OID and optional NULL, following [upstream PR 1152](https://github.com/digitalbazaar/forge/pull/1152) | Valid RSA signatures with/without NULL verify; extra nested NULL/garbage elements are rejected |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | `zod@3.25.76` (Expo CLI; no fixed 3.x): reject an array or set over its `.max()`/`.length()`/`.size()` bound before walking its elements, as [upstream 4.6.6](https://github.com/colinhacks/zod/pull/6652) does | Valid and per-element-invalid inputs keep their issues; a 100,000-element oversized input reports one `too_big` issue instead of one per element |
| [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) | RNAP only: `sprintf-js@1.0.3` clamps numeric precision to the ECMAScript range, 0–100 for exponential/fixed and 1–100 for precision | Ordinary formatting is preserved; oversized precision and zero significant digits no longer throw RangeError |

The app applies pnpm patches. RNAP applies Yarn patches to its tooling and
patch-package patches to its npm Expo example. The Expo example independently
installs with `npm ci`, tests both installed backports, and rejects any audit
advisory not covered by those tests. Download integrity remains pinned; the local
RNAP tarball is rebuilt from the checked-out source and has no static archive
integrity in the example lockfile, avoiding hashes from an older library build.

RNAP locks patched ActiveSupport/concurrent-ruby versions, uses Ruby 3.3, and runs
bundler-audit on its complete locked dependency graph. CocoaPods/Ruby caches include
the Ruby version and Gemfile.lock. Dependabot monitors both examples and Ruby gems.

React Native 0.86's presets use Babel 7 and support ESLint 8/9. RNAP's Babel 8 and
ESLint 10 proposals are deferred through scoped major-version rules. React/RN minor
upgrades require a coordinated native-template migration. Patch/security updates
continue. RNAP uses ESLint 9 and TypeScript 6. The package ships ESM only, and
`scripts/check-lib.mjs` checks the built ESM imports after every build.
