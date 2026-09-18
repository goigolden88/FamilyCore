/**
 * Service worker приложения.
 *
 * Свой файл, а не собранный плагином: в нём будут напоминания (Р-14 «Делу Время»).
 * Без сервера веб-пуш невозможен, и остаётся периодическая фоновая
 * синхронизация — браузер сам будит работника примерно раз в сутки.
 * Работает в Chrome на Android у установленного приложения; на остальных
 * событие просто не придёт.
 *
 * Всё прочее здесь повторяет то, что раньше было опциями `generateSW`,
 * и ломать это нельзя: автообновление — главный риск Этапа 0.
 *
 * Приём из «Поделиться» сюда не входит (Р-16 «Делу Время»): это обычная навигация,
 * и её отдаёт подмена навигации ниже. Разбор адреса — в `src/launch.ts`.
 */

import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { remind, REMINDER_TAG } from './notify.ts'

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

// autoUpdate: новый работник забирает управление сразу, не дожидаясь, пока
// закроются все вкладки. Иначе телефон неделю показывает вчерашнюю сборку.
void self.skipWaiting()
clientsClaim()

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Без подмены навигации открытие без сети по прямой ссылке даёт пустую
// страницу: запрос уходит в сеть, сети нет, показать нечего. В разработке
// index.html в кеше нет, и подмена упала бы на старте работника.
if (!import.meta.env.DEV) {
  registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))
}

// Напоминание о незаполненном дне (Р-14 «Делу Время», Р-24 «Делу Время»): браузер будит проверку
// сам, примерно раз в сутки. Имя проверки после выпуска не меняется.
self.addEventListener('periodicsync', (event) => {
  if (event.tag !== REMINDER_TAG) return
  event.waitUntil(remind(self.registration))
})

// Тап по уведомлению открывает приложение там, куда уведомление зовёт.
// Уже открытое приложение переводится туда же, а не открывается второй копией.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data as { url?: unknown } | null
  const url = typeof data?.url === 'string' ? data.url : self.registration.scope
  event.waitUntil(openApp(url))
})

async function openApp(url: string): Promise<unknown> {
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const open = windows[0]
  if (!open) return self.clients.openWindow(url)
  await open.focus()
  return open.navigate(url)
}
