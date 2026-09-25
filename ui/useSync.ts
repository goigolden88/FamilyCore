/**
 * Состояние синхронизации для React.
 *
 * Само состояние живёт в синхронизации приложения (`createSync`) и переживает
 * смену экранов: проход идёт по таймеру и не привязан к тому, открыты ли
 * «Настройки». Сюда она приходит контекстом (Я-03). Приложение без
 * синхронизации её не даёт — тогда состояние всегда «выключено» (Я-29).
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { Sync, SyncStatus } from '../core/sync.ts'
import { useCore } from './core.tsx'

type StatusSource = Pick<Sync, 'subscribe' | 'getStatus' | 'refreshStatus'>

const OFF: SyncStatus = {
  state: 'off',
  pending: 0,
  lastAt: null,
  error: '',
  badToken: false,
  deferred: false,
}

/** Один на всех: `useSyncExternalStore` сравнивает подписку и снимок по ссылке. */
const NO_SYNC: StatusSource = {
  subscribe: () => () => {},
  getStatus: () => OFF,
  refreshStatus: async () => OFF,
}

/** Откуда брать состояние: синхронизация приложения или «выключено». */
export function statusSource(sync: Sync | undefined): StatusSource {
  return sync ?? NO_SYNC
}

export function useSyncStatus(): SyncStatus {
  const source = statusSource(useCore().sync)
  const status = useSyncExternalStore(source.subscribe, source.getStatus, source.getStatus)

  // Пересчёт при появлении на экране: очередь могла вырасти, пока смотрели
  // другую вкладку, а событий состояния при этом не было.
  useEffect(() => {
    void source.refreshStatus()
  }, [source])

  return status
}
