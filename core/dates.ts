/**
 * Даты и русские склонения.
 *
 * Дата события хранится строкой `YYYY-MM-DD` — календарный день без времени
 * и без часового пояса. «5 сентября» одинаково в Москве и в Лиссабоне,
 * а Date этого не умеет: он всегда момент времени.
 *
 * Главная ловушка здесь одна. `new Date('2026-09-07')` разбирается как UTC,
 * и в минусовом поясе даст 6 сентября — «сегодня» окажется вчерашним.
 * Поэтому дата нигде не строится из строки: только new Date(y, m - 1, d)
 * по разобранным числам.
 */

/** Календарный день в формате `YYYY-MM-DD`. */
export type DateStr = string

/**
 * Месяц в формате `YYYY-MM` — дата, у которой день неизвестен.
 *
 * Заведён под контент (Р-25): в дневнике просмотренного дней нет вовсе.
 * Арифметике по дням не поддаётся, и функции ниже на нём кидают, а не
 * подставляют первое число молча.
 */
export type MonthStr = string

const MS_PER_DAY = 86_400_000

const MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]

/**
 * Сокращения для подписей под столбиками. Лежат здесь, а не в модуле:
 * ими пользуются и сезонность болезней, и разбивка контента по месяцам,
 * а модули друг про друга не знают.
 */
export const MONTHS_SHORT = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
]

// Именительный падеж — для месяца, который стоит сам по себе:
// «январь 2026», а не «7 января 2026».
const MONTHS_NOMINATIVE = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
]

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const ISO_MONTH = /^(\d{4})-(\d{2})$/
// Разделители разбираются по отдельности: в данных Obsidian встречается
// «03.03-2026» — точка и дефис в одной дате.
const YMD = /^(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})$/
const DMY = /^(\d{1,2})[-.\/](\d{1,2})[-.\/](\d{2}|\d{4})$/

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Существует ли такой календарный день. Отсекает 31.02 и месяц 13. */
function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

function compose(y: number, m: number, d: number): DateStr | null {
  return isRealDate(y, m, d) ? `${y}-${pad2(m)}-${pad2(d)}` : null
}

/**
 * Двузначный год. 00–79 → 2000-е, 80–99 → 1900-е.
 * Порог выбран так, чтобы «24» читалось как 2024, а не 1924:
 * дневники ведутся про настоящее, дат из прошлого века в них нет.
 */
function expandYear(y: number): number {
  return y < 80 ? 2000 + y : 1900 + y
}

export function isDateStr(value: string): boolean {
  const m = ISO_DATE.exec(value)
  return m ? compose(Number(m[1]), Number(m[2]), Number(m[3])) !== null : false
}

/** `2026-01` — да. `2026-01-05` и `2026-13` — нет. */
export function isMonthStr(value: string): boolean {
  const m = ISO_MONTH.exec(value)
  if (!m) return false
  const month = Number(m[2])
  return month >= 1 && month <= 12
}

/**
 * Дата известной точности: полный день либо месяц. Р-25.
 *
 * Сравнивать такие строки между собой можно как есть — лексикографический
 * порядок совпадает с хронологическим, и `2026-01` встаёт перед `2026-01-05`.
 * Считать разницу в днях нельзя, для этого есть `isDateStr`.
 */
export function isDateOrMonth(value: string): boolean {
  return isDateStr(value) || isMonthStr(value)
}

/** Год из даты любой точности. `2026-01` и `2026-01-05` → `2026`. */
export function yearOf(value: string): number | null {
  return isDateOrMonth(value) ? Number(value.slice(0, 4)) : null
}

/** Разбирает DateStr в локальную полночь. Кидает на мусоре — см. `parseDate`. */
function toDate(d: DateStr): Date {
  const m = ISO_DATE.exec(d)
  if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    throw new Error(`Не дата: ${d}`)
  }
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function toDateStr(date: Date): DateStr {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function today(): DateStr {
  return toDateStr(new Date())
}

/** Время последней правки записи — поле `updatedAt`. */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Терпимый разбор даты из внешнего текста: ввод руками и импорт из Obsidian,
 * где по журналу лежат вперемешку «24.01.26», «20-02-2026», «03.03-2026».
 *
 * Возвращает null, а не кидает: неразобранная строка — это нормальный
 * результат для пользовательского ввода, а не поломка.
 */
export function parseDate(input: string): DateStr | null {
  const value = input.trim()
  if (!value) return null

  const ymd = YMD.exec(value)
  if (ymd) return compose(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))

  const dmy = DMY.exec(value)
  if (dmy) {
    const rawYear = dmy[3] ?? ''
    const year = rawYear.length === 2 ? expandYear(Number(rawYear)) : Number(rawYear)
    return compose(year, Number(dmy[2]), Number(dmy[1]))
  }

  return null
}

/** `2026-09-07` → `07.09.2026` */
export function formatDate(d: DateStr): string {
  const date = toDate(d)
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`
}

/**
 * То же, но нечитаемую строку отдаёт как есть, а не кидает.
 *
 * Для списков, куда попадают записи прямо из базы. Битая дата может
 * приехать с другого устройства или из файла, поправленного руками, —
 * и по тому же правилу, по которому такая запись не теряется при
 * синхронизации (Р-34), она не должна ронять весь экран. Одна строка
 * покажется странно, остальные останутся на месте.
 */
export function formatDateLoose(d: string): string {
  return isDateStr(d) ? formatDate(d) : d
}

/** Название месяца по номеру 1..12: `4` → `апрель`. Вне диапазона — пусто. */
export function monthName(month: number): string {
  return MONTHS_NOMINATIVE[month - 1] ?? ''
}

/** `2026-01` → `январь 2026`. Не месяц — отдаёт строку как есть. */
export function formatMonth(m: MonthStr): string {
  if (!isMonthStr(m)) return m
  return `${monthName(Number(m.slice(5, 7)))} ${m.slice(0, 4)}`
}

/**
 * Дата известной точности на экран (Р-25): день показывается днём,
 * месяц — месяцем.
 *
 * Заведено под контент, где в дневнике дней нет вовсе. Подставлять
 * первое число нельзя: через год никто не вспомнит, что «01.01» —
 * это не то, что было записано. Нечитаемая строка отдаётся как есть,
 * по той же причине, что и в `formatDateLoose`.
 */
export function formatDateOrMonth(value: string): string {
  if (isDateStr(value)) return formatDate(value)
  if (isMonthStr(value)) return formatMonth(value)
  return value
}

/** `2026-09-07` → `7 сентября 2026` */
export function formatDateLong(d: DateStr): string {
  const date = toDate(d)
  return `${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]} ${date.getFullYear()}`
}

/**
 * Сколько дней от `from` до `to`. Отрицательное — `to` раньше.
 *
 * Округление, а не деление нацело: при переходе на летнее время в сутках
 * 23 или 25 часов, и целочисленное деление теряло бы день.
 */
export function daysBetween(from: DateStr, to: DateStr): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / MS_PER_DAY)
}

/** Сколько дней прошло. Сегодня → 0, вчера → 1, завтра → −1. */
export function daysAgo(d: DateStr): number {
  return daysBetween(d, today())
}

export function addDays(d: DateStr, n: number): DateStr {
  const date = toDate(d)
  date.setDate(date.getDate() + n)
  return toDateStr(date)
}

// ─── Недели и промежутки ───────────────────────────────────────────────────
// Своё «Делу Время»: обзор недели (Р-41) и итоги за промежуток (Р-52).

/**
 * Промежуток дней, оба конца включительно. Итоги обзора считаются по нему,
 * а не по «неделе»: на тех же расчётах встанут месяц и год (Р-52).
 */
export type Period = { from: DateStr; to: DateStr }

/** Понедельник недели, в которую входит день: неделя — с понедельника (Р-41). */
export function weekStart(d: DateStr): DateStr {
  // У `getDay` воскресенье — ноль; сдвиг до понедельника: пн 0 … вс 6.
  return addDays(d, -((toDate(d).getDay() + 6) % 7))
}

/** Неделя, в которую входит день: понедельник — воскресенье. */
export function weekPeriod(d: DateStr): Period {
  const from = weekStart(d)
  return { from, to: addDays(from, 6) }
}

/** Лежит ли день в промежутке. Кривая строка — нет: сравнение строк её бы пропустило. */
export function inPeriod(d: string, period: Period): boolean {
  return isDateStr(d) && d >= period.from && d <= period.to
}

/** Дни промежутка по порядку. */
export function periodDays(period: Period): DateStr[] {
  const list: DateStr[] = []
  for (let day = period.from; day <= period.to; day = addDays(day, 1)) list.push(day)
  return list
}

/**
 * `7–13 сентября 2026`, `31 августа – 6 сентября 2026`,
 * `29 декабря 2025 – 4 января 2026`. Общий месяц и год не повторяются.
 */
export function formatPeriod({ from, to }: Period): string {
  if (from === to) return formatDateLong(from)
  const start = toDate(from)
  const end = toDate(to)
  if (start.getFullYear() !== end.getFullYear()) return `${formatDateLong(from)} – ${formatDateLong(to)}`
  if (start.getMonth() !== end.getMonth()) {
    return `${start.getDate()} ${MONTHS_GENITIVE[start.getMonth()]} – ${formatDateLong(to)}`
  }
  return `${start.getDate()}–${formatDateLong(to)}`
}

/**
 * Последний день месяца: `2026-02` → `2026-02-28`. Для месячных дат
 * (Р-25), когда сомнение толкуется в пользу позднего дня.
 */
export function lastDayOf(month: MonthStr): DateStr {
  // Нулевой день следующего месяца — последний день этого.
  return toDateStr(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))
}

// ─── Месяцы и годы ─────────────────────────────────────────────────────────
// Своё «Делу Время»: итоги месяца и года (Р-54, Р-57).

function assertMonth(month: MonthStr): void {
  if (!isMonthStr(month)) throw new Error(`Не месяц: ${month}`)
}

/** Месяц дня: `2026-09-14` → `2026-09`. Кривая строка кидает, как вся арифметика дней. */
export function monthOf(d: DateStr): MonthStr {
  toDate(d)
  return d.slice(0, 7)
}

/** Промежуток месяца: с первого числа по последнее. */
export function monthPeriod(month: MonthStr): Period {
  assertMonth(month)
  return { from: `${month}-01`, to: lastDayOf(month) }
}

/** Сдвиг на месяцы: `2026-01` и −1 → `2025-12`. */
export function addMonths(month: MonthStr, n: number): MonthStr {
  assertMonth(month)
  const date = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + n, 1)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`
}

/** Месяцев в году. */
export const MONTHS_PER_YEAR = 12

/** Месяцы года по порядку. */
export function monthsOf(year: number): MonthStr[] {
  return Array.from({ length: MONTHS_PER_YEAR }, (_, index) => `${year}-${pad2(index + 1)}`)
}

/** Год целиком. */
export function yearPeriod(year: number): Period {
  return { from: `${year}-01-01`, to: `${year}-12-31` }
}

/**
 * Недели, чьё воскресенье лежит в промежутке, по порядку. Неделя принадлежит
 * месяцу своего воскресенья (Р-55): каждая попадает ровно в один месяц, и к
 * концу месяца все его недели закончились.
 */
export function weeksEndingIn(period: Period): Period[] {
  const list: Period[] = []
  // Первое воскресенье не раньше начала промежутка — конец его недели.
  for (let sunday = weekPeriod(period.from).to; sunday <= period.to; sunday = addDays(sunday, 7)) {
    list.push({ from: addDays(sunday, -6), to: sunday })
  }
  return list
}

/**
 * Месяц, чей последний день лежит в промежутке не длиннее месяца: неделя его
 * закрывает (Р-54). Null — ни один месяц в нём не кончается.
 */
export function monthEndIn(period: Period): MonthStr | null {
  const month = monthOf(period.to)
  if (lastDayOf(month) === period.to) return month
  const before = addMonths(month, -1)
  return lastDayOf(before) >= period.from ? before : null
}

/**
 * Русское склонение по числу.
 *
 * Формы: 1 день / 2 дня / 5 дней.
 * Исключение на 11–14 обязательно, иначе выйдет «11 день».
 */
export function plural(n: number, forms: [string, string, string]): string {
  // Дробное число всегда берёт вторую форму: «3,5 дня», «0,5 дня»,
  // «1,5 дня» — правило отдельное от целых и на остатки не смотрит.
  if (!Number.isInteger(n)) return forms[1]

  const abs = Math.abs(n) % 100
  if (abs >= 11 && abs <= 14) return forms[2]
  switch (abs % 10) {
    case 1:
      return forms[0]
    case 2:
    case 3:
    case 4:
      return forms[1]
    default:
      return forms[2]
  }
}

/** `1` → `1 день`, `2` → `2 дня`, `5` → `5 дней`, `3.5` → `3,5 дня` */
export function days(n: number): string {
  // Десятичная запятая, а не точка: по-русски пишут «3,5 дня».
  const number = Number.isInteger(n) ? String(n) : String(n).replace('.', ',')
  return `${number} ${plural(n, ['день', 'дня', 'дней'])}`
}

/**
 * Промежуток из миллисекунд для «через …» и «на …»: `5000` → `5 секунд`,
 * `60000` → `минуту`, `120000` → `2 минуты`. Текст собирается из константы
 * кода, а не вписывается руками (Р-65). Одна минута — без числа: «через
 * минуту» по-русски, «через 1 минуту» — нет.
 */
export function timeSpan(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} ${plural(seconds, ['секунду', 'секунды', 'секунд'])}`
  const minutes = Math.round(seconds / 60)
  if (minutes === 1) return 'минуту'
  return `${minutes} ${plural(minutes, ['минуту', 'минуты', 'минут'])}`
}
