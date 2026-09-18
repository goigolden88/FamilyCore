import { describe, expect, it } from 'vitest'
import { blobSha } from './github.ts'
import { shelf, type Book, type Session, type ShelfStores } from '../testing/shelf.ts'
import type { StoreData } from './db.ts'
import { canonical, createLayout, parseFile, README_PATH } from './layout.ts'

// Раскладка подставной «Полки» (`testing/shelf.ts`): тесты ядра идут без
// настоящего приложения рядом (Р-47 «Трапезы»).
const { buildFiles, parseMeta, readmeFile, storeOf } = createLayout(shelf)
const SCHEMA_VERSION = shelf.schemaVersion

/** Пустая база: все хранилища есть, записей нет. */
function empty(): StoreData<ShelfStores> {
  const data = {} as StoreData<ShelfStores>
  for (const store of shelf.stores) Object.assign(data, { [store]: [] })
  return data
}

function withData(over: Partial<StoreData<ShelfStores>>) {
  return { ...empty(), ...over }
}

function block(id: string, date: string, over: Partial<Session> = {}): Session {
  return { id, updatedAt: '2026-09-09T10:00:00.000Z', bookId: 'b1', minutes: 30, date, ...over }
}

function note(id: string, addedOn: string | null, over: Partial<Book> = {}): Book {
  return {
    id,
    updatedAt: '2026-09-09T10:00:00.000Z',
    title: 'Книга',
    addedOn,
    finishedOn: null,
    ...over,
  }
}

function pathsOf(files: { path: string }[]): string[] {
  return files.map((file) => file.path)
}

describe('раскладка', () => {
  it('пустая база даёт файлы без нарезки и meta', () => {
    expect(pathsOf(buildFiles(empty()))).toEqual(['meta.json', 'quotes.json', 'shelves.json'])
  })

  it('сеансы режутся по месяцам — Р-28 «Делу Время»', () => {
    const files = buildFiles(
      withData({
        sessions: [block('a', '2025-12-31'), block('b', '2026-01-31'), block('c', '2026-02-01'), block('d', '2026-02-28')],
      }),
    )
    expect(pathsOf(files).filter((path) => path.startsWith('sessions/'))).toEqual([
      'sessions/2025-12.json',
      'sessions/2026-01.json',
      'sessions/2026-02.json',
    ])

    const february = files.find((file) => file.path === 'sessions/2026-02.json')
    expect(JSON.parse(february?.content ?? '[]')).toHaveLength(2)
  })

  it('запись ложится в месяц своей даты раскладки, а не другой своей даты', () => {
    // Книга из января, дочитанная в феврале, остаётся январской.
    const files = buildFiles(withData({ books: [note('a', '2026-01-30', { finishedOn: '2026-02-05' })] }))
    expect(pathsOf(files)).toContain('books/2026-01.json')
    expect(pathsOf(files)).not.toContain('books/2026-02.json')
  })

  it('сеанс с испорченной датой не пропадает — уезжает в undated', () => {
    const files = buildFiles(withData({ sessions: [block('a', '2026-02-30')] }))
    expect(pathsOf(files)).toContain('sessions/undated.json')
  })

  it('запись без даты уезжает в undated, а не теряется — Р-08 «Делу Время»', () => {
    const files = buildFiles(withData({ books: [note('a', null), note('b', '2026-03-01')] }))
    expect(pathsOf(files)).toContain('books/undated.json')
    expect(JSON.parse(files.find((f) => f.path === 'books/undated.json')?.content ?? '[]'))
      .toHaveLength(1)
  })

  it('запись с испорченной датой тоже не пропадает — Р-08 «Делу Время»', () => {
    const files = buildFiles(withData({ books: [note('a', '31.02.2026')] }))
    expect(pathsOf(files)).toContain('books/undated.json')
  })

  it('надгробия уезжают вместе с живыми записями', () => {
    // Без них второе устройство воскресит удалённое.
    const files = buildFiles(withData({ sessions: [block('a', '2026-01-01', { deleted: true })] }))
    const content = files.find((file) => file.path === 'sessions/2026-01.json')?.content ?? ''
    expect(JSON.parse(content)[0].deleted).toBe(true)
  })

  it('meta.json несёт версию схемы', () => {
    const meta = buildFiles(empty()).find((file) => file.path === 'meta.json')
    expect(parseMeta(meta?.content ?? '')).toBe(SCHEMA_VERSION)
  })
})

describe('опустевший месяц', () => {
  const before = withData({ sessions: [block('a', '2026-01-31')] })
  const after = withData({ sessions: [block('a', '2026-02-01')] })

  it('перезаписывается пустым, если файл читали на этом же проходе', () => {
    // Иначе на сервере навсегда осталась бы копия записи в старом месяце.
    const files = buildFiles(after, { merged: pathsOf(buildFiles(before)) })
    const old = files.find((file) => file.path === 'sessions/2026-01.json')
    expect(JSON.parse(old?.content ?? 'null')).toEqual([])
  })

  it('нечитанные пути не трогаются', () => {
    const files = buildFiles(after)
    expect(pathsOf(files)).not.toContain('sessions/2026-01.json')
  })

  it('чужие файлы в репозитории не затираются', () => {
    const files = buildFiles(after, { merged: ['README.md', '.gitignore'] })
    expect(pathsOf(files)).not.toContain('README.md')
    expect(pathsOf(files)).not.toContain('.gitignore')
  })
})

describe('канонический вид', () => {
  it('порядок ключей в записи не меняет файл', async () => {
    // Запись из формы и запись с сервера собираются по-разному. Разойдись
    // тут байты — каждая синхронизация переписывала бы весь репозиторий.
    const one = canonical([{ id: 'a', updatedAt: '2026-01-01T00:00:00.000Z', deleted: false } as never])
    const two = canonical([{ deleted: false, updatedAt: '2026-01-01T00:00:00.000Z', id: 'a' } as never])
    expect(one).toBe(two)
    expect(await blobSha(one)).toBe(await blobSha(two))
  })

  it('порядок записей на входе не меняет файл', () => {
    const a = block('a', '2026-01-01')
    const b = block('b', '2026-02-01')
    expect(canonical([a, b])).toBe(canonical([b, a]))
  })

  it('вложенные объекты тоже упорядочиваются', () => {
    const one = { id: 'a', updatedAt: 'x', items: [{ title: 't', estMin: 30 }] } as never
    const two = { id: 'a', updatedAt: 'x', items: [{ estMin: 30, title: 't' }] } as never
    expect(canonical([one])).toBe(canonical([two]))
  })

  it('порядок в массивах сохраняется — это данные', () => {
    const one = { id: 'a', updatedAt: 'x', refs: ['b', 'a'] } as never
    const two = { id: 'a', updatedAt: 'x', refs: ['a', 'b'] } as never
    expect(canonical([one])).not.toBe(canonical([two]))
  })

  it('файл заканчивается переводом строки', () => {
    expect(canonical([])).toBe('[]\n')
  })
})

describe('storeOf', () => {
  it('узнаёт свои файлы', () => {
    expect(storeOf('shelves.json')).toBe('shelves')
    expect(storeOf('quotes.json')).toBe('quotes')
    expect(storeOf('sessions/2026-02.json')).toBe('sessions')
    expect(storeOf('books/2026-12.json')).toBe('books')
    expect(storeOf('books/undated.json')).toBe('books')
  })

  it('чужие файлы не признаёт своими', () => {
    expect(storeOf('README.md')).toBeNull()
    expect(storeOf('meta.json')).toBeNull()
    expect(storeOf('sessions/2026-02.txt')).toBeNull()
    expect(storeOf('sessions/двадцать.json')).toBeNull()
    expect(storeOf('other/2026-02.json')).toBeNull()
    // Годовой файл раскладки «Дневников» здесь чужой (Р-28 «Делу Время»).
    expect(storeOf('sessions/2026.json')).toBeNull()
    expect(storeOf('sessions/2026-13.json')).toBeNull()
    expect(storeOf('sessions/2026-2.json')).toBeNull()
  })

  it('каждый построенный файл, кроме meta, опознаётся обратно', () => {
    const files = buildFiles(withData({ sessions: [block('a', '2026-01-01')], books: [note('b', null)] }))
    for (const file of files) {
      if (file.path === 'meta.json') continue
      expect(storeOf(file.path), file.path).not.toBeNull()
    }
  })
})

describe('разбор файлов с сервера', () => {
  it('читает список записей', () => {
    const records = parseFile('shelves.json', '[{"id":"a","updatedAt":"2026-01-01T00:00:00.000Z"}]')
    expect(records).toHaveLength(1)
  })

  it('отвергает не JSON и не список', () => {
    expect(() => parseFile('shelves.json', 'мусор')).toThrow('не JSON')
    expect(() => parseFile('shelves.json', '{}')).toThrow('не список')
  })

  it('отвергает записи без id или updatedAt — на них держится слияние', () => {
    expect(() => parseFile('shelves.json', '[{"id":"a"}]')).toThrow('без id или updatedAt')
    expect(() => parseFile('shelves.json', '[null]')).toThrow('без id или updatedAt')
  })

  it('meta.json без версии — не наш репозиторий', () => {
    expect(parseMeta('{"schemaVersion":1}')).toBe(1)
    expect(() => parseMeta('{}')).toThrow('не репозиторий приложения «Полка»')
    expect(() => parseMeta('{"schemaVersion":"1"}')).toThrow('не репозиторий приложения «Полка»')
    expect(() => parseMeta('нет')).toThrow('не JSON')
  })

  it('свой же файл читается обратно', () => {
    const files = buildFiles(withData({ sessions: [block('a', '2026-01-01')] }))
    const file = files.find((each) => each.path === 'sessions/2026-01.json')
    expect(parseFile(file?.path ?? '', file?.content ?? '')[0]?.id).toBe('a')
  })
})

describe('README репозитория данных (Р-69 «Делу Время»)', () => {
  it('называет каждый файл раскладки — таблица собрана из неё', () => {
    const text = readmeFile().content
    const produced = buildFiles(
      withData({
        books: [note('n1', '2026-03-12'), note('n2', null)],
        sessions: [block('b1', '2026-02-03')],
      }),
    ).map((file) => file.path.replace(/\d{4}-\d{2}/, 'ГГГГ-ММ'))
    for (const path of produced) expect(text).toContain(`\`${path}\``)
  })

  it('говорит о приложении из конфига — имя, предмет, приватность, строки хранилищ', () => {
    const text = readmeFile().content
    expect(text).toContain('# Данные приложения «Полка»')
    expect(text).toContain(shelf.about.data)
    expect(text).toContain(shelf.about.privacy)
    for (const store of shelf.stores) expect(text).toContain(shelf.storeNotes[store])
    // Имя приложения не склоняется: ядро не знает падежей чужих имён.
    expect(text).not.toMatch(/«Полки»/)
  })

  it('своим файлом для разбора не считается', () => {
    expect(readmeFile().path).toBe(README_PATH)
    expect(storeOf(README_PATH)).toBeNull()
  })
})
