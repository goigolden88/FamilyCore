/**
 * Раскладка записей по файлам репозитория данных.
 *
 * Здесь нет ни сети, ни базы: на входе записи, на выходе строки. Всё, что
 * можно проверить тестами в синхронизации, живёт в этом файле.
 *
 * Почему раскладка здесь, а не в `db` (Р-18 «Дневников»): если хранилище знает про
 * `cycles/2026.json`, оно знает про способ хранения на сервере, и замена
 * GitHub задела бы базу, а не только синхронизацию.
 *
 * Почему таблица мест не в модулях: тогда `sync` знал бы про модули, а это
 * запрещено жёстче. Таблица — `places` в `AppConfig` приложения (Р-47
 * «Трапезы»); новый модуль дописывает туда строку.
 *
 * Нарезка нужна git и сети, а не человеку: без неё каждая отметка
 * переписывала бы всю базу и раздувала историю коммитов (Р-08 «Дневников»).
 * Нарезка — по годам, как у них, или по месяцам (Р-28 «Делу Время»: годовой
 * файл блоков к декабрю отправлялся бы по полмегабайта на каждое нажатие);
 * выбирает приложение для каждого хранилища (Я-09).
 *
 * Сама раскладка — договор семьи (02-Архитектура, «Раскладка репозитория
 * данных»): её читает метаприложение.
 */

import { isDateOrMonth } from './dates.ts'
import type { AppConfig, Base, Place, StoreMap, StoreOf } from './model.ts'

/**
 * Срез итогов (Я-16): пишет проход синхронизации, `storeOf` его не знает —
 * приложение срез не читает. Здесь, рядом с остальными путями, а не
 * в `summary.ts`: тот сам берёт отсюда канонический вид.
 */
export const SUMMARY_PATH = 'summary.json'

export type RepoFile = {
  path: string
  content: string
}

/**
 * Чей репозиторий и какой версии схемы — отдельным файлом: по нему проверяется
 * совместимость и то, что репозиторий — этого приложения (Я-24).
 */
export const META_PATH = 'meta.json'

/**
 * README кладёт проход синхронизации, если его в репозитории нет, и не
 * трогает, если есть (Р-69 «Делу Время»): правка человека остаётся, а два
 * устройства на разных сборках не переписывают его друг за другом.
 * Своим файлом для разбора он не считается — `storeOf` его не знает.
 */
export const README_PATH = 'README.md'

/**
 * Куда попадают записи без года (Р-34 «Дневников»).
 *
 * Заведено ради списка «к просмотру»: у записи `planned` даты начала нет
 * вовсе, а нарезка её требует. Месяц по времени создания не годится —
 * такого поля в модели нет, а выводить его из `id` нельзя: у перенесённых
 * из Obsidian записей идентификаторы детерминированные, не ULID.
 *
 * Сюда же падает запись с испорченной датой. Это лучше, чем потерять её
 * молча: файл на месте, запись видна, дату можно поправить руками.
 */
const UNDATED = 'undated'

// ─── Канонический вид ──────────────────────────────────────────────────────

/**
 * Одинаковые данные обязаны давать побайтово одинаковый файл.
 *
 * Иначе отпечаток каждый раз новый, и каждая синхронизация переписывает весь
 * репозиторий — ровно то, ради чего заведена нарезка (Р-33 «Дневников»).
 * Порядок ключей в объекте зависит от того, как запись собиралась: пришла ли
 * она из формы, из переноса или с сервера. Поэтому ключи сортируются, а
 * записи выстраиваются по `id`.
 *
 * Массивы не трогаются: порядок симптомов и ссылок — это данные.
 */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value !== 'object' || value === null) return value

  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) sorted[key] = sortKeys(source[key])
  return sorted
}

/** Записи → текст файла. Перевод строки в конце — файл должен быть текстовым. */
export function canonical(records: readonly Base[]): string {
  const ordered = [...records].sort((a, b) => a.id.localeCompare(b.id))
  return `${JSON.stringify(ordered.map(sortKeys), null, 2)}\n`
}

/** `meta.json`: `app` — `dbName` приложения (Я-24); ключи по алфавиту, как у файлов хранилищ. */
export function metaFile(app: string, schemaVersion: number): RepoFile {
  return { path: META_PATH, content: `${JSON.stringify({ app, schemaVersion }, null, 2)}\n` }
}

/**
 * Имя файла записи в нарезанном хранилище, без `.json`: `2026-02-14` →
 * `2026-02` по месяцам, `2026` по годам. Не дата — null: запись уедет
 * в undated.
 *
 * Год — первые четыре знака, а не число (Я-09): `0999` остаётся `0999`,
 * и `storeOf` узнаёт файл обратно.
 */
function bucketOf(split: 'month' | 'year', date: string): string | null {
  if (!isDateOrMonth(date)) return null
  return split === 'month' ? date.slice(0, 7) : date.slice(0, 4)
}

/** Имя файла месяца: `2026-02`. Месяц тринадцатый — файл не наш. */
const MONTH_FILE = '\\d{4}-(?:0[1-9]|1[0-2])'

/** Имя файла года: `2026` (Я-09). */
const YEAR_FILE = '\\d{4}'

/**
 * Разбор файла, пришедшего с сервера.
 *
 * Проверяется только то, на чём держится слияние: массив, у каждой записи
 * есть `id` и `updatedAt`. Глубже не лезем — тот же уровень доверия, что
 * у `db.parseSnapshot`, и та же причина: сломанный файл лучше отвергнуть
 * целиком, чем влить половину.
 */
export function parseFile(path: string, text: string): Base[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`Файл ${path} в репозитории — не JSON`)
  }
  if (!Array.isArray(value)) throw new Error(`Файл ${path} в репозитории — не список записей`)

  for (const record of value) {
    const id = (record as Partial<Base> | null)?.id
    const updatedAt = (record as Partial<Base> | null)?.updatedAt
    if (typeof id !== 'string' || !id || typeof updatedAt !== 'string' || !updatedAt) {
      throw new Error(`В файле ${path} запись без id или updatedAt`)
    }
  }

  return value as Base[]
}

// ─── Раскладка приложения ──────────────────────────────────────────────────

/** Раскладка по таблице мест приложения — `places` его конфига. */
export function createLayout<R extends StoreMap>(config: AppConfig<R>) {
  type S_ = StoreOf<R>

  function placeOf<S extends S_>(store: S): Place<R[S]> {
    return config.places[store] as Place<R[S]>
  }

  // ─── Записи → файлы ──────────────────────────────────────────────────────

  function pathFor<S extends S_>(store: S, record: R[S]): string {
    const place = placeOf(store)
    if (place.split === 'none') return place.path

    const date = place.dateOf(record)
    const bucket = date === null ? null : bucketOf(place.split, date)
    return `${place.dir}/${bucket ?? UNDATED}.json`
  }

  /** Все файлы, которые хранилище занимает при таком наборе записей. */
  function filesFor<S extends S_>(store: S, records: readonly R[S][]): RepoFile[] {
    const byPath = new Map<string, R[S][]>()

    // Хранилище без нарезки существует всегда, даже пустым: так раскладка
    // репозитория видна глазами, а не выводится из того, что успело появиться.
    const place = placeOf(store)
    if (place.split === 'none') byPath.set(place.path, [])

    for (const record of records) {
      const path = pathFor(store, record)
      const bucket = byPath.get(path)
      if (bucket) bucket.push(record)
      else byPath.set(path, [record])
    }

    return [...byPath].map(([path, bucket]) => ({ path, content: canonical(bucket) }))
  }

  /**
   * Полное дерево файлов по содержимому базы.
   *
   * Собирается целиком, а не по списку изменённых записей (Р-33 «Дневников»): у отметки
   * может смениться дата, а с ней месяц или год — по пометке «запись такая-то изменилась»
   * старый файл не найти. Отправлены будут только те файлы, чей отпечаток
   * разошёлся с деревом на сервере, так что прошлые месяцы и годы не переписываются.
   *
   * `merged` — пути, чьё содержимое уже влито в базу на этом же проходе. Если
   * месяц или год опустел (последняя запись переехала в другой), его файл перезаписывается
   * пустым списком; без этого на сервере навсегда осталась бы копия записи.
   * Пути, которые не читались, сюда передавать нельзя — затрём чужие данные.
   */
  function buildFiles(
    data: { [S in S_]: readonly R[S][] },
    options: { schemaVersion?: number; merged?: readonly string[] } = {},
  ): RepoFile[] {
    const files: RepoFile[] = [metaFile(config.dbName, options.schemaVersion ?? config.schemaVersion)]

    for (const store of config.stores) {
      files.push(...filesFor(store, data[store]))
    }

    const produced = new Set(files.map((file) => file.path))
    const empty = `${JSON.stringify([], null, 2)}\n`
    for (const path of options.merged ?? []) {
      if (!produced.has(path) && storeOf(path) !== null) {
        files.push({ path, content: empty })
      }
    }

    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  // ─── README репозитория данных ───────────────────────────────────────────

  /** Таблица файлов — из раскладки, поэтому с ней не разойдётся. */
  function readmeRows(): string[] {
    const rows = [`| \`${META_PATH}\` | чьи данные и версия схемы |`]
    for (const store of config.stores) {
      const place = placeOf(store)
      if (place.split === 'none') {
        rows.push(`| \`${place.path}\` | ${config.storeNotes[store]} |`)
      } else {
        const name = place.split === 'month' ? 'ГГГГ-ММ' : 'ГГГГ'
        rows.push(`| \`${place.dir}/${name}.json\` | ${config.storeNotes[store]} |`)
        rows.push(`| \`${place.dir}/${UNDATED}.json\` | те же записи без разбираемой даты |`)
      }
    }
    // Строка среза — только у приложения, которое его пишет: README
    // остальных не меняется ни на байт.
    if (config.summary) {
      rows.push(`| \`${SUMMARY_PATH}\` | срез итогов для метаприложения семьи: считает приложение, само его не читает |`)
    }
    return rows
  }

  /**
   * Что в прошлом не переписывается — словами раскладки. У приложения без
   * годовых мест — «месяцы», как было до Я-09: его README не меняется ни на байт.
   */
  function pastText(): string {
    const splits = new Set(config.stores.map((store) => placeOf(store).split))
    if (!splits.has('year')) return 'Прошлые месяцы'
    return splits.has('month') ? 'Прошлые месяцы и годы' : 'Прошлые годы'
  }

  function readmeFile(): RepoFile {
    const text = [
      `# Данные приложения «${config.name}»`,
      '',
      `Это хранилище данных приложения «${config.name}» — ${config.about.data}.`,
      'Код приложения лежит в отдельном публичном репозитории, здесь только записи.',
      '',
      `Репозиторий приватный и должен таким оставаться: ${config.about.privacy}.`,
      '',
      'Этот файл положило приложение, потому что его здесь не было. Править его можно —',
      'приложение его больше не трогает. Удалите — положит свежий.',
      '',
      '## Что тут лежит',
      '',
      '| Файл | Что внутри |',
      '|---|---|',
      ...readmeRows(),
      '',
      `${pastText()} не переписываются, пока в них ничего не правят: так каждое`,
      'нажатие кнопки не переписывает всю базу и не раздувает историю коммитов.',
      '',
      '## Правила',
      '',
      '**Руками файлы не править.** Приложение собирает файлы из своей базы на устройстве',
      'и отправляет то, что разошлось. Правка, сделанная здесь, будет затёрта следующей',
      'синхронизацией — если только не поднять у записи `updatedAt`, а этого делать',
      'не стоит: побеждает версия с более поздним временем правки, и так можно затереть',
      'свежую запись с телефона.',
      '',
      '**Удалённые записи остаются с меткой `deleted: true`.** Их нельзя вычищать:',
      'второе устройство при следующей синхронизации воскресит запись, у которой',
      'не осталось надгробия.',
      '',
      '**Свои файлы класть можно.** Что угодно — приложение читает только',
      'файлы из таблицы выше и остальных не касается.',
      '',
      '## Как это синхронизируется',
      '',
      'Каждое устройство держит полную копию данных у себя в браузере и работает',
      'без сети. Через несколько секунд после правки оно читает голову ветки, забирает',
      'разошедшиеся файлы, сливает их у себя по правилу «побеждает более поздняя правка',
      'отдельной записи» и отправляет своё одним коммитом.',
      '',
      '## Если приложение сломалось',
      '',
      'Данные отсюда можно забрать и без него: это обычный JSON. Обратно в приложение',
      'они загружаются файлом-копией — «Настройки» → «Экспорт и импорт» → «Восстановить',
      'из копии», но формат копии другой: один файл вместо этой раскладки. Копию делает',
      'само приложение кнопкой «Сохранить в файл».',
      '',
      '## Токены доступа',
      '',
      'У каждого устройства свой токен, выпущенный на нём же. Потерянный телефон',
      'отзывается одной кнопкой в настройках GitHub и не ломает остальные устройства.',
      'Токены хранятся только в браузере и в этот репозиторий не попадают никогда.',
    ]
    return { path: README_PATH, content: `${text.join('\n')}\n` }
  }

  // ─── Файлы → записи ──────────────────────────────────────────────────────

  /**
   * Какому хранилищу принадлежит путь. null — файл не наш: README, .gitignore,
   * что угодно ещё, что человек положит в репозиторий руками. Такие не трогаем.
   */
  function storeOf(path: string): S_ | null {
    for (const store of config.stores) {
      const place = placeOf(store)
      if (place.split === 'none') {
        if (place.path === path) return store
      } else {
        // Файл чужой нарезки в папке — не наш (Я-09): нарезка места не меняется.
        const name = place.split === 'month' ? MONTH_FILE : YEAR_FILE
        if (new RegExp(`^${place.dir}/(?:${name}|${UNDATED})\\.json$`).test(path)) return store
      }
    }
    return null
  }

  /**
   * Версия схемы из `meta.json`. Файла нет — репозиторий пуст, версия наша.
   *
   * Чужой `app` — репозиторий данных другого приложения семьи: с общим токеном
   * (Я-25) перепутанное имя репозитория больше не упирается в 404. Давний файл
   * без `app` принимается — имя допишет тот же проход (Я-24).
   */
  function parseMeta(text: string): number {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new Error('Файл meta.json в репозитории — не JSON')
    }
    const version = (value as { schemaVersion?: unknown } | null)?.schemaVersion
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new Error(`В meta.json нет версии схемы. Это не репозиторий приложения «${config.name}»`)
    }
    const app = (value as { app?: unknown }).app
    if (app !== undefined && app !== config.dbName) {
      throw new Error(
        `Репозиторий — данные другого приложения семьи (${String(app)}), а это приложение ` +
          `«${config.name}» (${config.dbName}). Ничего не скачано и не отправлено. ` +
          'Проверь имя репозитория в настройках синхронизации.',
      )
    }
    return version
  }

  return {
    buildFiles,
    readmeFile,
    storeOf,
    parseMeta,
    /** `meta.json` приложения; без версии — текущей схемы. */
    metaFile: (schemaVersion: number = config.schemaVersion): RepoFile => metaFile(config.dbName, schemaVersion),
  }
}

/** Раскладка приложения с таблицей хранилищ `R`. */
export type Layout<R extends StoreMap = StoreMap> = ReturnType<typeof createLayout<R>>
