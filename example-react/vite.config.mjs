// The React DOM example: Vite + react-dom, no React Native. It imports the
// library's source (an app imports `react-native-anything-player/react`).
//
//   npx vite example-react            # dev server
//   npx vite build example-react      # → example-react/dist (the e2e tests serve it)
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  resolve: {
    alias: {
      'react-native-anything-player/react': path.resolve(
        root,
        '../src/react/index.ts'
      ),
    },
  },
  esbuild: { jsx: 'automatic' },
  build: { outDir: path.join(root, 'dist'), emptyOutDir: true },
});
