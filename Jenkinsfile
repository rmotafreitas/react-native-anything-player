// CI for react-native-anything-player on the self-hosted Jenkins (apps that
// pin the library as a submodule consume the package this job archives).
//
// Runs the JS layer's checks with the repo-pinned Yarn (lint, typecheck, unit
// tests with their coverage thresholds), builds the library and archives the
// npm package built from this commit as `react-native-anything-player.tgz`.
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
    timeout(time: 30, unit: 'MINUTES')
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '10', artifactNumToKeepStr: '20'))
    // One build at a time on this host: the lock is shared with the other jobs on it.
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
    stage('Quality and build') {
      agent {
        docker {
          // Matches .nvmrc.
          image 'node:24-bookworm'
          args '-u root -v animu-node-cache:/opt/animu-cache -e CI_CACHE_DIR=/opt/animu-cache'
        }
      }
      steps {
        sh '''
          set -eux
          git config --global --add safe.directory "$WORKSPACE"
          rm -rf coverage junit.xml
          . scripts/ci-cache.sh
          corepack enable
          echo "node $(node --version) / yarn $(yarn --version)"
          yarn install --immutable
          yarn run check:ci
          yarn pack --out react-native-anything-player.tgz
          test -f lib/module/index.js
          ls -la react-native-anything-player.tgz
        '''
        sh 'node scripts/ci-results.mjs publish rmotafreitas/react-native-anything-player'
        archiveArtifacts artifacts: 'ci-results.json', fingerprint: true
        archiveArtifacts artifacts: 'react-native-anything-player.tgz', fingerprint: true
      }
      post {
        always {
          junit testResults: 'junit.xml', allowEmptyResults: false
          archiveArtifacts artifacts: 'coverage/**', allowEmptyArchive: true
        }
      }
    }
  }

  post {
    failure { echo 'react-native-anything-player build failed.' }
  }
}
