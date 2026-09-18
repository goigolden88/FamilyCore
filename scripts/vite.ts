/**
 * Фабрика конфига Vite для приложения семьи (Р-48 «Трапезы»).
 *
 * Приложение даёт своё — адрес сайта, имя, описание, ярлыки, — а сборка,
 * работник и манифест собираются одинаково у всех. `vite.config.ts`
 * приложения — несколько строк:
 *
 *   import { defineConfig } from 'vite'
 *   import { familyVite } from './src/shared/scripts/vite.ts'
 *   export default defineConfig(familyVite({ base: '/Trapeza/', name: 'Трапеза', description: '…' }))
 *
 * Взято из `vite.config.ts` «Делу Время» с d86f0aa.
 */

import type { UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA, type ManifestOptions } from 'vite-plugin-pwa'

/** Цвет фона и строки состояния — общий у всей семьи, как фон иконок. */
export const THEME = '#1b1c1e'

export type FamilyApp = {
  /**
   * Адрес сайта на GitHub Pages: `/<имя репозитория>/`. Если его не выставить,
   * сборка пройдёт зелёной, а страница откроется белой: все скрипты уйдут
   * в 404. Симптом выглядит как сломанная сборка, причина — здесь
   * (Р-06 «Делу Время»).
   */
  base: string
  /** Имя в манифесте: подпись иконки и заголовок установленного приложения. */
  name: string
  /** Короткое имя под иконкой; нет — то же, что `name`. */
  shortName?: string
  description: string
  /**
   * Ярлыки по долгому тапу на иконке (Р-09 «Делу Время»): имя и адрес
   * с `base`. Адрес зашивается в установленное приложение на Android —
   * старый обязан работать и после любой правки.
   */
  shortcuts?: readonly { name: string; url: string }[]
  /** Остальное в манифесте, что есть не у всех: `share_target` у «Делу Время». */
  manifest?: Partial<ManifestOptions>
}

export function familyVite(app: FamilyApp): UserConfig {
  const BASE = app.base

  /** Иконка ярлыка. Без своей Android рисует пустую заглушку. */
  const SHORTCUT_ICON = { src: `${BASE}pwa-192x192.png`, sizes: '192x192', type: 'image/png' }

  return {
    base: BASE,

    define: {
      // Видно в настройках. Нужно, чтобы проверять обновление на телефоне,
      // не меняя каждый раз видимый текст ради теста.
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },

    plugins: [
      react(),

      VitePWA({
        // Service worker свой, а не собранный плагином: в нём будут
        // напоминания (Р-14 «Делу Время»), а в сгенерированный код их не положить.
        // Имя на выходе — sw.js, и меняться оно не должно никогда: иначе
        // установленные копии остались бы со старым работником навсегда.
        // Точка входа — `src/sw.ts` приложения; он зовёт `startWorker` ядра.
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',

        // autoUpdate, а не prompt: новый service worker забирает управление
        // немедленно и перезагружает страницу. Иначе выходит классическая
        // боль PWA — выкатил сборку, а телефон неделю показывает вчерашнюю
        // и ни на что не реагирует. Со своим работником половина этого —
        // skipWaiting и clientsClaim — написана в sw.ts ядра руками.
        registerType: 'autoUpdate',

        includeAssets: ['favicon.svg', 'apple-touch-icon-180x180.png'],

        manifest: {
          id: BASE,
          name: app.name,
          short_name: app.shortName ?? app.name,
          description: app.description,
          lang: 'ru',
          // Пути с base. При base '/' манифест соберётся, но иконка
          // на телефон не встанет — установка просто не предложится.
          start_url: BASE,
          scope: BASE,
          display: 'standalone',
          background_color: THEME,
          theme_color: THEME,
          icons: [
            { src: `${BASE}pwa-192x192.png`, sizes: '192x192', type: 'image/png' },
            { src: `${BASE}pwa-512x512.png`, sizes: '512x512', type: 'image/png' },
            {
              src: `${BASE}maskable-icon-512x512.png`,
              sizes: '512x512',
              type: 'image/png',
              purpose: 'maskable',
            },
          ],
          ...(app.shortcuts
            ? { shortcuts: app.shortcuts.map((shortcut) => ({ ...shortcut, icons: [SHORTCUT_ICON] })) }
            : {}),
          ...app.manifest,
        },

        // Что уходит в кеш для работы без сети. Подмена навигации на
        // index.html, чистка старых кешей и немедленный захват управления —
        // в sw.ts ядра: при generateSW это были опции здесь же.
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        },

        // Чтобы офлайн проверялся локально, а не только после деплоя.
        devOptions: { enabled: true, type: 'module', navigateFallback: 'index.html' },
      }),
    ],
  }
}
