import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shelf, shelfConfig, type Session, type Shelf } from '../testing/shelf.ts'
import { createDb } from './db.ts'
import { checkConfig, LOCAL_STORES } from './model.ts'
import type { Migration } from './model.ts'

/**
 * Хранилище целиком: разбор файла, совместимость версий и работа с базой.
 *
 * IndexedDB подделан `fake-indexeddb` — настоящего в node нет, а проверить
 * `db` руками нельзя в принципе: глазами не видно, что надгробие пережило
 * слияние или что пометка, поставленная во время отправки, не потерялась.
 * Подделка подключается здесь и в проверке на копии настоящих данных
 * (`realdata.test.ts`, Р-72 «Дневников»): остальным тестам глобальный `indexedDB`
 * не нужен, и подсовывать его им незачем.
 *
 * Приложение — подставная «Полка» (`testing/shelf.ts`): тесты ядра идут без
 * настоящего приложения рядом (Р-47 «Трапезы»).
 *
 * Перед каждым тестом база заводится заново. Соединение кешируется в модуле,
 * поэтому сначала закрывается оно, а потом подменяется сама фабрика — иначе
 * следующий тест получит базу предыдущего.
 */

const db = createDb(shelf)
const SCHEMA_VERSION = shelf.schemaVersion
const SYNCED_STORES = shelf.stores

beforeEach(async () => {
  // Провалившееся соединение из прошлого теста закрывать нечего.
  await db.close().catch(() => {})
  globalThis.indexedDB = new IDBFactory()
})

afterEach(async () => {
  await db.close().catch(() => {})
})

const T1 = '2026-09-01T10:00:00.000Z'
const T2 = '2026-09-02T10:00:00.000Z'
const T3 = '2026-09-03T10:00:00.000Z'

function item(id: string, over: Partial<Shelf> = {}): Shelf {
  return { id, updatedAt: T1, name: 'Чтение', order: 0, ...over }
}

function mark(id: string, over: Partial<Session> = {}): Session {
  return { id, updatedAt: T1, bookId: 'b1', date: '2026-09-01', minutes: 30, ...over }
}

/**
 * `updatedAt` пишется с точностью до миллисекунды, и две правки подряд
 * могут получить одинаковое время. Там, где проверяется именно расхождение
 * времени, паузу приходится делать настоящую.
 */
function pause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 2))
}

/** Соединение мимо `db` — единственный способ проверить, что он построил. */
function openRaw(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(shelf.dbName)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('не открылась'))
  })
}

/** Текст слепка для разбора. Отдельно от builder-ов записей: тут проверяется
 *  форма файла, и запись в нём нарочно неполная. */
function snapshot(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    exportedAt: '2026-09-07T10:00:00.000Z',
    data: { shelves: [{ id: 'i1', updatedAt: '2026-09-07T10:00:00.000Z', name: 'Чтение' }] },
    ...over,
  })
}

describe('parseSnapshot', () => {
  it('разбирает свой же слепок и добивает недостающие хранилища пустыми', () => {
    const parsed = db.parseSnapshot(snapshot())
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION)
    expect(parsed.exportedAt).toBe('2026-09-07T10:00:00.000Z')
    expect(parsed.data.shelves).toHaveLength(1)
    for (const store of SYNCED_STORES) {
      expect(Array.isArray(parsed.data[store])).toBe(true)
    }
  })

  it('отвергает не JSON и не объект', () => {
    expect(() => db.parseSnapshot('не json')).toThrow('Это не JSON')
    expect(() => db.parseSnapshot('[]')).toThrow('не объект')
    expect(() => db.parseSnapshot('null')).toThrow('не объект')
  })

  it('отвергает чужой файл без версии схемы', () => {
    expect(() => db.parseSnapshot(JSON.stringify({ data: {} }))).toThrow('версии схемы')
  })

  it('отвергает слепок без данных', () => {
    expect(() => db.parseSnapshot(JSON.stringify({ schemaVersion: 1 }))).toThrow('нет данных')
  })

  it('отвергает хранилище не массивом', () => {
    expect(() => db.parseSnapshot(snapshot({ data: { shelves: 'нет' } }))).toThrow('не массив')
  })

  it('отвергает файл целиком из-за одной записи без id — половина хуже отказа', () => {
    const broken = snapshot({
      data: {
        shelves: [
          { id: 'i1', updatedAt: '2026-09-07T10:00:00.000Z' },
          { updatedAt: '2026-09-07T10:00:00.000Z' },
        ],
      },
    })
    expect(() => db.parseSnapshot(broken)).toThrow('без id или updatedAt')
  })

  it('подставляет время разбора, если в файле нет exportedAt', () => {
    const parsed = db.parseSnapshot(snapshot({ exportedAt: undefined }))
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('checkSnapshotVersion', () => {
  const noop = () => {}
  const additive: Migration = {
    to: 2,
    note: 'добавлено хранилище depra',
    additive: true,
    run: noop,
  }
  const reshaping: Migration = {
    to: 3,
    note: 'score стал обязательным',
    additive: false,
    run: noop,
  }

  it('свою версию принимает', () => {
    expect(() => db.checkSnapshotVersion(SCHEMA_VERSION)).not.toThrow()
  })

  it('файл из будущего отвергает', () => {
    expect(() => db.checkSnapshotVersion(SCHEMA_VERSION + 1)).toThrow('более новой версии')
  })

  it('отставание из-за одного лишь нового модуля не мешает', () => {
    expect(() => db.checkSnapshotVersion(1, [additive], 2)).not.toThrow()
  })

  it('изменение формы записей отвергает и называет причину', () => {
    expect(() => db.checkSnapshotVersion(2, [additive, reshaping], 3)).toThrow(
      'score стал обязательным',
    )
  })

  it('аддитивный шаг не спасает, если следом форма всё-таки менялась', () => {
    expect(() => db.checkSnapshotVersion(1, [additive, reshaping], 3)).toThrow('форма')
  })

  it('шаги вне промежутка между версиями не учитываются', () => {
    expect(() => db.checkSnapshotVersion(3, [reshaping], 3)).not.toThrow()
  })
})

describe('запись и происхождение', () => {
  it('правка на устройстве двигает updatedAt и метит грязной', async () => {
    const saved = await db.put('shelves', item('i1'))

    expect(saved.updatedAt > T1).toBe(true)
    expect((await db.get('shelves', 'i1'))?.updatedAt).toBe(saved.updatedAt)
    expect(await db.listDirty()).toEqual([{ store: 'shelves', id: 'i1', at: saved.updatedAt }])
  })

  it('пришедшее с сервера оставляет чужой updatedAt и грязным не метится', async () => {
    await db.putRemote('shelves', [item('i1', { updatedAt: T2 })])

    // Сдвинь здесь время — и синхронизация зациклится сама на себе:
    // отправит обратно то, что только что приняла.
    expect((await db.get('shelves', 'i1'))?.updatedAt).toBe(T2)
    expect(await db.listDirty()).toEqual([])
  })

  it('загруженное из файла метится грязным, но время правки чужое', async () => {
    await db.merge('shelves', [item('i1', { updatedAt: T2 })], 'imported')

    expect((await db.get('shelves', 'i1'))?.updatedAt).toBe(T2)
    expect(await db.listDirty()).toHaveLength(1)
  })

  it('пачка пишется целиком и метится вся', async () => {
    await db.putMany('shelves', [item('i1'), item('i2'), item('i3')])

    expect(await db.count('shelves')).toBe(3)
    expect(await db.listDirty()).toHaveLength(3)
  })

  it('пустая пачка не пишет ничего', async () => {
    await db.putMany('shelves', [])

    expect(await db.count('shelves')).toBe(0)
    expect(await db.listDirty()).toEqual([])
  })

  it('get на пустом месте отдаёт undefined, а не падает', async () => {
    expect(await db.get('shelves', 'нет такой')).toBeUndefined()
  })
})

describe('мягкое удаление', () => {
  it('ставит надгробие, запись остаётся в базе навсегда', async () => {
    await db.put('shelves', item('i1'))

    expect(await db.remove('shelves', 'i1')).toBe(true)
    // Вычистить запись нельзя: второе устройство при следующей
    // синхронизации воскресит её (Р-07 «Дневников»).
    expect((await db.get('shelves', 'i1'))?.deleted).toBe(true)
  })

  it('удалённое не попадает в списки и счётчики, но видно с includeDeleted', async () => {
    await db.putMany('shelves', [item('i1'), item('i2')])
    await db.remove('shelves', 'i1')

    expect(await db.getAll('shelves')).toHaveLength(1)
    expect(await db.count('shelves')).toBe(1)
    expect(await db.getAll('shelves', { includeDeleted: true })).toHaveLength(2)
    expect(await db.count('shelves', { includeDeleted: true })).toBe(2)
  })

  it('надгробие на пустом месте не ставится', async () => {
    expect(await db.remove('shelves', 'нет такой')).toBe(false)
    expect(await db.count('shelves', { includeDeleted: true })).toBe(0)
  })

  it('удаление двигает updatedAt и метит грязной — оно должно уехать', async () => {
    await db.putRemote('shelves', [item('i1', { updatedAt: T1 })])
    await db.remove('shelves', 'i1')

    const tombstone = await db.get('shelves', 'i1')
    expect(tombstone && tombstone.updatedAt > T1).toBe(true)
    expect(await db.listDirty()).toHaveLength(1)
  })
})

describe('выборка по индексу — Я-08', () => {
  const ids = (records: readonly { id: string }[]) => records.map((each) => each.id).sort()

  beforeEach(async () => {
    await db.putRemote('sessions', [
      mark('s1', { date: '2026-08-31' }),
      mark('s2', { date: '2026-09-01' }),
      mark('s3', { date: '2026-09-15' }),
      mark('s4', { date: '2026-09-30' }),
      mark('s5', { date: '2026-10-01' }),
    ])
  })

  it('диапазон — границы включительно', async () => {
    expect(ids(await db.getByIndex('sessions', 'date', { from: '2026-09-01', to: '2026-09-30' }))).toEqual([
      's2',
      's3',
      's4',
    ])
  })

  it('диапазон с одной границей', async () => {
    expect(ids(await db.getByIndex('sessions', 'date', { from: '2026-09-30' }))).toEqual(['s4', 's5'])
    expect(ids(await db.getByIndex('sessions', 'date', { to: '2026-09-01' }))).toEqual(['s1', 's2'])
  })

  it('ключ — точное совпадение', async () => {
    await db.putRemote('quotes', [
      { id: 'q1', updatedAt: T1, bookId: 'b1', text: 'а' },
      { id: 'q2', updatedAt: T1, bookId: 'b2', text: 'б' },
    ])
    expect(ids(await db.getByIndex('quotes', 'bookId', 'b2'))).toEqual(['q2'])
  })

  it('надгробия отсеиваются, как у getAll, и видны с includeDeleted', async () => {
    await db.remove('sessions', 's3')
    const range = { from: '2026-09-01', to: '2026-09-30' }
    expect(ids(await db.getByIndex('sessions', 'date', range))).toEqual(['s2', 's4'])
    expect(ids(await db.getByIndex('sessions', 'date', range, { includeDeleted: true }))).toEqual(['s2', 's3', 's4'])
  })

  it('запись без поля в индекс не попадает — так устроен IndexedDB', async () => {
    await db.putRemote('books', [
      { id: 'b1', updatedAt: T1, title: 'С датой', addedOn: '2026-09-01' },
      { id: 'b2', updatedAt: T1, title: 'Без даты', addedOn: null },
    ])
    expect(ids(await db.getByIndex('books', 'addedOn', { to: '9999' }))).toEqual(['b1'])
  })

  it('индекса нет на устройстве — внятная ошибка с именами', async () => {
    await expect(db.getByIndex('shelves', 'name', 'Чтение')).rejects.toThrow('хранилища «shelves» нет индекса «name»')
  })
})

describe('слияние по updatedAt', () => {
  it('входящая новее — побеждает', async () => {
    await db.putRemote('shelves', [item('i1', { name: 'Чтение', updatedAt: T1 })])
    const applied = await db.merge(
      'shelves',
      [item('i1', { name: 'Шахматы', updatedAt: T2 })],
      'remote',
    )

    expect(applied).toBe(1)
    expect((await db.get('shelves', 'i1'))?.name).toBe('Шахматы')
  })

  it('входящая старее — отбрасывается', async () => {
    await db.putRemote('shelves', [item('i1', { name: 'Шахматы', updatedAt: T2 })])
    const applied = await db.merge(
      'shelves',
      [item('i1', { name: 'Чтение', updatedAt: T1 })],
      'remote',
    )

    expect(applied).toBe(0)
    expect((await db.get('shelves', 'i1'))?.name).toBe('Шахматы')
  })

  it('ровно то же время не применяется — своё остаётся своим', async () => {
    await db.putRemote('shelves', [item('i1', { name: 'Шахматы', updatedAt: T2 })])
    const applied = await db.merge(
      'shelves',
      [item('i1', { name: 'Чтение', updatedAt: T2 })],
      'remote',
    )

    expect(applied).toBe(0)
    expect((await db.get('shelves', 'i1'))?.name).toBe('Шахматы')
  })

  it('незнакомая запись добавляется', async () => {
    const applied = await db.merge('shelves', [item('i1'), item('i2')], 'remote')

    expect(applied).toBe(2)
    expect(await db.count('shelves')).toBe(2)
  })

  it('надгробие новее живой записи — удаление доезжает до второго устройства', async () => {
    await db.putRemote('shelves', [item('i1', { updatedAt: T1 })])
    await db.merge('shelves', [item('i1', { updatedAt: T2, deleted: true })], 'remote')

    expect((await db.get('shelves', 'i1'))?.deleted).toBe(true)
    expect(await db.count('shelves')).toBe(0)
  })

  it('живая запись новее надгробия — правка воскрешает удалённое', async () => {
    await db.putRemote('shelves', [item('i1', { updatedAt: T2, deleted: true })])
    await db.merge('shelves', [item('i1', { name: 'Чтение', updatedAt: T3 })], 'remote')

    // Не ошибка: на другом устройстве запись правили позже, чем здесь
    // удаляли, и по Р-07 «Дневников» побеждает поздняя правка.
    expect((await db.get('shelves', 'i1'))?.deleted).toBeUndefined()
    expect(await db.count('shelves')).toBe(1)
  })

  it('надгробие участвует в сравнении, а не считается отсутствием записи', async () => {
    await db.putRemote('shelves', [item('i1', { updatedAt: T3, deleted: true })])
    const applied = await db.merge('shelves', [item('i1', { updatedAt: T2 })], 'remote')

    expect(applied).toBe(0)
    expect((await db.get('shelves', 'i1'))?.deleted).toBe(true)
  })

  it('слияние с сервера грязным не метит, из файла — метит', async () => {
    await db.merge('shelves', [item('i1')], 'remote')
    expect(await db.listDirty()).toEqual([])

    await db.merge('shelves', [item('i2')], 'imported')
    expect(await db.listDirty()).toHaveLength(1)
  })

  it('пустой список не трогает базу', async () => {
    expect(await db.merge('shelves', [], 'remote')).toBe(0)
  })
})

describe('очередь изменений', () => {
  it('пометка несёт хранилище, запись и время правки', async () => {
    const saved = await db.put('sessions', mark('e1'))

    expect(await db.listDirty()).toEqual([{ store: 'sessions', id: 'e1', at: saved.updatedAt }])
  })

  it('повторная правка одной записи даёт одну пометку, а не две', async () => {
    const first = await db.put('shelves', item('i1'))
    await pause()
    await db.put('shelves', { ...first, name: 'Шахматы' })

    expect(await db.listDirty()).toHaveLength(1)
  })

  it('пометки снимаются после успешной отправки', async () => {
    await db.putMany('shelves', [item('i1'), item('i2')])
    await db.clearDirty(await db.listDirty())

    expect(await db.listDirty()).toEqual([])
  })

  it('правка во время отправки пометку не теряет', async () => {
    const saved = await db.put('shelves', item('i1'))
    const sending = await db.listDirty()

    // Отправка уже началась, и ровно в этот момент запись правят.
    await pause()
    await db.put('shelves', { ...saved, name: 'Шахматы' })

    await db.clearDirty(sending)

    // Без сверки времени правка ушла бы молча — самый неприятный вид
    // потери данных: на экране всё на месте, на сервере её нет.
    expect(await db.listDirty()).toHaveLength(1)
  })

  it('снимается только то, что отправляли', async () => {
    await db.put('shelves', item('i1'))
    const sending = await db.listDirty()
    await db.put('shelves', item('i2'))

    await db.clearDirty(sending)

    expect((await db.listDirty()).map((ref) => ref.id)).toEqual(['i2'])
  })

  it('пустой список снимать нечего', async () => {
    await db.put('shelves', item('i1'))
    await db.clearDirty([])

    expect(await db.listDirty()).toHaveLength(1)
  })

  it('различает записи с одинаковым id в разных хранилищах', async () => {
    await db.put('shelves', item('одинаковый'))
    await db.put('sessions', mark('одинаковый'))

    expect(await db.listDirty()).toHaveLength(2)
  })
})

describe('оповещение об изменениях', () => {
  it('говорит, что и откуда записалось', async () => {
    const seen: unknown[] = []
    const off = db.onChange((event) => seen.push(event))

    await db.putMany('shelves', [item('i1'), item('i2')])
    await db.putRemote('sessions', [mark('e1')])
    off()

    expect(seen).toEqual([
      { store: 'shelves', origin: 'local', count: 2 },
      { store: 'sessions', origin: 'remote', count: 1 },
    ])
  })

  it('пустая запись не оповещает — ноль сюда не приходит', async () => {
    const seen: unknown[] = []
    const off = db.onChange((event) => seen.push(event))

    await db.putMany('shelves', [])
    await db.merge('shelves', [item('i1', { updatedAt: T1 })], 'remote')
    // Второе слияние ничего не применило: оповещать не о чем.
    await db.merge('shelves', [item('i1', { updatedAt: T1 })], 'remote')
    off()

    expect(seen).toHaveLength(1)
  })

  it('упавший слушатель не роняет запись — она уже прошла', async () => {
    const off = db.onChange(() => {
      throw new Error('экран сломался')
    })

    await expect(db.put('shelves', item('i1'))).resolves.toBeDefined()
    off()

    expect(await db.count('shelves')).toBe(1)
  })

  it('отписка работает', async () => {
    let calls = 0
    const off = db.onChange(() => {
      calls += 1
    })

    await db.put('shelves', item('i1'))
    off()
    await db.put('shelves', item('i2'))

    expect(calls).toBe(1)
  })
})

describe('слепок', () => {
  it('включает надгробия — без них второе устройство воскресит удалённое', async () => {
    await db.putMany('shelves', [item('i1'), item('i2')])
    await db.remove('shelves', 'i1')

    const snapshot = await db.exportAll()

    expect(snapshot.data.shelves).toHaveLength(2)
    expect(snapshot.data.shelves.find((each) => each.id === 'i1')?.deleted).toBe(true)
  })

  it('несёт все синхронизируемые хранилища и не несёт настройки', async () => {
    await db.settings.set('syncToken', 'секретный токен')
    const snapshot = await db.exportAll()

    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION)
    for (const store of SYNCED_STORES) expect(Array.isArray(snapshot.data[store])).toBe(true)
    expect(JSON.stringify(snapshot)).not.toContain('секретный токен')
  })

  it('загрузка сливается, а не затирает: файл может быть старше здешнего', async () => {
    await db.putRemote('shelves', [item('i1', { name: 'Шахматы', updatedAt: T3 })])
    const data = (await db.exportAll()).data

    const applied = await db.importAll({
      schemaVersion: SCHEMA_VERSION,
      exportedAt: T2,
      data: {
        ...data,
        shelves: [item('i1', { name: 'Чтение', updatedAt: T1 }), item('i2', { updatedAt: T2 })],
      },
    })

    expect(applied).toBe(1)
    expect((await db.get('shelves', 'i1'))?.name).toBe('Шахматы')
    expect(await db.get('shelves', 'i2')).toBeDefined()
  })

  it('свой же слепок переживает круг через файл', async () => {
    await db.putMany('shelves', [item('i1'), item('i2')])
    await db.put('sessions', mark('e1'))
    const text = JSON.stringify(await db.exportAll())

    await db.close()
    globalThis.indexedDB = new IDBFactory()

    const applied = await db.importAll(db.parseSnapshot(text))

    expect(applied).toBe(3)
    expect(await db.count('shelves')).toBe(2)
    expect(await db.count('sessions')).toBe(1)
  })

  it('хранилище с годовой нарезкой едет в слепке, как любое — Я-09', async () => {
    // Слепок раскладки не знает: одно хранилище — один массив, как бы оно
    // ни лежало в репозитории данных.
    await db.put('reviews', { id: 'r1', updatedAt: T1, bookId: 'b1', writtenOn: '2026-03', text: 'Отзыв' })
    const text = JSON.stringify(await db.exportAll())

    await db.close()
    globalThis.indexedDB = new IDBFactory()

    expect(await db.importAll(db.parseSnapshot(text))).toBe(1)
    expect((await db.get('reviews', 'r1'))?.writtenOn).toBe('2026-03')
  })
})

describe('настройки и служебное', () => {
  it('хранят, отдают, забывают', async () => {
    await db.settings.set('syncRepo', 'user/data')
    expect(await db.settings.get('syncRepo')).toBe('user/data')

    await db.settings.remove('syncRepo')
    expect(await db.settings.get('syncRepo')).toBeUndefined()
  })

  it('перечисляют ключи', async () => {
    await db.settings.set('syncRepo', 'user/data')
    await db.settings.set('syncBranch', 'main')

    expect((await db.settings.keys()).sort()).toEqual(['syncBranch', 'syncRepo'])
  })

  it('settings и meta не пересекаются', async () => {
    await db.settings.set('общий', 'из настроек')
    await db.meta.set('общий', 'из meta')

    expect(await db.settings.get('общий')).toBe('из настроек')
    expect(await db.meta.get('общий')).toBe('из meta')
  })

  it('ready отмечает версию схемы', async () => {
    await db.ready()

    expect(await db.meta.get('schemaVersion')).toBe(SCHEMA_VERSION)
  })

  it('база переоткрывается после close', async () => {
    await db.put('shelves', item('i1'))
    await db.close()

    expect(await db.count('shelves')).toBe(1)
  })
})

describe('постоянное хранилище', () => {
  it('без API браузера отвечает «нет», а не падает', async () => {
    expect(await db.persist()).toBe(false)
    expect(await db.persisted()).toBeNull()
  })
})

describe('схема базы', () => {
  it('заводит все хранилища и индексы, на которых держится остальное', async () => {
    await db.ready()
    const raw = await openRaw()

    try {
      expect(raw.version).toBe(SCHEMA_VERSION)
      for (const store of [...SYNCED_STORES, ...LOCAL_STORES]) {
        expect(raw.objectStoreNames.contains(store)).toBe(true)
      }

      const tx = raw.transaction([...SYNCED_STORES], 'readonly')
      // На updatedAt держится слияние, на датах — выборки дня, недели и возврата.
      for (const store of SYNCED_STORES) {
        expect([...tx.objectStore(store).indexNames]).toContain('updatedAt')
      }
      expect([...tx.objectStore('books').indexNames].sort()).toEqual([
        'addedOn',
        'finishedOn',
        'updatedAt',
      ])
      expect([...tx.objectStore('sessions').indexNames].sort()).toEqual(['date', 'updatedAt'])
      expect([...tx.objectStore('quotes').indexNames].sort()).toEqual(['bookId', 'updatedAt'])
    } finally {
      raw.close()
    }
  })

  it('запись без дат пишется и читается: null в индексе записи не мешает — Р-08 «Делу Время»', async () => {
    // Индекс по `addedOn` и `finishedOn`, а у книги без даты оба null.
    // Null не ключ IndexedDB: такая запись просто не попадает в индекс.
    await db.put('books', {
      id: 'n1',
      updatedAt: T1,
      title: 'Книга без даты',
      addedOn: null,
      finishedOn: null,
    })

    expect(await db.get('books', 'n1')).toMatchObject({ title: 'Книга без даты', addedOn: null })
    expect(await db.count('books')).toBe(1)
  })
})

describe('конфиг приложения — Р-47 «Трапезы»', () => {
  it('годный конфиг принимается', () => {
    expect(() => checkConfig(shelf)).not.toThrow()
  })

  it('хранилище не может лежать в summary.json — это место среза итогов (Я-16)', () => {
    const places = { ...shelf.places, quotes: { split: 'none' as const, path: 'summary.json' } }
    expect(() => checkConfig(shelfConfig({ places }))).toThrow('«quotes» лежит в summary.json')
  })

  it('хранилище без места, строки индексов или README — отказ до первой записи', () => {
    const broken = { ...shelf, stores: [...shelf.stores, 'loans'] } as unknown as typeof shelf
    expect(() => checkConfig(broken)).toThrow('«loans» нет места в places')
  })

  it('повтор в stores, чужое в v1Stores, имя локального хранилища — отказ', () => {
    expect(() => checkConfig(shelfConfig({ stores: ['shelves', 'shelves', 'books', 'sessions', 'quotes'] }))).toThrow(
      'повтор',
    )
    expect(() => checkConfig({ ...shelf, v1Stores: ['loans'] } as unknown as typeof shelf)).toThrow('из v1Stores')
    const local = {
      ...shelf,
      stores: [...shelf.stores, 'settings'],
      places: { ...shelf.places, settings: { split: 'none', path: 'settings.json' } },
      indexes: { ...shelf.indexes, settings: [] },
      storeNotes: { ...shelf.storeNotes, settings: '' },
    } as unknown as typeof shelf
    expect(() => checkConfig(local)).toThrow('имя локального хранилища')
  })

  it('миграция вне версий схемы — отказ', () => {
    const step: Migration = { to: 3, note: 'лишняя', additive: true, run: () => {} }
    expect(() => checkConfig(shelfConfig({ schemaVersion: 2, migrations: [step] }))).toThrow('вне версий')
  })

  it('createDb проверяет конфиг сам', () => {
    expect(() => createDb(shelfConfig({ dbName: '' }))).toThrow('dbName пустой')
  })
})

describe('два приложения на одном origin', () => {
  it('базы с разными именами не видят записей друг друга', async () => {
    const other = createDb(shelfConfig({ dbName: 'polka-2' }))
    try {
      await db.put('shelves', item('i1'))
      expect(await other.count('shelves')).toBe(0)
      await other.put('shelves', item('i2'))
      expect((await db.getAll('shelves')).map((each) => each.id)).toEqual(['i1'])
    } finally {
      await other.close()
    }
  })
})

describe('миграция — путь установленной копии', () => {
  const addIndex: Migration = {
    to: 2,
    note: 'индекс цитат по тексту',
    additive: true,
    run: (_database, tx) => tx.objectStore('quotes').createIndex('text', 'text'),
  }

  it('база версии 1 с записями доезжает до версии 2, записи на месте', async () => {
    const v2 = createDb(shelfConfig({ schemaVersion: 2, migrations: [addIndex] }))
    try {
      const skipped = await v2.createLegacyBase(1, {
        quotes: [{ id: 'q1', updatedAt: T1, bookId: 'b1', text: 'Рукописи не горят' }],
      })
      expect(skipped).toEqual([])

      await v2.ready()
      expect(await v2.get('quotes', 'q1')).toMatchObject({ text: 'Рукописи не горят' })
      expect(await v2.meta.get('schemaVersion')).toBe(2)

      await v2.close()
      const raw = await openRaw()
      try {
        expect(raw.version).toBe(2)
        const tx = raw.transaction('quotes', 'readonly')
        expect([...tx.objectStore('quotes').indexNames].sort()).toEqual(['bookId', 'text', 'updatedAt'])
      } finally {
        raw.close()
      }
    } finally {
      await v2.close()
    }
  })

  it('свежая база строится как версия 1 и проходит те же шаги', async () => {
    const v2 = createDb(shelfConfig({ schemaVersion: 2, migrations: [addIndex] }))
    try {
      await v2.ready()
      await v2.close()
      const raw = await openRaw()
      try {
        const tx = raw.transaction('quotes', 'readonly')
        expect([...tx.objectStore('quotes').indexNames]).toContain('text')
      } finally {
        raw.close()
      }
    } finally {
      await v2.close()
    }
  })

  it('индекс, заведённый миграцией, читается, хотя в конфиге его нет — Я-08', async () => {
    const v2 = createDb(shelfConfig({ schemaVersion: 2, migrations: [addIndex] }))
    try {
      await v2.createLegacyBase(1, {
        quotes: [
          { id: 'q1', updatedAt: T1, bookId: 'b1', text: 'Рукописи не горят' },
          { id: 'q2', updatedAt: T1, bookId: 'b1', text: 'Никогда и ничего не просите' },
        ],
      })
      await v2.ready()
      expect((await v2.getByIndex('quotes', 'text', 'Рукописи не горят')).map((each) => each.id)).toEqual(['q1'])
    } finally {
      await v2.close()
    }
  })

  it('версии, которой нет, построить нельзя', async () => {
    await expect(db.createLegacyBase(2, {})).rejects.toThrow('Схемы 2 не бывает')
  })
})
