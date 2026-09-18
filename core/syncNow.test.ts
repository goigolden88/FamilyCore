import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shelf } from '../testing/shelf.ts'
import { createDb } from './db.ts'
import { createSync } from './sync.ts'

/**
 * `syncNow` поверх настоящей базы, на подделанном IndexedDB. Сам проход
 * проверен в sync.test.ts на портах; здесь — то, что живёт вокруг него:
 * состояние для экрана и повторный вызов.
 *
 * Приложение — подставная «Полка» (`testing/shelf.ts`, Р-47 «Трапезы»).
 */

const db = createDb(shelf)
const { getStatus, saveConfig, syncNow } = createSync(shelf, db)

beforeEach(async () => {
  await db.close().catch(() => {})
  globalThis.indexedDB = new IDBFactory()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await db.close().catch(() => {})
})

describe('syncNow', () => {
  it('включённая после старта синхронизация идёт в сеть без перезапуска приложения', async () => {
    // Проход на старте: синхронизация ещё не настроена — это не ошибка.
    expect(await syncNow()).toBeNull()
    expect(getStatus().state).toBe('off')

    // Человек включил её в «Настройках» и нажал «Синхронизировать».
    await saveConfig({ enabled: true, repo: 'me/data', token: 'github_pat_x' })
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', fetch)

    await syncNow()
    expect(fetch).toHaveBeenCalled()
    expect(getStatus().error).toBe('Нет связи с GitHub. Отправка отложена до сети')
  })
})
