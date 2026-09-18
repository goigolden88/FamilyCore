/**
 * Состояние синхронизации для React.
 *
 * Само состояние живёт в синхронизации приложения (`createSync`) и переживает
 * смену экранов: проход идёт по таймеру и не привязан к тому, открыты ли
 * «Настройки». Сюда она приходит контекстом (Я-03).
 */

import { useEffect, useSyncExternalStore } from 'react'
import type { SyncStatus } from '../core/sync.ts'
import { useCore } from './core.tsx'

export function useSyncStatus(): SyncStatus {
  const { sync } = useCore()
  const status = useSyncExternalStore(sync.subscribe, sync.getStatus, sync.getStatus)

  // Пересчёт при появлении на экране: очередь могла вырасти, пока смотрели
  // другую вкладку, а событий состояния при этом не было.
  useEffect(() => {
    void sync.refreshStatus()
  }, [sync])

  return status
}
