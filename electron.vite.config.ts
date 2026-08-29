import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/** Native addons must stay unbundled; Vite cannot parse C++ `.node` binaries. */
const nativeExternals = ['better-sqlite3', /\.node$/];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
        external: nativeExternals,
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // The preload script runs in a sandboxed context that only supports CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
        external: nativeExternals,
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    worker: {
      format: 'es',
    },
    optimizeDeps: {
      include: ['monaco-editor'],
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer/src'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/renderer/index.html') },
        external: nativeExternals,
      },
    },
  },
});
