/**
 * Срез итогов приложения для метаприложения семьи (Я-16, Я-17, Я-18).
 *
 * Итоги считает приложение — хозяин данных, своими чистыми функциями (Я-11);
 * метаприложение читает готовый срез и показывает его, не досчитывая (Я-15).
 * Здесь — форма среза, общая на всех: договор задаёт форму показателя,
 * а не перечень показателей (Я-17). Что именно отдаёт каждое приложение —
 * таблица «Состав» в 02-Архитектуре.
 *
 * Срез лежит файлом `summary.json` в репозитории данных приложения и пишется
 * проходом синхронизации (`core/sync.ts`) из тех же данных, из которых
 * собираются файлы хранилищ. Считается только из синхронизируемых записей
 * и дня расчёта: одинаковые данные в один день дают побайтно одинаковый файл,
 * иначе два устройства переписывали бы его друг за другом (Я-16).
 *
 * Проверка формы `checkSummary` одна на писателя и читателя: приложение
 * не положит кривой срез, метаприложение не покажет чужой кривой.
 */

import { addDays, addMonths, isDateStr, monthOf, monthPeriod, toDateStr, weekPeriod, weekStart } from './dates.ts'
import type { DateStr, Period } from './dates.ts'
import { SUMMARY_PATH, sortKeys } from './layout.ts'
import type { RepoFile } from './layout.ts'
import type { Base } from './model.ts'

/** Где лежит срез в репозитории данных (Я-16). Хранилищу этот путь занимать нельзя. */
export { SUMMARY_PATH }

/** Версия формы. Правка формы — решение Я-NN и новый номер (Я-17). */
export const SUMMARY_FORMAT = 1

// ─── Форма ─────────────────────────────────────────────────────────────────

/** Неделя с понедельника и календарный месяц — зерно, которое просит метаприложение (Я-12). */
export type Grain = 'week' | 'month'

/** Отрезок среза: зерно и явные концы (Я-12). */
export type SummaryPeriod = Period & { grain: Grain }

/** Единицы чисел. Метаприложение по ним форматирует, а не пересчитывает. */
export const UNITS = ['count', 'minutes', 'days', 'kcal', 'km', 'share'] as const
export type Unit = (typeof UNITS)[number]

/**
 * «Не известно» — кодом причины и словами, а не нулём и не `null` (Я-17).
 * Коды из `UNKNOWN` — общие; свои приложение заводит само, всегда со словами.
 */
export type Unknown = { unknown: string; text: string }

/** Общие причины «не известно» (Я-17). */
export const UNKNOWN = {
  /** Приложение этого пока не считает — прямо, а не пустым местом. */
  notProvided: 'not-provided',
  /** Записей нет. */
  noData: 'no-data',
  /** Записей меньше порога, при котором хозяин даёт число. */
  notEnough: 'not-enough',
} as const

/** Вердикт даёт только хозяин данных (Я-15); `open` — «не ясно» (Р-24 «Трапезы»). */
export const VERDICTS = ['met', 'failed', 'open'] as const
export type Verdict = (typeof VERDICTS)[number]

export type Value =
  | { n: number; unit: Unit }
  /** Целое в минимальных единицах валюты, код ISO 4217 (Я-17). */
  | { money: number; currency: string }
  | { verdict: Verdict }
  | Unknown

/** Показатель: машинное имя, подпись, значение и основание — всегда (Я-17). */
export type Metric = {
  /** Устойчиво между срезами: по нему метаприложение сопоставляет строки. */
  key: string
  label: string
  value: Value
  /** Основание словами: «учёт в 6 днях из 7», «по 142 операциям». */
  basis: string
}

export type PeriodSummary = SummaryPeriod & {
  /** Неокончательный итог: число верно по этот день. null — итог окончательный. */
  through: DateStr | null
  /** Отрезок, которого приложение не считает, — `Unknown` с причиной. */
  metrics: Metric[] | Unknown
}

/**
 * «Требует внимания» (Я-18, Я-20): закончившийся день или состояние, с днём,
 * к которому относится. Текста темы нет — он несёт названия и диагнозы (Я-14).
 */
export type Attention = {
  key: string
  /** Нейтральная подпись без названий. */
  label: string
  count: number | null
  day: DateStr
  /** Путь хеш-роутинга приложения, как `FeedItem.link`. */
  link: string
  /** Основание словами, как у показателя: `count` — тоже число (Я-20). */
  basis: string
}

/** Что отдаёт функция среза приложения. Остальное ставит ядро. */
export type SummaryBody = {
  /** Ровно отрезки `summaryPeriods(day)`, в том же порядке. */
  periods: PeriodSummary[]
  attention: Attention[]
}

export type Summary = SummaryBody & {
  format: typeof SUMMARY_FORMAT
  /** Посчитано: день расчёта. День, а не время, — иначе коммит на каждый проход (Я-16). */
  computedOn: DateStr
  /** По записям по: день самой поздней правки записи, удаление тоже правка. */
  lastEdit: DateStr | null
}

// ─── Отрезки и свежесть ────────────────────────────────────────────────────

/**
 * Четыре отрезка среза на день расчёта, по порядку: прошлая и идущая неделя,
 * прошлый и идущий календарный месяц (Я-17). Отрезки даёт ядро, чтобы
 * неделю и месяц четыре приложения не считали каждое по-своему.
 */
export function summaryPeriods(day: DateStr): SummaryPeriod[] {
  const month = monthOf(day)
  return [
    { grain: 'week', ...weekPeriod(addDays(weekStart(day), -7)) },
    { grain: 'week', ...weekPeriod(day) },
    { grain: 'month', ...monthPeriod(addMonths(month, -1)) },
    { grain: 'month', ...monthPeriod(month) },
  ]
}

/**
 * День самой поздней правки записи — по часам устройства, как и «сегодня».
 * Надгробия считаются: удаление — тоже правка. Нечитаемое время пропускается.
 */
export function lastEditOf(data: { readonly [store: string]: readonly Base[] }): DateStr | null {
  let latest = Number.NEGATIVE_INFINITY
  for (const records of Object.values(data)) {
    for (const record of records) {
      const at = Date.parse(record.updatedAt)
      if (at > latest) latest = at
    }
  }
  return Number.isFinite(latest) ? toDateStr(new Date(latest)) : null
}

/** Срез из тела, которое отдало приложение: форму, день и свежесть ставит ядро. */
export function buildSummary(
  body: SummaryBody,
  data: { readonly [store: string]: readonly Base[] },
  day: DateStr,
): Summary {
  return {
    format: SUMMARY_FORMAT,
    computedOn: day,
    lastEdit: lastEditOf(data),
    periods: body.periods,
    attention: body.attention,
  }
}

/** Файл среза: ключи отсортированы, как у файлов хранилищ, — одинаковый срез, одинаковые байты. */
export function summaryFile(summary: Summary): RepoFile {
  return { path: SUMMARY_PATH, content: `${JSON.stringify(sortKeys(summary), null, 2)}\n` }
}

// ─── Проверка формы ────────────────────────────────────────────────────────

type Loose = { [key: string]: unknown }

function isObject(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function checkUnknown(value: Loose, where: string, problems: string[]): void {
  if (!isText(value.unknown)) problems.push(`${where}: у «не известно» нет кода причины`)
  if (!isText(value.text)) problems.push(`${where}: у «не известно» нет слов причины`)
}

function checkValue(value: unknown, where: string, problems: string[]): void {
  if (!isObject(value)) {
    problems.push(`${where}: значения нет`)
  } else if ('unknown' in value) {
    checkUnknown(value, where, problems)
  } else if ('verdict' in value) {
    if (!(VERDICTS as readonly unknown[]).includes(value.verdict)) {
      problems.push(`${where}: вердикт ${String(value.verdict)} — не ${VERDICTS.join(', ')}`)
    }
  } else if ('money' in value) {
    if (!Number.isSafeInteger(value.money)) problems.push(`${where}: деньги — не целое в минимальных единицах`)
    if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) {
      problems.push(`${where}: код валюты ${String(value.currency)} — не ISO 4217`)
    }
  } else if ('n' in value) {
    if (typeof value.n !== 'number' || !Number.isFinite(value.n)) problems.push(`${where}: число не конечное`)
    if (!(UNITS as readonly unknown[]).includes(value.unit)) {
      problems.push(`${where}: единица ${String(value.unit)} — не ${UNITS.join(', ')}`)
    }
  } else {
    problems.push(`${where}: значение ни числом, ни деньгами, ни вердиктом, ни «не известно»`)
  }
}

function checkMetrics(metrics: unknown, where: string, problems: string[]): void {
  if (isObject(metrics)) {
    checkUnknown(metrics, where, problems)
    return
  }
  if (!Array.isArray(metrics)) {
    problems.push(`${where}: показатели — ни список, ни «не известно»`)
    return
  }
  const keys = new Set<string>()
  metrics.forEach((metric: unknown, index) => {
    const at = `${where}[${index}]`
    if (!isObject(metric)) {
      problems.push(`${at}: не показатель`)
      return
    }
    if (!isText(metric.key)) problems.push(`${at}: пустой key`)
    else if (keys.has(metric.key)) problems.push(`${at}: key «${metric.key}» повторяется`)
    else keys.add(metric.key)
    if (!isText(metric.label)) problems.push(`${at}: пустая подпись`)
    // Число без основания — ровно то, от чего семья ушла (07-Разведка, «Что видно», п. 1).
    if (!isText(metric.basis)) problems.push(`${at}: нет основания`)
    checkValue(metric.value, `${at}.value`, problems)
  })
}

function checkPeriods(periods: unknown, computedOn: DateStr, problems: string[]): void {
  const expected = summaryPeriods(computedOn)
  if (!Array.isArray(periods) || periods.length !== expected.length) {
    problems.push(`отрезков должно быть ${expected.length}: прошлая и идущая неделя, прошлый и идущий месяц`)
    return
  }
  periods.forEach((period: unknown, index) => {
    const at = `periods[${index}]`
    const want = expected[index] as SummaryPeriod
    if (!isObject(period)) {
      problems.push(`${at}: не отрезок`)
      return
    }
    if (period.grain !== want.grain) problems.push(`${at}: зерно ${String(period.grain)}, ждали ${want.grain}`)
    const { from, to, through } = period
    if (typeof from !== 'string' || !isDateStr(from) || typeof to !== 'string' || !isDateStr(to) || from > to) {
      problems.push(`${at}: концы отрезка — не дни или идут не по порядку`)
    } else {
      // Неделя у всех одна — с понедельника. «Месяц» приложения вправе быть
      // не календарным, это видно по концам (Я-12), и потому не проверяется.
      if (want.grain === 'week' && (from !== want.from || to !== want.to)) {
        problems.push(`${at}: неделя ${from}…${to}, ждали ${want.from}…${want.to}`)
      }
      if (through !== null && (typeof through !== 'string' || !isDateStr(through) || through < from || through > to)) {
        problems.push(`${at}: through — не день внутри отрезка и не null`)
      }
    }
    checkMetrics(period.metrics, `${at}.metrics`, problems)
  })
}

function checkAttention(attention: unknown, problems: string[]): void {
  if (!Array.isArray(attention)) {
    problems.push('attention — не список')
    return
  }
  const keys = new Set<string>()
  attention.forEach((item: unknown, index) => {
    const at = `attention[${index}]`
    if (!isObject(item)) {
      problems.push(`${at}: не пункт`)
      return
    }
    if (!isText(item.key)) problems.push(`${at}: пустой key`)
    else if (keys.has(item.key)) problems.push(`${at}: key «${item.key}» повторяется`)
    else keys.add(item.key)
    if (!isText(item.label)) problems.push(`${at}: пустая подпись`)
    if (item.count !== null && !(Number.isSafeInteger(item.count) && (item.count as number) >= 0)) {
      problems.push(`${at}: count — не целое от нуля и не null`)
    }
    if (typeof item.day !== 'string' || !isDateStr(item.day)) problems.push(`${at}: day — не день`)
    if (typeof item.link !== 'string') problems.push(`${at}: link — не строка`)
    if (!isText(item.basis)) problems.push(`${at}: нет основания`)
  })
}

/**
 * Проверка формы среза. Возвращает его же с типом `Summary` или бросает
 * одну ошибку со всеми найденными расхождениями.
 *
 * Отрезки сверяются с днём расчёта самого среза, а не с сегодняшним: срез,
 * прочитанный через неделю, по-прежнему годен — он просто не свежий.
 */
export function checkSummary(value: unknown): Summary {
  const problems: string[] = []

  if (!isObject(value)) throw new Error('Срез итогов — не объект')
  if (value.format !== SUMMARY_FORMAT) {
    throw new Error(`Срез итогов формы ${String(value.format)}, здесь понимают форму ${SUMMARY_FORMAT}`)
  }
  const { computedOn, lastEdit } = value
  if (typeof computedOn !== 'string' || !isDateStr(computedOn)) {
    throw new Error('В срезе итогов нет дня расчёта computedOn')
  }
  if (lastEdit !== null && (typeof lastEdit !== 'string' || !isDateStr(lastEdit))) {
    problems.push('lastEdit — не день и не null')
  }
  checkPeriods(value.periods, computedOn, problems)
  checkAttention(value.attention, problems)

  if (problems.length > 0) throw new Error(`Срез итогов не сходится с формой: ${problems.join('; ')}`)
  return value as Summary
}

/** Срез из текста файла — для читателя. Не JSON или не та форма — ошибка. */
export function parseSummary(text: string): Summary {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`Файл ${SUMMARY_PATH} — не JSON`)
  }
  return checkSummary(value)
}
