/**
 * Демо-данные (Я-44, Я-45): посмотреть приложение на выдуманных записях,
 * не смешивая их с настоящими.
 *
 * Демо живёт в своей базе `<dbName>-demo` — та же раскладка и те же
 * миграции, что у настоящей, но без синхронизации: ошибка фильтра не увезёт
 * выдуманное в репозиторий данных, потому что фильтра нет. Настоящая база
 * в демо не открывается.
 *
 * Режим выбирается до открытия базы, поэтому признак — в `localStorage`,
 * а не в `settings`: его можно прочитать синхронно на старте, когда `db`
 * и `sync` ещё только собираются. Ключ — с `dbName`: `localStorage` общий
 * на origin всей семьи. Работник `localStorage` не видит — он всегда
 * с настоящей базой. Стёртые данные сайта — признака нет, приложение
 * открывается в настоящей базе: это безопасная сторона.
 *
 * Здесь — имена, признак и чистые правила. Стирание базы — `core/db.ts`
 * (к IndexedDB ходит только он), вход и выход с перезагрузкой — `ui/demo.ts`.
 */

import type { DateStr } from './dates.ts'
import type { AppConfig, StoreMap } from './model.ts'

/** Окончание имени демо-базы. В договоре «Устройство и origin» занято ядром (Я-44). */
export const DEMO_SUFFIX = '-demo'

/** Имя демо-базы приложения: `deluvremya-demo`. */
export function demoDbName(dbName: string): string {
  return dbName + DEMO_SUFFIX
}

/** Ключ признака в `localStorage`: `deluvremya:demo`. */
export function demoKey(dbName: string): string {
  return `${dbName}:demo`
}

/** То, чем пользуется признак: `localStorage` или подставное хранилище тестов. */
export type FlagStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/**
 * `localStorage` страницы. Нет его (работник, node) или браузер не пускает
 * (запрет сайту хранить данные) — null: демо нет, база настоящая.
 */
export function pageStorage(): FlagStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Что признаку нужно от конфига: имя базы и есть ли демо вообще. */
type DemoConfig = { dbName: string; demo?: unknown }

/**
 * Включено ли демо на этой странице. Признак без функции `demo` в конфиге
 * не в счёт: у приложения нет демо, и база у него одна.
 */
export function isDemo(config: DemoConfig, storage: FlagStorage | null = pageStorage()): boolean {
  if (typeof config.demo !== 'function' || !storage) return false
  try {
    return storage.getItem(demoKey(config.dbName)) === '1'
  } catch {
    return false
  }
}

/** Поставить или снять признак. Без перезагрузки не действует: база уже открыта. */
export function setDemoFlag(dbName: string, on: boolean, storage: FlagStorage | null = pageStorage()): void {
  if (!storage) throw new Error('Браузер не даёт хранить настройки сайта — демо не включить')
  if (on) storage.setItem(demoKey(dbName), '1')
  else storage.removeItem(demoKey(dbName))
}

/**
 * Предлагать ли демо на первом запуске (Я-44, Я-45): у приложения есть демо,
 * сейчас не демо, база посчитана и пуста, токена «семья» нет и предложение
 * ещё не показывали. Токен — значит, это устройство человека с данными,
 * просто ещё не синхронизированное: ему демо не предлагают.
 *
 * Пока что-то не прочитано (`null`), не предлагать: мигнуть предложением
 * человеку с данными хуже, чем показать его на миг позже.
 */
export function showDemoOffer(state: {
  hasDemo: boolean
  demo: boolean
  empty: boolean | null
  hasToken: boolean | null
  offered: boolean | null
}): boolean {
  return (
    state.hasDemo &&
    !state.demo &&
    state.empty === true &&
    state.hasToken === false &&
    state.offered === false
  )
}

/**
 * Сторож полноты демо (Я-45): каждое хранилище из `stores` получает хотя бы
 * одну запись, лишних хранилищ нет, у каждой записи — поля `Base`, `id` не
 * повторяются. Возвращает изъяны; пустой список — демо в порядке.
 *
 * Приложение с `demo` зовёт его одним тестом в своём `npm test`: новое
 * хранилище без строки в демо — красный тест у того, кто его добавил.
 */
export function checkDemo<R extends StoreMap>(config: AppConfig<R>, day: DateStr): string[] {
  if (!config.demo) return ['у приложения нет функции demo']

  let data: Record<string, unknown>
  try {
    data = config.demo(day) as Record<string, unknown>
  } catch (error) {
    return [`demo упала: ${error instanceof Error ? error.message : String(error)}`]
  }

  const problems: string[] = []
  const stores = new Set<string>(config.stores)

  for (const store of Object.keys(data)) {
    if (!stores.has(store)) problems.push(`«${store}» нет в stores — его записи некуда положить`)
  }

  for (const store of config.stores) {
    const records = data[store]
    if (!Array.isArray(records)) {
      problems.push(`у «${store}» нет демо-записей`)
      continue
    }
    if (records.length === 0) problems.push(`у «${store}» нет ни одной демо-записи`)

    const ids = new Set<string>()
    records.forEach((record: unknown, at) => {
      const row = record as { id?: unknown; updatedAt?: unknown; deleted?: unknown } | null
      if (typeof row !== 'object' || row === null) {
        problems.push(`«${store}» [${at}]: не запись`)
        return
      }
      if (typeof row.id !== 'string' || row.id === '') problems.push(`«${store}» [${at}]: нет id`)
      else if (ids.has(row.id)) problems.push(`«${store}»: id ${row.id} повторяется`)
      else ids.add(row.id)
      if (typeof row.updatedAt !== 'string' || Number.isNaN(Date.parse(row.updatedAt))) {
        problems.push(`«${store}» [${at}]: нет updatedAt`)
      }
      if (row.deleted !== undefined && typeof row.deleted !== 'boolean') {
        problems.push(`«${store}» [${at}]: deleted не true/false`)
      }
    })
  }

  return problems
}
