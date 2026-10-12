import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shelfConfig, shelfDemo } from '../testing/shelf.ts'
import { DEMO_OFFERED, enterDemo, leaveDemo } from './demo.ts'
import { createDb } from '../core/db.ts'
import { checkDemo, demoDbName, demoKey, isDemo, setDemoFlag, showDemoOffer, type FlagStorage } from '../core/demo.ts'
import { checkConfig } from '../core/model.ts'
import { createSync } from '../core/sync.ts'

/**
 * Демо-данные (Я-44, Я-45): своя база без синхронизации, признак, вход и
 * выход, предложение, сторож полноты.
 *
 * Главное, что проверяется, — демо не трогает настоящую базу и не зовёт
 * сеть. Приложение — подставная «Полка» с демо; `localStorage` — свой,
 * в памяти: в node его нет.
 */

const config = shelfConfig({ demo: shelfDemo })
const DAY = '2026-10-12'

function memoryStorage(): FlagStorage & { size: () => number } {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, String(value)),
    removeItem: (key) => void items.delete(key),
    size: () => items.size,
  }
}

async function baseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((info) => info.name ?? '').sort()
}

const opened: { close(): Promise<void> }[] = []

function open(demo: boolean) {
  const db = createDb(config, { demo })
  opened.push(db)
  return db
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
})

afterEach(async () => {
  for (const db of opened.splice(0)) await db.close().catch(() => {})
  vi.unstubAllGlobals()
})

describe('имена и признак', () => {
  it('демо-база и ключ — с dbName', () => {
    expect(demoDbName('polka')).toBe('polka-demo')
    expect(demoKey('polka')).toBe('polka:demo')
  })

  it('признак включает демо только приложению с функцией demo', () => {
    const storage = memoryStorage()
    expect(isDemo(config, storage)).toBe(false)
    setDemoFlag('polka', true, storage)
    expect(isDemo(config, storage)).toBe(true)
    expect(isDemo(shelfConfig(), storage)).toBe(false)
    setDemoFlag('polka', false, storage)
    expect(isDemo(config, storage)).toBe(false)
  })

  it('нет localStorage (работник, node) — не демо', () => {
    expect(isDemo(config, null)).toBe(false)
  })

  it('хранилище бросает — не демо, а не падение', () => {
    const broken: FlagStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(isDemo(config, broken)).toBe(false)
  })

  it('dbName с окончанием -demo конфиг не принимает: имя занято демо-базой', () => {
    expect(() => checkConfig(shelfConfig({ dbName: 'polka-demo' }))).toThrow(/-demo/)
  })
})

describe('демо-база', () => {
  it('открывается своя база, настоящая не создаётся', async () => {
    const db = open(true)
    await db.ready()
    expect(db.demo).toBe(true)
    expect(db.name).toBe('polka-demo')
    expect(await baseNames()).toEqual(['polka-demo'])
  })

  it('демо-записи лежат сразу после открытия — каждое хранилище', async () => {
    const db = open(true)
    for (const store of config.stores) expect(await db.count(store)).toBeGreaterThan(0)
    // Отправлять их некому — грязными не метятся.
    expect(await db.listDirty()).toEqual([])
  })

  it('записываются один раз — повторное открытие не удваивает', async () => {
    const first = open(true)
    const books = await first.count('books')
    await first.close()
    const again = open(true)
    expect(await again.count('books')).toBe(books)
  })

  it('настоящая база демо не видит, демо — настоящую', async () => {
    const real = open(false)
    await real.put('shelves', { id: 'real-1', updatedAt: '', name: 'Моя полка', order: 1 })
    const demo = open(true)
    expect((await demo.getAll('shelves')).map((shelf) => shelf.name)).not.toContain('Моя полка')
    expect(await real.count('books')).toBe(0)
    expect(real.demo).toBe(false)
  })

  it('у приложения без demo признак ничего не меняет', async () => {
    const db = createDb(shelfConfig(), { demo: true })
    opened.push(db)
    expect(db.demo).toBe(false)
    expect(db.name).toBe('polka')
  })

  it('упавшая функция демо — база не открывается, с внятной ошибкой', async () => {
    const broken = createDb(
      shelfConfig({
        demo: () => {
          throw new Error('нет книг')
        },
      }),
      { demo: true },
    )
    opened.push(broken)
    await expect(broken.ready()).rejects.toThrow(/Демо не собралось: нет книг/)
  })
})

describe('синхронизации в демо нет', () => {
  it('createSync на демо-базе падает, в сеть не идёт', () => {
    const fetch = vi.fn(() => Promise.reject(new Error('сеть')))
    vi.stubGlobal('fetch', fetch)
    const db = open(true)
    expect(() => createSync(config, db)).toThrow(/демо/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('на настоящей базе — как прежде', () => {
    expect(() => createSync(config, open(false))).not.toThrow()
  })
})

describe('вход и выход', () => {
  it('вход: признак и перезагрузка; демо собирается заново от дня входа', async () => {
    const storage = memoryStorage()
    const reload = vi.fn()

    // Прежнее демо с записью, сделанной в нём.
    const before = open(true)
    await before.put('quotes', { id: 'old', updatedAt: '', bookId: 'x', text: 'старое' })
    await before.close()

    await enterDemo('polka', { storage, reload })
    expect(isDemo(config, storage)).toBe(true)
    expect(reload).toHaveBeenCalledOnce()

    const after = open(true)
    expect(await after.get('quotes', 'old')).toBeUndefined()
    expect(await after.count('quotes')).toBeGreaterThan(0)
  })

  it('выход: признак снят, демо стёрто, настоящая цела', async () => {
    const storage = memoryStorage()
    const reload = vi.fn()
    const real = open(false)
    await real.put('shelves', { id: 'real-1', updatedAt: '', name: 'Моя полка', order: 1 })
    await real.close()
    setDemoFlag('polka', true, storage)
    const demo = open(true)
    await demo.ready()

    // Соединение демо открыто — страница стирает базу из-под себя же.
    await leaveDemo('polka', { storage, reload })
    expect(storage.size()).toBe(0)
    expect(reload).toHaveBeenCalledOnce()
    expect(await baseNames()).toEqual(['polka'])
    expect((await open(false).get('shelves', 'real-1'))?.name).toBe('Моя полка')
  })

  it('отметка «предложено» живёт в settings настоящей базы, не в демо', async () => {
    const real = open(false)
    await real.settings.set(DEMO_OFFERED, true)
    expect(await open(true).settings.get(DEMO_OFFERED)).toBeUndefined()
  })
})

describe('предложение демо (Я-45)', () => {
  const ok = { hasDemo: true, demo: false, empty: true, hasToken: false, offered: false }

  it('пустая база, без токена, не предлагали — предложить', () => {
    expect(showDemoOffer(ok)).toBe(true)
  })

  it('один раз: после ответа — нет', () => {
    expect(showDemoOffer({ ...ok, offered: true })).toBe(false)
  })

  it('устройству с токеном «семья» — нет: это человек с данными до синхронизации', () => {
    expect(showDemoOffer({ ...ok, hasToken: true })).toBe(false)
  })

  it('записи есть, уже демо, демо у приложения нет — нет', () => {
    expect(showDemoOffer({ ...ok, empty: false })).toBe(false)
    expect(showDemoOffer({ ...ok, demo: true })).toBe(false)
    expect(showDemoOffer({ ...ok, hasDemo: false })).toBe(false)
  })

  it('пока что-то не прочитано — молчать', () => {
    expect(showDemoOffer({ ...ok, empty: null })).toBe(false)
    expect(showDemoOffer({ ...ok, hasToken: null })).toBe(false)
    expect(showDemoOffer({ ...ok, offered: null })).toBe(false)
  })
})

describe('сторож checkDemo (Я-45)', () => {
  it('демо «Полки» — без изъянов', () => {
    expect(checkDemo(config, DAY)).toEqual([])
  })

  it('нет функции demo', () => {
    expect(checkDemo(shelfConfig(), DAY)).toEqual(['у приложения нет функции demo'])
  })

  it('хранилище без записей — новое хранилище без строки в демо', () => {
    const problems = checkDemo(shelfConfig({ demo: (day) => ({ ...shelfDemo(day), reviews: [] }) }), DAY)
    expect(problems).toEqual(['у «reviews» нет ни одной демо-записи'])
  })

  it('хранилища нет в ответе вовсе', () => {
    const problems = checkDemo(
      shelfConfig({
        demo: (day) => {
          const { quotes: _, ...rest } = shelfDemo(day)
          return rest as ReturnType<typeof shelfDemo>
        },
      }),
      DAY,
    )
    expect(problems).toEqual(['у «quotes» нет демо-записей'])
  })

  it('лишнее хранилище, запись без Base, повтор id', () => {
    const problems = checkDemo(
      shelfConfig({
        demo: (day) => {
          const data = shelfDemo(day)
          const [first] = data.books
          return {
            ...data,
            books: [first!, { ...first! }],
            quotes: [{ bookId: 'x', text: 'без id' } as never],
            extra: [],
          } as ReturnType<typeof shelfDemo>
        },
      }),
      DAY,
    )
    expect(problems).toHaveLength(4)
    expect(problems[0]).toBe('«extra» нет в stores — его записи некуда положить')
    expect(problems[1]).toMatch(/^«books»: id .+ повторяется$/)
    expect(problems.slice(2)).toEqual(['«quotes» [0]: нет id', '«quotes» [0]: нет updatedAt'])
  })

  it('упавшая функция демо — изъян, а не исключение', () => {
    const problems = checkDemo(
      shelfConfig({
        demo: () => {
          throw new Error('нет книг')
        },
      }),
      DAY,
    )
    expect(problems).toEqual(['demo упала: нет книг'])
  })
})
