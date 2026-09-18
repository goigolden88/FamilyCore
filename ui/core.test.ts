import { describe, expect, it } from 'vitest'
import { createDb } from '../core/db.ts'
import { createSync } from '../core/sync.ts'
import { shelf } from '../testing/shelf.ts'
import type { Core } from './core.tsx'

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
})
