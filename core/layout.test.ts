import { describe, expect, it } from 'vitest'
import { blobSha } from './github.ts'
import { buildFiles, canonical, parseFile, parseMeta, README_PATH, readmeFile, storeOf } from './layout.ts'
import { SCHEMA_VERSION, SYNCED_STORES } from './model.ts'
import type { Note, StoreRecord, SyncedStore, TimeBlock } from './model.ts'

/** Пустая база: все хранилища есть, записей нет. */
function empty(): { [S in SyncedStore]: StoreRecord[S][] } {
  const data = {} as { [S in SyncedStore]: StoreRecord[S][] }
  for (const store of SYNCED_STORES) Object.assign(data, { [store]: [] })
  return data
}

function withData(over: Partial<{ [S in SyncedStore]: StoreRecord[S][] }>) {
  return { ...empty(), ...over }
}

function block(id: string, date: string, over: Partial<TimeBlock> = {}): TimeBlock {
  return { id, updatedAt: '2026-09-09T10:00:00.000Z', categoryId: 'cat1', minutes: 30, date, ...over }
}

function note(id: string, capturedOn: string | null, over: Partial<Note> = {}): Note {
  return {
    id,
    updatedAt: '2026-09-09T10:00:00.000Z',
    text: 'Мысль',
    kind: 'thought',
    capturedOn,
    plannedFor: null,
    status: 'open',
    ...over,
  }
}

function pathsOf(files: { path: string }[]): string[] {
  return files.map((file) => file.path)
}

describe('раскладка', () => {
  it('пустая база даёт файлы без нарезки и meta', () => {
    expect(pathsOf(buildFiles(empty()))).toEqual([
      'categories.json',
      'meta.json',
      'presets.json',
      'reviews.json',
      'templates.json',
    ])
  })

  it('блоки времени режутся по месяцам — Р-28', () => {
    const files = buildFiles(
      withData({
        time: [block('a', '2025-12-31'), block('b', '2026-01-31'), block('c', '2026-02-01'), block('d', '2026-02-28')],
      }),
    )
    expect(pathsOf(files).filter((path) => path.startsWith('time/'))).toEqual([
      'time/2025-12.json',
      'time/2026-01.json',
      'time/2026-02.json',
    ])

    const february = files.find((file) => file.path === 'time/2026-02.json')
    expect(JSON.parse(february?.content ?? '[]')).toHaveLength(2)
  })

  it('заметка ложится в месяц, когда записана, а не в месяц плана', () => {
    // Мысль из января, поставленная в план на февраль, остаётся январской.
    const files = buildFiles(withData({ notes: [note('a', '2026-01-30', { plannedFor: '2026-02-05' })] }))
    expect(pathsOf(files)).toContain('notes/2026-01.json')
    expect(pathsOf(files)).not.toContain('notes/2026-02.json')
  })

  it('блок с испорченной датой не пропадает — уезжает в undated', () => {
    const files = buildFiles(withData({ time: [block('a', '2026-02-30')] }))
    expect(pathsOf(files)).toContain('time/undated.json')
  })

  it('заметка без даты уезжает в undated, а не теряется — Р-08', () => {
    const files = buildFiles(withData({ notes: [note('a', null), note('b', '2026-03-01')] }))
    expect(pathsOf(files)).toContain('notes/undated.json')
    expect(JSON.parse(files.find((f) => f.path === 'notes/undated.json')?.content ?? '[]'))
      .toHaveLength(1)
  })

  it('заметка с испорченной датой тоже не пропадает — Р-08', () => {
    const files = buildFiles(withData({ notes: [note('a', '31.02.2026')] }))
    expect(pathsOf(files)).toContain('notes/undated.json')
  })

  it('надгробия уезжают вместе с живыми записями', () => {
    // Без них второе устройство воскресит удалённое.
    const files = buildFiles(withData({ time: [block('a', '2026-01-01', { deleted: true })] }))
    const content = files.find((file) => file.path === 'time/2026-01.json')?.content ?? ''
    expect(JSON.parse(content)[0].deleted).toBe(true)
  })

  it('meta.json несёт версию схемы', () => {
    const meta = buildFiles(empty()).find((file) => file.path === 'meta.json')
    expect(parseMeta(meta?.content ?? '')).toBe(SCHEMA_VERSION)
  })
})

describe('опустевший месяц', () => {
  const before = withData({ time: [block('a', '2026-01-31')] })
  const after = withData({ time: [block('a', '2026-02-01')] })

  it('перезаписывается пустым, если файл читали на этом же проходе', () => {
    // Иначе на сервере навсегда осталась бы копия записи в старом месяце.
    const files = buildFiles(after, { merged: pathsOf(buildFiles(before)) })
    const old = files.find((file) => file.path === 'time/2026-01.json')
    expect(JSON.parse(old?.content ?? 'null')).toEqual([])
  })

  it('нечитанные пути не трогаются', () => {
    const files = buildFiles(after)
    expect(pathsOf(files)).not.toContain('time/2026-01.json')
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
    expect(storeOf('categories.json')).toBe('categories')
    expect(storeOf('reviews.json')).toBe('reviews')
    expect(storeOf('time/2026-02.json')).toBe('time')
    expect(storeOf('notes/2026-12.json')).toBe('notes')
    expect(storeOf('notes/undated.json')).toBe('notes')
  })

  it('чужие файлы не признаёт своими', () => {
    expect(storeOf('README.md')).toBeNull()
    expect(storeOf('meta.json')).toBeNull()
    expect(storeOf('time/2026-02.txt')).toBeNull()
    expect(storeOf('time/двадцать.json')).toBeNull()
    expect(storeOf('other/2026-02.json')).toBeNull()
    // Годовой файл раскладки «Дневников» здесь чужой (Р-28).
    expect(storeOf('time/2026.json')).toBeNull()
    expect(storeOf('time/2026-13.json')).toBeNull()
    expect(storeOf('time/2026-2.json')).toBeNull()
  })

  it('каждый построенный файл, кроме meta, опознаётся обратно', () => {
    const files = buildFiles(withData({ time: [block('a', '2026-01-01')], notes: [note('b', null)] }))
    for (const file of files) {
      if (file.path === 'meta.json') continue
      expect(storeOf(file.path), file.path).not.toBeNull()
    }
  })
})

describe('разбор файлов с сервера', () => {
  it('читает список записей', () => {
    const records = parseFile('categories.json', '[{"id":"a","updatedAt":"2026-01-01T00:00:00.000Z"}]')
    expect(records).toHaveLength(1)
  })

  it('отвергает не JSON и не список', () => {
    expect(() => parseFile('categories.json', 'мусор')).toThrow('не JSON')
    expect(() => parseFile('categories.json', '{}')).toThrow('не список')
  })

  it('отвергает записи без id или updatedAt — на них держится слияние', () => {
    expect(() => parseFile('categories.json', '[{"id":"a"}]')).toThrow('без id или updatedAt')
    expect(() => parseFile('categories.json', '[null]')).toThrow('без id или updatedAt')
  })

  it('meta.json без версии — не наш репозиторий', () => {
    expect(parseMeta('{"schemaVersion":1}')).toBe(1)
    expect(() => parseMeta('{}')).toThrow('не репозиторий «Делу Время»')
    expect(() => parseMeta('{"schemaVersion":"1"}')).toThrow('не репозиторий «Делу Время»')
    expect(() => parseMeta('нет')).toThrow('не JSON')
  })

  it('свой же файл читается обратно', () => {
    const files = buildFiles(withData({ time: [block('a', '2026-01-01')] }))
    const file = files.find((each) => each.path === 'time/2026-01.json')
    expect(parseFile(file?.path ?? '', file?.content ?? '')[0]?.id).toBe('a')
  })
})

describe('README репозитория данных (Р-69)', () => {
  it('называет каждый файл раскладки — таблица собрана из неё', () => {
    const text = readmeFile().content
    const produced = buildFiles(
      withData({
        notes: [note('n1', '2026-03-12'), note('n2', null)],
        time: [block('b1', '2026-02-03')],
      }),
    ).map((file) => file.path.replace(/\d{4}-\d{2}/, 'ГГГГ-ММ'))
    for (const path of produced) expect(text).toContain(`\`${path}\``)
  })

  it('своим файлом для разбора не считается', () => {
    expect(readmeFile().path).toBe(README_PATH)
    expect(storeOf(README_PATH)).toBeNull()
  })
})
