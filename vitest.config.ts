import { defineConfig } from 'vitest/config'

// Standalone test config: without it vitest loads vite.config.ts and boots
// the devtools/nitro/start plugins, which are useless for unit tests and
// noisy (React CJS interop errors in the module runner).
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
