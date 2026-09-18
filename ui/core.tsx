/**
 * Ядро для общего интерфейса — React-контекстом (Я-03).
 *
 * Базу и синхронизацию создаёт приложение, в `src/app/core.ts`, по своему
 * конфигу. Хуки и компоненты ядра получают их отсюда: приложение один раз
 * оборачивает дерево в `<CoreProvider value={{ config, db, sync }}>`, и
 * `useFold(id)`, `<Fold>`, «Настройки синхронизации» работают без правки
 * вызовов. Чистые модули (`report.ts`, напоминания, работник) контекста не
 * видят — им база приходит аргументом.
 *
 * Типы здесь — то, чем общий интерфейс пользуется, без таблицы хранилищ
 * приложения: база и синхронизация любого приложения семьи сюда подходят.
 */

import { createContext, useContext, useState, type ReactNode } from 'react'
import type { ChangeEvent, KeyValue, Snapshot } from '../core/db.ts'
import type { AppConfig, Base, StoreMap } from '../core/model.ts'
import type { Sync } from '../core/sync.ts'
import { startFolds } from './useFold.ts'

/** База — то, чем пользуется общий интерфейс. */
export type SharedDb = {
  settings: KeyValue
  ready(): Promise<void>
  count(store: string): Promise<number>
  onChange(listener: (event: ChangeEvent) => void): () => void
  exportAll(): Promise<Snapshot>
  putMany(store: string, records: readonly Base[]): Promise<Base[]>
}

/** Конфиг — то, что из него нужно общему интерфейсу. */
export type SharedConfig = Pick<AppConfig<StoreMap>, 'name' | 'schemaVersion' | 'about'> & {
  stores: readonly string[]
}

export type Core = {
  config: SharedConfig
  db: SharedDb
  sync: Sync
}

const CoreContext = createContext<Core | null>(null)

export function CoreProvider({ value, children }: { value: Core; children: ReactNode }) {
  // Что свёрнуто, читается сразу при запуске, а не при первом блоке: экран
  // тогда рисуется уже с известным состоянием.
  useState(() => startFolds(value.db.settings))
  return <CoreContext.Provider value={value}>{children}</CoreContext.Provider>
}

/** Ядро приложения. Вне `CoreProvider` — внятная ошибка, а не молчаливый `undefined`. */
export function useCore(): Core {
  const core = useContext(CoreContext)
  if (!core) {
    throw new Error('Общий интерфейс ядра вызван вне <CoreProvider>: оберни дерево приложения в app.tsx')
  }
  return core
}
