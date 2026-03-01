import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/build/**', '**/bin/**'],
    coverage: {
      provider: 'v8',
      thresholds: {
        lines: 60,
        branches: 50,
      },
    },
  },
})
