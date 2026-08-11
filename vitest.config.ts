import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    // Unit tests must be hermetic. Connectors take an injectable `fetchImpl`
    // and every parser test runs against fixtures/, never the network. A test
    // that reaches the internet is a bug: PubMed and Crossref both rate-limit,
    // and CI would flake on someone else's outage.
    passWithNoTests: true,
  },
});
