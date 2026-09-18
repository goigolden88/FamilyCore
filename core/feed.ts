/**
 * Лента: строка ленты и общие операции над ней (Р-48 «Дневников»).
 *
 * Лента — единственное место, где записи разных модулей встречаются.
 * Ядро про модули при этом не знает: вид записи — строка приложения (`RecordKind` его модели),
 * а переводят свои записи в строки ленты сами модули, каждый в своём
 * `modules/<имя>/feed.ts`; обзор недели — `screens/reviewFeed.ts` (Р-60 «Делу Время»).
 * Сводит их вместе таблица `src/registry.ts`.
 *
 * Здесь только то, что одинаково для всех: порядок дат, разбивка по
 * месяцам, поиск и подписи. Чистые функции, без React и `db`.
 *
 * Взято из «Дневников». Своё «Делу Время» (Р-61 «Делу Время»): запись без даты законна
 * (Р-08 «Делу Время») и стоит внизу, а не наверху красным; дата ищется и словами —
 * тем же правилом ищут «Заметки».
 */

import { formatDate, formatDateLong, formatMonth, isDateOrMonth, isDateStr, isMonthStr, plural } from './dates.ts'

export type FeedItem<K extends string = string> = {
  kind: K
  /** id записи. Ключ в списке — вид вместе с id: хранилища разные. */
  id: string
  /**
   * Дата записи как она лежит: `YYYY-MM-DD` или нечитаемая строка; пусто —
   * даты нет (Р-08 «Делу Время»). Не приводится ни к чему: кривая строка не выбрасывается.
   */
  date: string
  title: string
  /** Строка под названием: вид и состояние, итог дня, наблюдение недели. */
  detail: string
  /** Куда ведёт тап. Путь хеш-роутинга. Нет — строка без перехода (Р-59 «Делу Время»). */
  link?: string
  /** Что ещё ищется, но не показывается: заметки блоков, дни плана и выполнения. */
  extra?: string
}

/** Дата строки, если она читается — днём или месяцем. Иначе null. */
export function readableDate(item: FeedItem): string | null {
  return isDateOrMonth(item.date) ? item.date : null
}

/**
 * Порядок ленты: новые сверху, без даты — внизу.
 *
 * Даты разной точности сравниваются как строки: `2026-09-10` больше
 * `2026-09`, так что запись, известная до месяца, встаёт в конец своего
 * месяца — после всех его дней, а не на первое число.
 *
 * Без даты — вниз, как на «Заметках»: здесь это законная запись, а не
 * поломка (Р-08 «Делу Время», Р-59 «Делу Время»). Сверху им не место, их находят поиском.
 *
 * Внутри одной даты — по виду в порядке реестра, затем по названию: порядок
 * хранилища не значит ничего.
 */
export function compareFeed(a: FeedItem, b: FeedItem, order: readonly string[] = []): number {
  const first = readableDate(a)
  const second = readableDate(b)
  if (first !== second) {
    if (first === null) return 1
    if (second === null) return -1
    return second.localeCompare(first)
  }
  return (
    order.indexOf(a.kind) - order.indexOf(b.kind) || a.title.localeCompare(b.title, 'ru') || a.id.localeCompare(b.id)
  )
}

export type FeedGroup = {
  /** `YYYY-MM`. null — у строк группы даты нет или она не читается. */
  month: string | null
  items: FeedItem[]
}

/** Разбивка по месяцам. На входе порядок любой; `order` — порядок видов внутри дня. */
export function groupFeed(items: readonly FeedItem[], order: readonly string[] = []): FeedGroup[] {
  const groups: FeedGroup[] = []
  for (const item of [...items].sort((a, b) => compareFeed(a, b, order))) {
    const date = readableDate(item)
    const month = date === null ? null : date.slice(0, 7)
    const last = groups.at(-1)
    if (last && last.month === month) last.items.push(item)
    else groups.push({ month, items: [item] })
  }
  return groups
}

/** Для поиска: регистр, «ё» и лишние пробелы не в счёт. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

/** Слова запроса. Пустой запрос — пустой список: подходит всё. */
export function queryWords(query: string): string[] {
  return normalize(query).split(' ').filter(Boolean)
}

/**
 * Дата всеми словами, какими её ищут: `2026-03-12`, `12.03.2026`,
 * «12 марта 2026» и «март 2026». Именительный нужен отдельно: «май»
 * в «мая» не входит. Нет даты — «без даты»; кривая — как лежит.
 */
export function dateWords(date: string | null): string {
  if (date === null || date === '') return 'без даты'
  if (isDateStr(date)) return `${date} ${formatDate(date)} ${formatDateLong(date)} ${formatMonth(date.slice(0, 7))}`
  if (isMonthStr(date)) return `${date} ${formatMonth(date)}`
  return date
}

export type FeedFilter = {
  /** Вид записи. null — все. */
  kind?: string | null
  query?: string
}

/**
 * Отбор по виду и поиск.
 *
 * Слова запроса ищутся по отдельности, и нужны все: «воды фильтр» находит
 * «Купить фильтр для воды», в каком бы порядке ни стояли слова в строке.
 * Ищется и то, что на экране не видно, — заметки блоков, дни плана, — и дата
 * цифрами и словами: `01.07`, «июль», «1 июля».
 */
export function filterFeed(items: readonly FeedItem[], filter: FeedFilter = {}): FeedItem[] {
  const words = queryWords(filter.query ?? '')

  return items.filter((item) => {
    if (filter.kind && item.kind !== filter.kind) return false
    if (words.length === 0) return true
    const haystack = normalize(`${item.title} ${item.detail} ${item.extra ?? ''} ${dateWords(item.date)}`)
    return words.every((word) => haystack.includes(word))
  })
}

/**
 * Дата в строке ленты. Месяц и год уже стоят заголовком группы, так что
 * у дня — только число и месяц.
 *
 * Дата, известная до месяца, называется прямо — «без числа». Нечитаемая
 * показывается как есть; без даты — прочерк: группа и так «Без даты».
 */
export function feedDateText(date: string): string {
  if (isDateStr(date)) return formatDate(date).slice(0, 5)
  if (isMonthStr(date)) return 'без числа'
  return date || '—'
}

/** Заголовок группы: «Сентябрь 2026» либо «Без даты». */
export function feedHeading(month: string | null): string {
  if (month === null) return 'Без даты'
  const text = formatMonth(month)
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** «12 записей» — счётчик под фильтрами. */
export function recordsText(count: number): string {
  return `${count} ${plural(count, ['запись', 'записи', 'записей'])}`
}

/**
 * Текст пользователя для markdown-выгрузки: служебные знаки экранируются,
 * переносы строк становятся пробелами.
 *
 * Текст «*важно* купить» иначе стал бы курсивом, а заметка в три строки
 * разорвала бы пункт списка на куски.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([\\`*_[\]#|<>])/g, '\\$1')
}
