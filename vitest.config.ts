import { defineConfig } from 'vitest/config'

// Свой конфиг тестов, а не vite.config.ts: у ядра нет сборки, а конфиг Vite
// приложения ядру не принадлежит. Тесты — в node, IndexedDB подставляет
// fake-indexeddb в самих тестах.
export default defineConfig({
  test: {
    include: ['core/**/*.test.ts', 'ui/**/*.test.ts', 'screens/**/*.test.ts', '*.test.ts'],
  },
})
