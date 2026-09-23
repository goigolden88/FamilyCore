/**
 * Локальное хранилище.
 *
 * Единственное место в приложении, которое знает про IndexedDB. Модули,
 * экраны и синхронизация ходят только сюда — это позволяет заменить
 * хранилище правкой одного файла (docs/02-Архитектура.md, «Правила»).
 *
 * Что здесь важно и почему:
 *
 * — Удаление всегда мягкое. Запись получает `deleted: true` и остаётся
 *   навсегда. Если метки вычищать, второе устройство при следующей
 *   синхронизации воскресит запись (Р-07 «Дневников»).
 *
 * — Изменённые записи копятся в хранилище `dirty` ссылками `{store, id}`.
 *   Во что они свернутся — в файлы `cycles/2026.json` или в запросы
 *   к бэкенду — решает `sync`, не `db` (Р-18 «Дневников»).
 *
 * — У записи три разных происхождения, и путать их нельзя:
 *   правка на устройстве двигает `updatedAt` и метит запись грязной,
 *   пришедшее с сервера не делает ни того ни другого, загруженное
 *   из файла метится грязным, но `updatedAt` сохраняет чужой.
 *   `updatedAt` — то, на чём держится правило слияния, трогать его
 *   при переносе нельзя.
 *
 * Ядро про приложение не знает (Р-47 «Трапезы»): имя базы, версия схемы,
 * хранилища, индексы и миграции приходят `AppConfig`. Приложение создаёт
 * базу один раз, в `src/app/core.ts`, и дальше ходит к ней только так.
 */

import { nowIso } from './dates.ts'
import { checkConfig } from './model.ts'
import type { AppConfig, Base, Migration, StoreMap, StoreOf } from './model.ts'

/** Откуда пришла запись. Определяет, двигать ли `updatedAt` и метить ли грязной. */
export type Origin =
  /** Правка на этом устройстве */
  | 'local'
  /** Прилетело с сервера при синхронизации */
  | 'remote'
  /** Загружено из файла экспорта */
  | 'imported'

export type DirtyRef<R extends StoreMap = StoreMap> = {
  store: StoreOf<R>
  id: string
  /** `updatedAt` записи на момент пометки. Нужен, чтобы `clearDirty`
   *  не стёр пометку, поставленную уже после начала отправки. */
  at: string
}

/** Все синхронизируемые хранилища с записями — форма слепка и чтения «всё разом». */
export type StoreData<R extends StoreMap> = { [S in StoreOf<R>]: R[S][] }

export type Snapshot<R extends StoreMap = StoreMap> = {
  schemaVersion: number
  exportedAt: string
  data: StoreData<R>
}

/** Что и откуда записалось. Больше про изменение никто ничего не обещает. */
export type ChangeEvent<R extends StoreMap = StoreMap> = {
  store: StoreOf<R>
  origin: Origin
  /** Сколько записей затронуто. Ноль сюда не приходит. */
  count: number
}

/** Простое хранилище «ключ — значение» поверх одного объектного хранилища. */
export type KeyValue = {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}

/**
 * Что искать по индексу (Я-08): ключ — точное совпадение, диапазон — границы
 * включительно, любая может не быть. `IDBKeyRange` наружу не выходит:
 * к IndexedDB ходит только этот файл.
 */
export type IndexMatch = string | number | { from?: string | number; to?: string | number }

function keyRange(match: IndexMatch): IDBKeyRange | undefined {
  if (typeof match !== 'object') return IDBKeyRange.only(match)
  const { from, to } = match
  if (from !== undefined && to !== undefined) return IDBKeyRange.bound(from, to)
  if (from !== undefined) return IDBKeyRange.lowerBound(from)
  if (to !== undefined) return IDBKeyRange.upperBound(to)
  return undefined
}

// ─── Обёртки над IDBRequest ────────────────────────────────────────────────

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Запрос к базе не прошёл'))
  })
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('Транзакция не прошла'))
    tx.onabort = () => reject(tx.error ?? new Error('Транзакция отменена'))
  })
}

// ─── Версии схемы ──────────────────────────────────────────────────────────

/**
 * Можно ли принять данные со схемой `fileVersion`. Кидает с объяснением, если нет.
 *
 * Отставание схемы само по себе не мешает: добавление модуля поднимает версию,
 * но записей прошлых модулей не касается. Отвергать выгрузку месячной давности
 * из-за появления нового хранилища — терять единственную копию данных на ровном
 * месте. Мешает только изменение формы записей, и ровно его тут и ищем
 * (Р-24 «Дневников»).
 *
 * Договор семьи (02-Архитектура, «schemaVersion»): то же правило у файла-копии
 * и у репозитория данных.
 */
export function checkSnapshotVersion(
  fileVersion: number,
  steps: readonly Migration[],
  current: number,
): void {
  if (fileVersion > current) {
    throw new Error(
      `Файл сделан в более новой версии приложения (схема ${fileVersion}, ` +
        `здесь ${current}). Обновите приложение.`,
    )
  }
  if (fileVersion === current) return

  const blocking = steps.filter(
    (step) => step.to > fileVersion && step.to <= current && !step.additive,
  )
  if (blocking.length === 0) return

  throw new Error(
    `Файл со схемой ${fileVersion}, здесь ${current}. С тех пор изменилась форма ` +
      `записей (${blocking.map((step) => step.note).join('; ')}), ` +
      'а миграция содержимого файла не написана.',
  )
}

// ─── Постоянное хранилище ──────────────────────────────────────────────────

/**
 * Просит у браузера постоянное хранилище (Р-61 «Дневников»). Без него браузер вправе
 * стереть базу при нехватке места, а Safari на iPhone — и за долгое
 * неиспользование. Отказ не ошибка: работать можно и так.
 */
async function persist(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') {
      return false
    }
    if (await navigator.storage.persisted()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

/** Дал ли браузер постоянное хранилище. Null — браузер об этом не сообщает. */
async function persisted(): Promise<boolean | null> {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.persisted !== 'function') {
      return null
    }
    return await navigator.storage.persisted()
  } catch {
    return null
  }
}

// ─── База приложения ───────────────────────────────────────────────────────

/**
 * База приложения по его конфигу. Зовётся один раз — из `src/app/core.ts`;
 * две базы одного имени на странице поделили бы соединение и слушателей
 * неправильно.
 */
export function createDb<R extends StoreMap>(config: AppConfig<R>) {
  checkConfig(config)

  type S_ = StoreOf<R>
  const SYNCED: readonly S_[] = config.stores

  /**
   * Оповещение об изменениях.
   *
   * `db` просто объявляет, что записал; кто на это подпишется — его дело.
   * Так синхронизация узнаёт, что пора отправлять, а экраны — что данные
   * приехали с другого устройства, и при этом `db` по-прежнему не знает
   * ни про `sync`, ни про модули.
   */
  const changeListeners = new Set<(event: ChangeEvent<R>) => void>()

  function onChange(listener: (event: ChangeEvent<R>) => void): () => void {
    changeListeners.add(listener)
    return () => {
      changeListeners.delete(listener)
    }
  }

  function announce(event: ChangeEvent<R>): void {
    for (const listener of changeListeners) {
      // Упавший слушатель не должен ронять запись: она уже прошла.
      try {
        listener(event)
      } catch {
        // Некому сообщить: сюда попадает только ошибка самого подписчика.
      }
    }
  }

  // ─── Соединение ──────────────────────────────────────────────────────────

  let connection: Promise<IDBDatabase> | null = null

  function open(): Promise<IDBDatabase> {
    if (connection) return connection

    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(config.dbName, config.schemaVersion)

      request.onupgradeneeded = (event) => {
        const tx = request.transaction
        if (!tx) {
          reject(new Error('Обновление базы без транзакции'))
          return
        }
        upgrade(request.result, tx, event.oldVersion)
      }

      request.onsuccess = () => {
        const database = request.result
        // Другая вкладка запросила версию выше. Не отпустим соединение —
        // её обновление зависнет молча, и она останется на старой схеме.
        database.onversionchange = () => {
          database.close()
          connection = null
        }
        resolve(database)
      }

      request.onerror = () => reject(request.error ?? new Error('База не открылась'))
      request.onblocked = () =>
        reject(new Error('База занята другой вкладкой приложения. Закройте её и обновите страницу.'))
    })

    // Провал не кешируем: следующий вызов должен попробовать заново.
    connection.catch(() => {
      connection = null
    })

    return connection
  }

  /**
   * Свежая база создаётся в раскладке версии 1, после чего к ней применяются
   * все миграции по порядку. Тот же путь, что у базы, приехавшей с версии 1, —
   * значит расхождений между «поставил давно» и «поставил сегодня» не будет.
   */
  function upgrade(
    database: IDBDatabase,
    tx: IDBTransaction,
    from: number,
    to: number = config.schemaVersion,
  ): void {
    if (from < 1) createStores(database)

    for (const migration of [...config.migrations].sort((a, b) => a.to - b.to)) {
      if (migration.to > from && migration.to <= to) migration.run(database, tx)
    }
  }

  /**
   * База в раскладке версии `version`, с записями внутри — ровно так она лежит
   * на копии, ещё не получившей обновление. Приложение это не зовёт: нужно
   * проверке на настоящих данных (Р-72 «Дневников»), где такую базу затем открывает
   * текущий код и проводит через миграции тем же путём, что у человека.
   *
   * Возвращает хранилища, которых в той версии не было, а записи для них
   * пришли, — это расхождение копии со схемой, и промолчать о нём нельзя.
   */
  async function createLegacyBase(
    version: number,
    data: Partial<StoreData<R>>,
  ): Promise<string[]> {
    if (!Number.isInteger(version) || version < 1 || version > config.schemaVersion) {
      throw new Error(`Схемы ${version} не бывает: здесь от 1 до ${config.schemaVersion}`)
    }
    if (connection) {
      ;(await connection).close()
      connection = null
    }

    return new Promise((resolve, reject) => {
      const skipped: string[] = []
      const request = indexedDB.open(config.dbName, version)
      request.onupgradeneeded = (event) => {
        const tx = request.transaction
        if (!tx) {
          reject(new Error('Обновление базы без транзакции'))
          return
        }
        upgrade(request.result, tx, event.oldVersion, version)
        for (const [store, records] of Object.entries(data) as [string, Base[] | undefined][]) {
          if (!request.result.objectStoreNames.contains(store)) {
            if (records && records.length > 0) skipped.push(store)
            continue
          }
          const target = tx.objectStore(store)
          for (const record of records ?? []) target.put(record)
        }
      }
      request.onsuccess = () => {
        request.result.close()
        resolve(skipped)
      }
      request.onerror = () => reject(request.error ?? new Error('База не создалась'))
    })
  }

  /**
   * Раскладка версии 1 — заморожена (`v1Stores` конфига). Хранилища,
   * появившиеся позже, заводят только их миграции: свежая база строится как
   * версия 1 и доезжает до текущей теми же шагами, что и база установленной
   * копии. Иначе шаг миграции на свежей базе споткнулся бы о хранилище,
   * которое уже есть.
   */
  function createStores(database: IDBDatabase): void {
    for (const store of config.v1Stores) {
      const created = database.createObjectStore(store, { keyPath: 'id' })
      created.createIndex('updatedAt', 'updatedAt') // нужен слиянию
      for (const field of config.indexes[store]) created.createIndex(field, field)
    }

    database.createObjectStore('meta', { keyPath: 'key' })
    // Настройки не синхронизируются: здесь лежит токен доступа.
    database.createObjectStore('settings', { keyPath: 'key' })
    database.createObjectStore('dirty', { keyPath: ['store', 'id'] })
  }

  // ─── Чтение ──────────────────────────────────────────────────────────────

  async function get<S extends S_>(store: S, id: string): Promise<R[S] | undefined> {
    const database = await open()
    const tx = database.transaction(store, 'readonly')
    return req<R[S] | undefined>(tx.objectStore(store).get(id))
  }

  async function getAll<S extends S_>(
    store: S,
    options: { includeDeleted?: boolean } = {},
  ): Promise<R[S][]> {
    const database = await open()
    const tx = database.transaction(store, 'readonly')
    const all = await req<R[S][]>(tx.objectStore(store).getAll())
    return options.includeDeleted ? all : all.filter((record) => !record.deleted)
  }

  /**
   * Записи, у которых поле индекса совпало с ключом или легло в диапазон,
   * границы включительно (Я-08). Месяц истории — без чтения всех лет.
   *
   * Индекс ищется в базе на устройстве, а не в конфиге: индекс хранилища,
   * заведённого миграцией, живёт только в её шаге. Записи без поля (`null`,
   * не задано) в индекс не попадают — так устроен IndexedDB.
   */
  async function getByIndex<S extends S_>(
    store: S,
    index: string,
    match: IndexMatch,
    options: { includeDeleted?: boolean } = {},
  ): Promise<R[S][]> {
    const database = await open()
    const tx = database.transaction(store, 'readonly')
    const target = tx.objectStore(store)
    if (!target.indexNames.contains(index)) {
      throw new Error(
        `У хранилища «${store}» нет индекса «${index}» на этом устройстве. ` +
          'Индекс после первого релиза заводится шагом миграции (Я-08)',
      )
    }
    const all = await req<R[S][]>(target.index(index).getAll(keyRange(match)))
    return options.includeDeleted ? all : all.filter((record) => !record.deleted)
  }

  async function count(store: S_, options: { includeDeleted?: boolean } = {}): Promise<number> {
    if (options.includeDeleted) {
      const database = await open()
      const tx = database.transaction(store, 'readonly')
      return req(tx.objectStore(store).count())
    }
    return (await getAll(store)).length
  }

  // ─── Запись ──────────────────────────────────────────────────────────────

  /**
   * Общий путь записи. Разница между происхождениями ровно в двух флагах,
   * и держать её в одном месте надёжнее, чем в трёх похожих функциях.
   */
  async function write<S extends S_>(
    store: S,
    records: readonly R[S][],
    origin: Origin,
  ): Promise<R[S][]> {
    if (records.length === 0) return []

    const touch = origin === 'local'
    const markDirty = origin !== 'remote'
    const at = nowIso()

    const saved = records.map((record) => (touch ? ({ ...record, updatedAt: at } as R[S]) : record))

    const database = await open()
    const stores = markDirty ? [store, 'dirty'] : [store]
    const tx = database.transaction(stores, 'readwrite')
    const target = tx.objectStore(store)
    const dirty = markDirty ? tx.objectStore('dirty') : null

    for (const record of saved) {
      target.put(record)
      dirty?.put({ store, id: record.id, at: record.updatedAt } satisfies DirtyRef<R>)
    }

    await finished(tx)
    announce({ store, origin, count: saved.length })
    return saved
  }

  /** Правка на этом устройстве: двигает `updatedAt`, метит грязной. */
  async function put<S extends S_>(store: S, record: R[S]): Promise<R[S]> {
    const saved = await write(store, [record], 'local')
    // Ровно один элемент на входе — ровно один на выходе.
    return saved[0] ?? record
  }

  async function putMany<S extends S_>(store: S, records: readonly R[S][]): Promise<R[S][]> {
    return write(store, records, 'local')
  }

  /**
   * Пришло с сервера: `updatedAt` чужой и остаётся как есть, грязной запись
   * не метится. Иначе синхронизация зацикливается сама на себе — отправит
   * то, что только что получила.
   */
  async function putRemote<S extends S_>(store: S, records: readonly R[S][]): Promise<void> {
    await write(store, records, 'remote')
  }

  /**
   * Мягкое удаление. Записи не было — вернёт false, надгробие на пустом
   * месте не ставится.
   */
  async function remove<S extends S_>(store: S, id: string): Promise<boolean> {
    const existing = await get(store, id)
    if (!existing) return false
    await put(store, { ...existing, deleted: true })
    return true
  }

  /**
   * Слияние по правилу Р-07 «Дневников»: по `id` побеждает версия с более поздним
   * `updatedAt`. Сравнение по отдельной записи, а не по файлу целиком —
   * иначе запись с телефона затирает запись с компа.
   *
   * Возвращает, сколько записей действительно применилось.
   */
  async function merge<S extends S_>(
    store: S,
    incoming: readonly R[S][],
    origin: Exclude<Origin, 'local'>,
  ): Promise<number> {
    if (incoming.length === 0) return 0

    const local = new Map(
      (await getAll(store, { includeDeleted: true })).map((record) => [record.id, record]),
    )

    const winners = incoming.filter((record) => {
      const current = local.get(record.id)
      return !current || record.updatedAt > current.updatedAt
    })

    await write(store, winners, origin)
    return winners.length
  }

  // ─── Очередь изменений ───────────────────────────────────────────────────

  async function listDirty(): Promise<DirtyRef<R>[]> {
    const database = await open()
    const tx = database.transaction('dirty', 'readonly')
    return req<DirtyRef<R>[]>(tx.objectStore('dirty').getAll())
  }

  /**
   * Снимает пометки после успешной отправки.
   *
   * Пометка снимается, только если запись с тех пор не менялась: сравнивается
   * `at`. Без этой проверки правка, сделанная во время отправки, потерялась бы
   * молча — самый неприятный вид потери данных.
   */
  async function clearDirty(refs: readonly DirtyRef<R>[]): Promise<void> {
    if (refs.length === 0) return

    const database = await open()
    const tx = database.transaction('dirty', 'readwrite')
    const dirty = tx.objectStore('dirty')

    for (const ref of refs) {
      const key: [string, string] = [ref.store, ref.id]
      const current = await req<DirtyRef<R> | undefined>(dirty.get(key))
      if (current && current.at === ref.at) dirty.delete(key)
    }

    await finished(tx)
  }

  // ─── Настройки и служебное ───────────────────────────────────────────────

  function keyValue(store: 'settings' | 'meta'): KeyValue {
    return {
      async get<T>(key: string): Promise<T | undefined> {
        const database = await open()
        const tx = database.transaction(store, 'readonly')
        const row = await req<{ key: string; value: T } | undefined>(tx.objectStore(store).get(key))
        return row?.value
      },

      async set(key: string, value: unknown): Promise<void> {
        const database = await open()
        const tx = database.transaction(store, 'readwrite')
        tx.objectStore(store).put({ key, value })
        await finished(tx)
      },

      async remove(key: string): Promise<void> {
        const database = await open()
        const tx = database.transaction(store, 'readwrite')
        tx.objectStore(store).delete(key)
        await finished(tx)
      },

      async keys(): Promise<string[]> {
        const database = await open()
        const tx = database.transaction(store, 'readonly')
        const keys = await req(tx.objectStore(store).getAllKeys())
        return keys.map(String)
      },
    }
  }

  const settings = keyValue('settings')
  const meta = keyValue('meta')

  // ─── Перенос файлом ──────────────────────────────────────────────────────

  /**
   * Разбор файла слепка.
   *
   * Единственное место, где в базу может заехать что угодно: файл приходит
   * из файловой системы, его никто не проверял. Поэтому форма сверяется до
   * записи, и при несходстве файл отвергается целиком — половина
   * импортированных данных хуже, чем внятный отказ.
   */
  function parseSnapshot(text: string): Snapshot<R> {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error('Это не JSON')
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('В файле не объект')
    }

    const raw = value as Partial<Snapshot<R>>
    if (typeof raw.schemaVersion !== 'number') {
      throw new Error(`В файле нет версии схемы — это не слепок приложения «${config.name}»`)
    }
    if (typeof raw.data !== 'object' || raw.data === null) {
      throw new Error('В файле нет данных')
    }

    const source = raw.data as Record<string, unknown>
    const data = {} as StoreData<R>

    for (const store of SYNCED) {
      const records = source[store]
      // Отсутствующее хранилище — пустое. Файл мог уехать с устройства,
      // где этого модуля ещё не было, и это не повод отвергать весь слепок.
      if (records === undefined) {
        Object.assign(data, { [store]: [] })
        continue
      }
      if (!Array.isArray(records)) throw new Error(`Хранилище «${store}» не массив`)

      for (const record of records) {
        const id = (record as Partial<Base>)?.id
        const updatedAt = (record as Partial<Base>)?.updatedAt
        if (typeof id !== 'string' || !id || typeof updatedAt !== 'string' || !updatedAt) {
          throw new Error(`В хранилище «${store}» запись без id или updatedAt`)
        }
      }
      Object.assign(data, { [store]: records })
    }

    return {
      schemaVersion: raw.schemaVersion,
      exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : nowIso(),
      data,
    }
  }

  /**
   * Полный слепок синхронизируемых данных.
   * Удалённые записи включены: без надгробий второе устройство их воскресит.
   */
  async function exportAll(): Promise<Snapshot<R>> {
    const data = {} as StoreData<R>

    for (const store of SYNCED) {
      // Присваивание через промежуточную переменную — иначе TypeScript
      // не связывает ключ и тип записи.
      Object.assign(data, { [store]: await getAll(store, { includeDeleted: true }) })
    }

    return { schemaVersion: config.schemaVersion, exportedAt: nowIso(), data }
  }

  /**
   * Загрузка слепка. Сливается по Р-07 «Дневников», а не затирает: файл может быть старше
   * того, что уже есть на устройстве.
   *
   * Записи метятся грязными — они пришли из файла, а не с сервера, и должны
   * уехать в синхронизацию.
   */
  async function importAll(snapshot: Snapshot<R>): Promise<number> {
    checkVersion(snapshot.schemaVersion)

    let applied = 0
    for (const store of SYNCED) {
      applied += await merge(store, snapshot.data[store], 'imported')
    }
    return applied
  }

  /**
   * Версия файла или репозитория против текущей схемы приложения. Реестр
   * и текущая версия — параметры: иначе проверку не проверить тестами, пока
   * реестр пуст.
   */
  function checkVersion(
    fileVersion: number,
    steps: readonly Migration[] = config.migrations,
    current: number = config.schemaVersion,
  ): void {
    checkSnapshotVersion(fileVersion, steps, current)
  }

  // ─── Публичный интерфейс ─────────────────────────────────────────────────

  return {
    get,
    getAll,
    getByIndex,
    count,
    put,
    putMany,
    putRemote,
    remove,
    merge,
    listDirty,
    clearDirty,
    onChange,
    exportAll,
    importAll,
    parseSnapshot,
    checkSnapshotVersion: checkVersion,
    createLegacyBase,
    settings,
    meta,
    persist,
    persisted,

    /** Открывает базу и отмечает версию схемы. Вызывается на старте. */
    async ready(): Promise<void> {
      await open()
      await meta.set('schemaVersion', config.schemaVersion)
    },

    /** Закрывает соединение. Нужно тестам и переключению вкладок. */
    async close(): Promise<void> {
      if (!connection) return
      const database = await connection
      database.close()
      connection = null
    },
  }
}

/** База приложения с таблицей хранилищ `R`. */
export type Db<R extends StoreMap = StoreMap> = ReturnType<typeof createDb<R>>
