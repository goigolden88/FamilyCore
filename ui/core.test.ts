import { describe, expect, it } from 'vitest'
import { createDb } from '../core/db.ts'
import { createSync } from '../core/sync.ts'
import { shelf } from '../testing/shelf.ts'
import { syncOf, type Core } from './core.tsx'
import { statusSource } from './useSync.ts'

// Контекст общего интерфейса (Я-03) обязан принимать ядро любого приложения
// семьи как есть, без приведения типов: ровно это приложение кладёт в
// `<CoreProvider value={{ config, db, sync }}>`. Проверка — типами: её ловит
// `npm run typecheck`, а не Vitest. Тест здесь, чтобы она не потерялась.
//
// Нашла «Трапеза» при переводе (Журнал, 18.09.2026, сопровождение): её `db`
// не подходил под `SharedDb` из-за `ChangeEvent`, обобщённого по таблице
// хранилищ. База не открывается: фабрики ничего не делают до первого вызова.

describe('ядро «Полки» в контексте общего интерфейса', () => {
  it('config, db и sync подходят под Core без приведения', () => {
    const db = createDb(shelf)
    const sync = createSync(shelf, db)
    const core = { config: shelf, db, sync } satisfies Core

    expect(core.db).toBe(db)
  })

  // Я-29: приложение без синхронизации (метаприложение, Я-23) `sync` не даёт.
  it('без sync — тоже Core', () => {
    const db = createDb(shelf)
    const core = { config: shelf, db } satisfies Core

    expect(core.db).toBe(db)
  })
})

describe('приложение без синхронизации (Я-29)', () => {
  it('состояние — «выключено», подписка ничего не держит', async () => {
    const source = statusSource(undefined)
    expect(source.getStatus()).toEqual({
      state: 'off',
      pending: 0,
      lastAt: null,
      error: '',
      badToken: false,
      deferred: false,
    })
    expect(source.subscribe(() => {})).toBeTypeOf('function')
    expect((await source.refreshStatus()).state).toBe('off')
  })

  it('источник один и тот же: useSyncExternalStore не переподписывается', () => {
    expect(statusSource(undefined)).toBe(statusSource(undefined))
    expect(statusSource(undefined).getStatus()).toBe(statusSource(undefined).getStatus())
  })

  it('с синхронизацией — она сама', () => {
    const sync = createSync(shelf, createDb(shelf))
    expect(statusSource(sync)).toBe(sync)
  })

  it('настройки синхронизации без неё — внятная ошибка', () => {
    const core: Core = { config: shelf, db: createDb(shelf) }
    expect(() => syncOf(core)).toThrow(/без синхронизации/)
  })

  it('с синхронизацией syncOf отдаёт её', () => {
    const db = createDb(shelf)
    const sync = createSync(shelf, db)
    expect(syncOf({ config: shelf, db, sync })).toBe(sync)
  })
})
