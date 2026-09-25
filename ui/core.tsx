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
import type { KeyValue, Origin, Snapshot } from '../core/db.ts'
import type { AppConfig, Base, StoreMap } from '../core/model.ts'
import type { Sync } from '../core/sync.ts'
import { startFolds } from './useFold.ts'

/**
 * Событие базы — то, что из него видит общий интерфейс: имя хранилища строкой.
 *
 * Не `ChangeEvent` из `core/db.ts`: он обобщён по таблице хранилищ, и
 * компилятор сравнивает `ChangeEvent<R>` приложения с `ChangeEvent<StoreMap>`
 * по параметру, а не по полям. Из-за `keyof R` он требует `StoreMap` не уже
 * таблицы приложения — и `db` любого настоящего приложения сюда не подходил,
 * хотя по полям событие то же. Проверка — `ui/core.test.ts`.
 */
type SharedChangeEvent = {
  store: string
  origin: Origin
  count: number
}

/** База — то, чем пользуется общий интерфейс. */
export type SharedDb = {
  settings: KeyValue
  ready(): Promise<void>
  count(store: string): Promise<number>
  onChange(listener: (event: SharedChangeEvent) => void): () => void
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
  /** Нет — у приложения нет синхронизации (метаприложение, Я-23): состояние «выключено» (Я-29). */
  sync?: Sync
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

/**
 * Синхронизация для того, без чего она не имеет смысла, — «Настроек
 * синхронизации». Нет её — ошибка кода приложения, а не пустые поля (Я-29).
 */
export function syncOf(core: Core): Sync {
  if (!core.sync) {
    throw new Error(
      'Настройки синхронизации поставлены в приложение без синхронизации: ' +
        'sync не передан в <CoreProvider> — убери их с экрана или передай sync',
    )
  }
  return core.sync
}
