/**
 * Состояние синхронизации для React.
 *
 * Само состояние живёт в `core/sync.ts` и переживает смену экранов: проход
 * идёт по таймеру и не привязан к тому, открыты ли «Настройки».
 */

import { useEffect, useSyncExternalStore } from 'react'
import { getStatus, refreshStatus, subscribe } from '../core/sync.ts'
import type { SyncStatus } from '../core/sync.ts'

export function useSyncStatus(): SyncStatus {
  const status = useSyncExternalStore(subscribe, getStatus, getStatus)

  // Пересчёт при появлении на экране: очередь могла вырасти, пока смотрели
  // другую вкладку, а событий состояния при этом не было.
  useEffect(() => {
    void refreshStatus()
  }, [])

  return status
}
