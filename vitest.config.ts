import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Pin discovery to this package so a workspace-root config can't hijack it.
    root: __dirname,
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
