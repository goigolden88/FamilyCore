import { describe, expect, it } from 'vitest'
import { blobSha } from './github.ts'
import { shelf, shelfConfig, shelfSummary, type Book, type Review, type Session, type ShelfStores } from '../testing/shelf.ts'
import type { StoreData } from './db.ts'
import type { AppConfig } from './model.ts'
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

  it('meta.json называет приложение его dbName — Я-24', () => {
    const meta = buildFiles(empty()).find((file) => file.path === 'meta.json')
    expect(JSON.parse(meta?.content ?? '{}')).toEqual({ app: 'polka', schemaVersion: SCHEMA_VERSION })
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
    // Годовой файл в месячной папке — чужой: нарезка места не меняется (Я-09).
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

  it('meta.json другого приложения — не наш репозиторий, давний без имени — наш', () => {
    expect(parseMeta('{"app":"polka","schemaVersion":1}')).toBe(1)
    expect(parseMeta('{"schemaVersion":1}')).toBe(1)
    expect(() => parseMeta('{"app":"sosed","schemaVersion":1}')).toThrow(
      'данные другого приложения семьи (sosed), а это приложение «Полка» (polka)',
    )
    expect(() => parseMeta('{"app":7,"schemaVersion":1}')).toThrow('другого приложения')
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

describe('годовая нарезка — Я-09', () => {
  function review(id: string, writtenOn: string | null, over: Partial<Review> = {}): Review {
    return { id, updatedAt: '2026-09-09T10:00:00.000Z', bookId: 'b1', writtenOn, text: 'Отзыв', ...over }
  }

  function inFile(files: { path: string; content: string }[], path: string): string[] {
    const file = files.find((each) => each.path === path)
    return file ? (JSON.parse(file.content) as { id: string }[]).map((record) => record.id) : []
  }

  it('запись ложится в файл своего года; день и месяц одного года — в один файл', () => {
    const files = buildFiles(
      withData({ reviews: [review('a', '2025-12-31'), review('b', '2026-01-05'), review('c', '2026-03')] }),
    )
    expect(pathsOf(files).filter((path) => path.startsWith('reviews/'))).toEqual([
      'reviews/2025.json',
      'reviews/2026.json',
    ])
    expect(inFile(files, 'reviews/2026.json')).toEqual(['b', 'c'])
  })

  it('без даты и с испорченной датой — в undated, а не теряется', () => {
    const files = buildFiles(
      withData({ reviews: [review('a', null), review('b', '2026-02-30'), review('c', 'весной 2026')] }),
    )
    expect(pathsOf(files).filter((path) => path.startsWith('reviews/'))).toEqual(['reviews/undated.json'])
    expect(inFile(files, 'reviews/undated.json')).toEqual(['a', 'b', 'c'])
  })

  it('год — четыре знака даты, а не число: файл опознаётся обратно', () => {
    const files = buildFiles(withData({ reviews: [review('a', '0999-05-01')] }))
    expect(pathsOf(files)).toContain('reviews/0999.json')
    expect(storeOf('reviews/0999.json')).toBe('reviews')
  })

  it('опустевший год перезаписывается пустым, если его читали на этом проходе', () => {
    const before = withData({ reviews: [review('a', '2025-12-31')] })
    const after = withData({ reviews: [review('a', '2026-01-01')] })
    const files = buildFiles(after, { merged: pathsOf(buildFiles(before)) })
    expect(files.find((file) => file.path === 'reviews/2025.json')?.content).toBe('[]\n')
    expect(inFile(files, 'reviews/2026.json')).toEqual(['a'])
  })

  it('storeOf узнаёт годовые файлы своей папки и не узнаёт месячные в ней', () => {
    expect(storeOf('reviews/2026.json')).toBe('reviews')
    expect(storeOf('reviews/undated.json')).toBe('reviews')
    // Файл чужой нарезки в папке — не наш и не трогается.
    expect(storeOf('reviews/2026-03.json')).toBeNull()
    expect(storeOf('reviews/26.json')).toBeNull()
    expect(storeOf('reviews/20261.json')).toBeNull()
    // И наоборот: годовой файл в месячной папке по-прежнему чужой.
    expect(storeOf('books/2026.json')).toBeNull()
  })

  it('каждый построенный годовой файл опознаётся обратно и читается', () => {
    const files = buildFiles(withData({ reviews: [review('a', '2026-01-01'), review('b', null)] }))
    for (const file of files.filter((each) => each.path.startsWith('reviews/'))) {
      expect(storeOf(file.path), file.path).toBe('reviews')
      expect(parseFile(file.path, file.content)).toHaveLength(1)
    }
  })

  it('README называет годовой файл и undated, а прошлое — годами', () => {
    const text = readmeFile().content
    expect(text).toContain(`| \`reviews/ГГГГ.json\` | ${shelf.storeNotes.reviews} |`)
    expect(text).toContain('| `reviews/undated.json` | те же записи без разбираемой даты |')
    // У «Полки» есть и месяцы, и годы.
    expect(text).toContain('Прошлые месяцы и годы не переписываются')
  })

  it('README приложения только с годовыми местами говорит о годах', () => {
    const years = createLayout({
      ...shelf,
      places: {
        ...shelf.places,
        books: { split: 'year', dir: 'books', dateOf: (book) => book.addedOn },
        sessions: { split: 'year', dir: 'sessions', dateOf: (session) => session.date },
      },
    })
    const text = years.readmeFile().content
    expect(text).toContain('Прошлые годы не переписываются, пока в них ничего не правят')
    expect(text).not.toContain('ГГГГ-ММ')
  })
})

describe('README и срез итогов — Я-16', () => {
  it('у приложения со срезом README называет summary.json; storeOf его своим не считает', () => {
    const layout = createLayout(shelfConfig({ summary: shelfSummary }))
    expect(layout.readmeFile().content).toContain('| `summary.json` | срез итогов для метаприложения семьи')
    expect(layout.storeOf('summary.json')).toBeNull()
  })

  it('у приложения без среза README о нём молчит', () => {
    expect(readmeFile().content).not.toContain('summary.json')
  })
})

describe('приложение без годовых мест — раскладка прежняя (Я-09)', () => {
  // Снято на ядре до годовой нарезки (98da218). Годовая нарезка — правка
  // договора и релиз на всех; у приложения с местами «одним файлом»
  // и «по месяцам» не обязано поменяться ни байта: ни файлы, ни README,
  // ни то, какие пути наши. «Полка» здесь — без годовых отзывов, то есть
  // ровно та, на которой снимок снят.
  type Stores = Omit<ShelfStores, 'reviews'>
  const { reviews: _index, ...indexes } = shelf.indexes
  const { reviews: _place, ...places } = shelf.places
  const { reviews: _note, ...storeNotes } = shelf.storeNotes
  const withoutYear: AppConfig<Stores> = {
    ...shelf,
    stores: shelf.stores.filter((store): store is keyof Stores => store !== 'reviews'),
    v1Stores: shelf.v1Stores.filter((store): store is keyof Stores => store !== 'reviews'),
    indexes,
    places,
    storeNotes,
    // Срез знает хранилища «Полки» целиком; здесь его нет, как и до Я-16.
    summary: undefined,
  }
  const layout = createLayout(withoutYear)

  it('файлы — побайтно те же', () => {
    const files = layout.buildFiles(
      withData({
        shelves: [{ id: 's1', updatedAt: '2026-01-01T00:00:00.000Z', name: 'Читаю', order: 1 }],
        books: [note('n1', '2026-03-12'), note('n2', '2026-03'), note('n3', null), note('n4', 'весной')],
        sessions: [block('b1', '2026-02-03'), block('b2', '2025-12-31', { deleted: true })],
      }),
      { merged: ['sessions/2026-01.json', 'books/2024-05.json', 'README.md'] },
    )
    expect(files).toMatchInlineSnapshot(`
      [
        {
          "content": "[]
      ",
          "path": "books/2024-05.json",
        },
        {
          "content": "[
        {
          "addedOn": "2026-03-12",
          "finishedOn": null,
          "id": "n1",
          "title": "Книга",
          "updatedAt": "2026-09-09T10:00:00.000Z"
        },
        {
          "addedOn": "2026-03",
          "finishedOn": null,
          "id": "n2",
          "title": "Книга",
          "updatedAt": "2026-09-09T10:00:00.000Z"
        }
      ]
      ",
          "path": "books/2026-03.json",
        },
        {
          "content": "[
        {
          "addedOn": null,
          "finishedOn": null,
          "id": "n3",
          "title": "Книга",
          "updatedAt": "2026-09-09T10:00:00.000Z"
        },
        {
          "addedOn": "весной",
          "finishedOn": null,
          "id": "n4",
          "title": "Книга",
          "updatedAt": "2026-09-09T10:00:00.000Z"
        }
      ]
      ",
          "path": "books/undated.json",
        },
        {
          "content": "{
        "app": "polka",
        "schemaVersion": 1
      }
      ",
          "path": "meta.json",
        },
        {
          "content": "[]
      ",
          "path": "quotes.json",
        },
        {
          "content": "[
        {
          "bookId": "b1",
          "date": "2025-12-31",
          "deleted": true,
          "id": "b2",
          "minutes": 30,
          "updatedAt": "2026-09-09T10:00:00.000Z"
        }
      ]
      ",
          "path": "sessions/2025-12.json",
        },
        {
          "content": "[]
      ",
          "path": "sessions/2026-01.json",
        },
        {
          "content": "[
        {
          "bookId": "b1",
          "date": "2026-02-03",
          "id": "b1",
          "minutes": 30,
          "updatedAt": "2026-09-09T10:00:00.000Z"
        }
      ]
      ",
          "path": "sessions/2026-02.json",
        },
        {
          "content": "[
        {
          "id": "s1",
          "name": "Читаю",
          "order": 1,
          "updatedAt": "2026-01-01T00:00:00.000Z"
        }
      ]
      ",
          "path": "shelves.json",
        },
      ]
    `)
  })

  it('README — побайтно тот же', () => {
    expect(layout.readmeFile().content).toMatchInlineSnapshot(`
      "# Данные приложения «Полка»

      Это хранилище данных приложения «Полка» — учёт книг и чтения.
      Код приложения лежит в отдельном публичном репозитории, здесь только записи.

      Репозиторий приватный и должен таким оставаться: внутри то, что и когда вы читали.

      Этот файл положило приложение, потому что его здесь не было. Править его можно —
      приложение его больше не трогает. Удалите — положит свежий.

      ## Что тут лежит

      | Файл | Что внутри |
      |---|---|
      | \`meta.json\` | чьи данные и версия схемы |
      | \`shelves.json\` | полки |
      | \`books/ГГГГ-ММ.json\` | книги — по месяцу, когда добавлены |
      | \`books/undated.json\` | те же записи без разбираемой даты |
      | \`sessions/ГГГГ-ММ.json\` | сеансы чтения — по месяцу, когда читали |
      | \`sessions/undated.json\` | те же записи без разбираемой даты |
      | \`quotes.json\` | цитаты |

      Прошлые месяцы не переписываются, пока в них ничего не правят: так каждое
      нажатие кнопки не переписывает всю базу и не раздувает историю коммитов.

      ## Правила

      **Руками файлы не править.** Приложение собирает файлы из своей базы на устройстве
      и отправляет то, что разошлось. Правка, сделанная здесь, будет затёрта следующей
      синхронизацией — если только не поднять у записи \`updatedAt\`, а этого делать
      не стоит: побеждает версия с более поздним временем правки, и так можно затереть
      свежую запись с телефона.

      **Удалённые записи остаются с меткой \`deleted: true\`.** Их нельзя вычищать:
      второе устройство при следующей синхронизации воскресит запись, у которой
      не осталось надгробия.

      **Свои файлы класть можно.** Что угодно — приложение читает только
      файлы из таблицы выше и остальных не касается.

      ## Как это синхронизируется

      Каждое устройство держит полную копию данных у себя в браузере и работает
      без сети. Через несколько секунд после правки оно читает голову ветки, забирает
      разошедшиеся файлы, сливает их у себя по правилу «побеждает более поздняя правка
      отдельной записи» и отправляет своё одним коммитом.

      ## Если приложение сломалось

      Данные отсюда можно забрать и без него: это обычный JSON. Обратно в приложение
      они загружаются файлом-копией — «Настройки» → «Экспорт и импорт» → «Восстановить
      из копии», но формат копии другой: один файл вместо этой раскладки. Копию делает
      само приложение кнопкой «Сохранить в файл».

      ## Токены доступа

      У каждого устройства свой токен, выпущенный на нём же. Потерянный телефон
      отзывается одной кнопкой в настройках GitHub и не ломает остальные устройства.
      Токены хранятся только в браузере и в этот репозиторий не попадают никогда.
      "
    `)
  })

  it('свои пути — те же', () => {
    const paths = [
      'shelves.json',
      'quotes.json',
      'books/2026-03.json',
      'books/undated.json',
      'books/2026.json',
      'sessions/2026-12.json',
      'sessions/2026-13.json',
      'sessions/2026.json',
      'sessions/undated.json',
      'reviews/2026.json',
      'reviews/undated.json',
      'meta.json',
      'README.md',
    ]
    expect(Object.fromEntries(paths.map((path) => [path, layout.storeOf(path)]))).toMatchInlineSnapshot(`
      {
        "README.md": null,
        "books/2026-03.json": "books",
        "books/2026.json": null,
        "books/undated.json": "books",
        "meta.json": null,
        "quotes.json": "quotes",
        "reviews/2026.json": null,
        "reviews/undated.json": null,
        "sessions/2026-12.json": "sessions",
        "sessions/2026-13.json": null,
        "sessions/2026.json": null,
        "sessions/undated.json": "sessions",
        "shelves.json": "shelves",
      }
    `)
  })
})
