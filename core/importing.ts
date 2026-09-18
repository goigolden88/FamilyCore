/**
 * Импорт записей (Р-60): простой формат для файлов, которые готовит ИИ
 * или человек, — без `id` и `updatedAt`, ссылки по названиям.
 *
 * Здесь общее: разбор файла, проверка полей, сведение разделов, сборка
 * промпта. Про модули не знает — свои разделы разбирают сами модули
 * (`modules/<имя>/import.ts`), сводит их реестр, как ленту и markdown (Р-48).
 *
 * Слепок приложения (Р-23) сюда не заходит: у него свой вход,
 * «Восстановить из копии», и своё доверие — его писало приложение.
 */

import { formatDate, isDateOrMonth, isDateStr, type DateStr } from './dates.ts'
import type { StoreRecord, SyncedStore } from './model.ts'

export const IMPORT_FORMAT = 'deluvremya-import'
export const IMPORT_VERSION = 1

/** Что не так с записью — по имени и с причиной. В базу она не попадает. */
export type Issue = { section: string; title: string; reason: string }

/** Записи к добавлению по хранилищам. */
export type Writes = { [S in SyncedStore]?: StoreRecord[S][] }

/** Сколько чего добавится — число и склонение: «3 позиции». */
export type Added = { count: number; forms: [string, string, string] }

/** Итог разбора раздела — и всего файла: у них одна форма. */
export type ImportPlan = {
  writes: Writes
  added: Added[]
  /** Совпали с уже имеющимися — пропущены, а не перезаписаны. */
  skipped: number
  issues: Issue[]
}

/** Откуда брать id и время. Снаружи — чтобы разбор проверялся тестами. */
export type ImportContext = { newId: () => string; now: string }

/** Раздел формата: что он такое, его поля и пример. Из этого собирается промпт. */
export type ImportSpec = {
  section: string
  about: string
  fields: readonly string[]
  example: readonly unknown[]
}

// ─── Файл ──────────────────────────────────────────────────────────────────

/**
 * JSON из того, что вставили. Терпит обёртку: ИИ почти всегда отдаёт JSON
 * в блоке ```json, часто с текстом вокруг, и человек копирует всё разом.
 * Вырезаем сами, а не требуем аккуратности.
 */
function parseLoose(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = (fenced?.[1] ?? text).trim()
  try {
    return JSON.parse(body)
  } catch {
    const from = body.indexOf('{')
    const to = body.lastIndexOf('}')
    if (from !== -1 && to > from) {
      try {
        return JSON.parse(body.slice(from, to + 1))
      } catch {
        // Ниже — внятный отказ.
      }
    }
    throw new Error('Это не JSON. Скопируй из ответа ИИ только сам JSON — от первой «{» до последней «}»')
  }
}

/** Разделы файла импорта. Кидает с объяснением, если файл не тот. */
export function readImportFile(text: string): Record<string, unknown> {
  const value = parseLoose(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('В файле не объект с разделами')
  }

  const raw = value as Record<string, unknown>
  if ('schemaVersion' in raw && 'data' in raw) {
    throw new Error('Это копия приложения, а не импорт записей. Её загружают кнопкой «Восстановить из копии»')
  }
  if (raw.format !== IMPORT_FORMAT) {
    throw new Error(`В файле нет строки "format": "${IMPORT_FORMAT}" — это не импорт записей «Делу Время»`)
  }
  if (typeof raw.version === 'number' && raw.version > IMPORT_VERSION) {
    throw new Error('Файл сделан для более новой версии приложения. Обнови приложение')
  }

  const sections: Record<string, unknown> = {}
  for (const [key, section] of Object.entries(raw)) {
    if (key !== 'format' && key !== 'version') sections[key] = section
  }
  return sections
}

// ─── Поля ──────────────────────────────────────────────────────────────────

/** Не написано, null или пустая строка. */
export function absent(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim())
}

/** Непустая строка, обрезанная по краям. */
export function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Число — или строка с числом, как его пишут: «700», «1 829,50». */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const clean = value.replace(/\s/g, '').replace(',', '.')
  if (!clean) return null
  const parsed = Number(clean)
  return Number.isFinite(parsed) ? parsed : null
}

/** Полная дата `ГГГГ-ММ-ДД`. */
export function dayOf(value: unknown): DateStr | null {
  const text = textOf(value)
  return text !== null && isDateStr(text) ? text : null
}

/** Полная дата или месяц `ГГГГ-ММ` (Р-25). */
export function dayOrMonthOf(value: unknown): string | null {
  const text = textOf(value)
  return text !== null && isDateOrMonth(text) ? text : null
}

/** Одно ли это название: регистр и пробелы по краям не различаются. */
export function sameText(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('ru') === b.trim().toLocaleLowerCase('ru')
}

/** Как показать сырое значение в отчёте. */
export function shown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
}

/**
 * Записи раздела. Раздел не список или запись не объект — в отчёт,
 * а не в падение: один кривой раздел не должен хоронить остальные.
 */
export function recordsOf(
  section: string,
  value: unknown,
): { records: { raw: Record<string, unknown>; index: number }[]; issues: Issue[] } {
  if (!Array.isArray(value)) {
    return {
      records: [],
      issues: [{ section, title: `раздел «${section}»`, reason: 'не список записей — пропущен целиком' }],
    }
  }

  const records: { raw: Record<string, unknown>; index: number }[] = []
  const issues: Issue[] = []
  value.forEach((raw: unknown, index) => {
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      records.push({ raw: raw as Record<string, unknown>, index })
    } else {
      issues.push({ section, title: `запись ${index + 1}`, reason: 'не объект с полями' })
    }
  })
  return { records, issues }
}

// ─── Сведение ──────────────────────────────────────────────────────────────

function append(target: Writes, source: Writes, store: SyncedStore): void {
  // Записи берутся из того же хранилища источника, в какое кладутся, но
  // связь ключа с типом записей TypeScript здесь не проследит.
  const records = source[store] as unknown[] | undefined
  if (!records || records.length === 0) return
  const bag = target as Record<SyncedStore, unknown[] | undefined>
  bag[store] = [...(bag[store] ?? []), ...records]
}

/** Разделы — в один план. Одинаковое добавленное складывается. */
export function mergeResults(results: readonly ImportPlan[]): ImportPlan {
  const writes: Writes = {}
  const added: Added[] = []
  let skipped = 0
  const issues: Issue[] = []

  for (const result of results) {
    for (const store of Object.keys(result.writes) as SyncedStore[]) append(writes, result.writes, store)
    for (const each of result.added) {
      const same = added.find((other) => other.forms[2] === each.forms[2])
      if (same) same.count += each.count
      else added.push({ ...each })
    }
    skipped += result.skipped
    issues.push(...result.issues)
  }

  return { writes, added, skipped, issues }
}

/** Сколько записей ляжет в базу. */
export function planTotal(plan: ImportPlan): number {
  return Object.values(plan.writes).reduce((sum, records) => sum + (records?.length ?? 0), 0)
}

// ─── Промпт ────────────────────────────────────────────────────────────────

/**
 * Промпт для ИИ (Р-60). Собирается из тех же описаний разделов, по которым
 * идёт проверка, — разойтись они не могут. Сегодняшняя дата внутри: без
 * неё «вчера» и год без числа не перевести.
 */
export function buildPrompt(specs: readonly ImportSpec[], day: DateStr): string {
  const example: Record<string, unknown> = { format: IMPORT_FORMAT, version: IMPORT_VERSION }
  for (const spec of specs) example[spec.section] = spec.example

  const sections = specs.map((spec) =>
    [`"${spec.section}" — ${spec.about}`, ...spec.fields.map((field) => `  - ${field}`)].join('\n'),
  )

  return [
    'Помоги перенести мои записи в приложение «Делу Время». Ниже — описание формата, а в конце — ' +
      'мои данные: таблицы учёта времени, заметки или скриншоты из других сервисов. Собери из них ' +
      'один JSON строго в этом формате.',
    '',
    `Сегодня ${formatDate(day)}. От этой даты считай «вчера», «прошлой весной» и год там, где он не указан.`,
    '',
    'Правила:',
    '1. Ничего не выдумывай. Чего нет в моих данных — не пиши: необязательное поле опусти, ' +
      'запись без обязательного поля не пиши вовсе, а назови в списке после JSON.',
    '2. Даты — ГГГГ-ММ-ДД. Любой вид (24.01.26, 20-02-2026, «3 марта») приводи к нему. Где это ' +
      'разрешено и известен только месяц — например, месяц стоит заголовком раздела, — пиши ГГГГ-ММ, ' +
      'без выдуманного числа.',
    // Пределы минут — не здесь, а в описании поля раздела: они живут
    // в модуле, а ядро про модули не знает.
    '3. Время — в минутах: «1,5 ч» → 90, «1:20» → 80, «40 мин» → 40.',
    '4. Таблица по дням и занятиям: одна запись на непустую ячейку — день, занятие, минуты. Строки ' +
      'и столбцы итогов, проценты и суммы за месяц не переноси: приложение посчитает их само.',
    '5. Разделы, для которых данных нет, не пиши.',
    '6. Ответь одним блоком JSON. Если записей очень много — раздели на несколько блоков, каждый — ' +
      'полный файл в том же формате.',
    '7. После JSON отдельным списком перечисли, что не удалось разобрать или в чём сомневаешься.',
    '',
    'Разделы:',
    '',
    sections.join('\n\n'),
    '',
    'Пример файла:',
    '',
    JSON.stringify(example, null, 2),
    '',
    'Мои данные:',
    '',
  ].join('\n')
}
