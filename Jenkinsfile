// CI for react-native-airwave — the native audio player compiled into the
// Animu mobile app (pinned there as the packages/react-native-airwave
// submodule).
//
// Runs the JS layer's checks with the repo-pinned Yarn (lint, typecheck, unit
// tests with their coverage thresholds), builds the library and archives the
// npm package built from this commit as `react-native-airwave.tgz`.
//
// The native engines' conformance suites need Xcode (Swift) and the Android SDK
// (Kotlin); they run in GitHub Actions (.github/workflows/ci.yml).

pipeline {
  // agent none so the shared lock is taken before an executor is allocated.
  agent none

  // A parameter (even a free-text one) makes Jenkins expose this job via
  // "Build with Parameters" so it gets a parameterized play button like the
  // other jobs. It has no effect on the build.
  parameters {
    string(name: 'NOTE', defaultValue: '', description: 'Optional note for this run (unused).')
  }

  options {
    timestamps()
    timeout(time: 20, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '10', artifactNumToKeepStr: '20'))
    // Share the lock with the Animu jobs (same physical host).
    lock('animu-build-host')
  }

  environment {
    CI = 'true'
    // Never prompt when corepack fetches the pinned Yarn.
    COREPACK_ENABLE_DOWNLOAD_PROMPT = '0'
  }

  stages {
    // One stage, one container: with agent none each stage would otherwise get
    // a fresh container and lose the install between stages. The package is
    // archived here, not in `post`: with agent none, post has no node context.
    stage('Build') {
      agent {
        docker {
          // Matches .nvmrc.
          image 'node:24-bookworm'
          args '-u root'
        }
      }
      steps {
        sh '''
          set -eux
          git config --global --add safe.directory "$WORKSPACE"
          corepack enable
          echo "node $(node --version) / yarn $(yarn --version)"
          yarn install --immutable
          yarn lint
          yarn typecheck
          yarn test --coverage
          yarn prepare
          yarn pack --out react-native-airwave.tgz
          test -f lib/module/index.js
          ls -la react-native-airwave.tgz
        '''
        archiveArtifacts artifacts: 'react-native-airwave.tgz', fingerprint: true
      }
    }
  }

  post {
    failure { echo 'react-native-airwave build failed.' }
  }
}
