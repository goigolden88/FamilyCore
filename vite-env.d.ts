/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Время сборки, подставляется в vite.config.ts.
 *
 * Нужно, чтобы проверить обновление service worker на телефоне: открыл
 * настройки, посмотрел дату сборки — видно, приехала новая версия или нет.
 * Иначе для проверки приходится каждый раз менять видимый текст.
 */
declare const __BUILD_TIME__: string

/**
 * Периодическая фоновая синхронизация (Р-50). В стандартных типах её нет:
 * API есть только в Chromium. Поле необязательное нарочно — код обязан
 * проверить, что оно есть, прежде чем звать.
 */
interface PeriodicSyncManager {
  register(tag: string, options?: { minInterval?: number }): Promise<void>
  unregister(tag: string): Promise<void>
  getTags(): Promise<string[]>
}

interface ServiceWorkerRegistration {
  readonly periodicSync?: PeriodicSyncManager
}
