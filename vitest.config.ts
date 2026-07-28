import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // Node by default. Only the two page tests need a DOM, and standing jsdom
    // up for the ~34 pure-logic suites cost more than running them. Those two
    // opt in with a `@vitest-environment jsdom` docblock — `environmentMatchGlobs`
    // was removed in Vitest 4, so the docblock is the supported way to do this.
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
