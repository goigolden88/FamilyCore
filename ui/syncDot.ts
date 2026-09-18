/**
 * Точка на шестерёнке «Сегодня» — приём «Дневников». Синхронизация живёт
 * в фоне, и узнать о ней можно только в «Настройках»; точка говорит, что
 * туда стоит заглянуть: красная — что-то сломалось, серая — очередь не ушла.
 *
 * Отличие от «Дневников»: выключенная синхронизация точки не даёт. У неё
 * очередь не уходит никогда, и вечная точка у того, кто синхронизацию
 * не заводил, — шум, который приучает точку не замечать.
 */

import type { SyncStatus } from '../core/sync.ts'

export type SyncDot = '' | 'dot' | 'dot dot--error'

export function syncDot(status: Pick<SyncStatus, 'state' | 'pending'>): SyncDot {
  if (status.state === 'off') return ''
  if (status.state === 'error') return 'dot dot--error'
  return status.pending > 0 ? 'dot' : ''
}
