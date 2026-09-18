/**
 * Service worker приложения — общая часть.
 *
 * Свой файл, а не собранный плагином: в нём напоминания (Р-14 «Делу Время»).
 * Без сервера веб-пуш невозможен, и остаётся периодическая фоновая
 * синхронизация — браузер сам будит работника примерно раз в сутки.
 * Работает в Chrome на Android у установленного приложения; на остальных
 * событие просто не придёт.
 *
 * Всё прочее здесь повторяет то, что раньше было опциями `generateSW`,
 * и ломать это нельзя: автообновление — главный риск Этапа 0.
 *
 * Приём из «Поделиться» и ярлыки сюда не входят (Р-16 «Делу Время»): это
 * обычная навигация, и её отдаёт подмена навигации ниже. Разбор адреса —
 * в `src/launch.ts` приложения.
 *
 * Работника собирает приложение: его `src/sw.ts` — точка входа
 * `injectManifest` — зовёт `startWorker` со своим напоминанием. О чём
 * напоминать, ядро не знает (Р-48 «Трапезы»).
 */

import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { REMINDER_TAG } from './notify.ts'

/**
 * Ровно то, чем работник пользуется. Библиотека типов `webworker` целиком
 * спорит с `DOM`, на котором собрано остальное приложение, а заводить ради
 * одного файла второй tsconfig — дороже десяти строк ниже.
 */
type Extendable = Event & { waitUntil(promise: Promise<unknown>): void }

type Scope = {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>
  registration: ServiceWorkerRegistration
  skipWaiting(): Promise<void>
  clients: {
    matchAll(options: {
      type: 'window'
      includeUncontrolled: boolean
    }): Promise<readonly { focus(): Promise<unknown>; navigate(url: string): Promise<unknown> }[]>
    openWindow(url: string): Promise<unknown>
  }
  addEventListener(
    type: 'periodicsync',
    listener: (event: Extendable & { tag: string }) => void,
  ): void
  addEventListener(
    type: 'notificationclick',
    listener: (event: Extendable & { notification: Notification }) => void,
  ): void
}

declare const self: Scope

/**
 * Запускает работника. Зовётся один раз, из `src/sw.ts` приложения.
 *
 * `remind` — проверка напоминания приложения: `reminders.remind` из его
 * `src/notify.ts` (`createReminders`).
 */
export function startWorker(options: {
  remind: (registration: ServiceWorkerRegistration) => Promise<unknown>
}): void {
  // autoUpdate: новый работник забирает управление сразу, не дожидаясь, пока
  // закроются все вкладки. Иначе телефон неделю показывает вчерашнюю сборку.
  void self.skipWaiting()
  clientsClaim()

  cleanupOutdatedCaches()
  // `self.__WB_MANIFEST` вписывает сборка приложения (`injectManifest`) — она
  // ищет эту строку в собранном работнике, куда этот файл входит целиком.
  precacheAndRoute(self.__WB_MANIFEST)

  // Без подмены навигации открытие без сети по прямой ссылке даёт пустую
  // страницу: запрос уходит в сеть, сети нет, показать нечего. В разработке
  // index.html в кеше нет, и подмена упала бы на старте работника.
  if (!import.meta.env.DEV) {
    registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))
  }

  // Напоминание (Р-14, Р-24 «Делу Время»): браузер будит проверку сам,
  // примерно раз в сутки. Имя проверки после выпуска не меняется.
  self.addEventListener('periodicsync', (event) => {
    if (event.tag !== REMINDER_TAG) return
    event.waitUntil(options.remind(self.registration))
  })

  // Тап по уведомлению открывает приложение там, куда уведомление зовёт.
  // Уже открытое приложение переводится туда же, а не открывается второй копией.
  self.addEventListener('notificationclick', (event) => {
    event.notification.close()
    const data = event.notification.data as { url?: unknown } | null
    const url = typeof data?.url === 'string' ? data.url : self.registration.scope
    event.waitUntil(openApp(url))
  })
}

async function openApp(url: string): Promise<unknown> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows[0]
  if (!open) return self.clients.openWindow(url)
  await open.focus()
  return open.navigate(url)
}
