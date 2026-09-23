/**
 * Импорт записей (Р-60 «Дневников»): простой формат для файлов, которые готовит ИИ
 * или человек, — без `id` и `updatedAt`, ссылки по названиям.
 *
 * Здесь общее: разбор файла, проверка полей, сведение разделов, сборка
 * промпта. Про модули не знает — свои разделы разбирают сами модули
 * (`modules/<имя>/import.ts`), сводит их реестр, как ленту и markdown (Р-48 «Дневников»).
 *
 * Слепок приложения (Р-23 «Дневников») сюда не заходит: у него свой вход,
 * «Восстановить из копии», и своё доверие — его писало приложение.
 *
 * Строка `format`, имя приложения и свои правила промпта приходят конфигом
 * (Р-47 «Трапезы»): `createImporting(config)`.
 */

import { formatDate, isDateOrMonth, isDateStr, plural, type DateStr } from './dates.ts'
import type { AppConfig, StoreMap, StoreOf } from './model.ts'

export const IMPORT_VERSION = 1

/** Что не так с записью — по имени и с причиной. В базу она не попадает. */
export type Issue = { section: string; title: string; reason: string }

/**
 * Запись в базу попадёт, но человеку стоит посмотреть (Я-07): округление,
 * подозрительное число, замена одного другим. Не отказ — в счёт отказов
 * не идёт.
 */
export type Note = { section: string; title: string; text: string }

/** Записи к записи в базу по хранилищам: новые, изменённые и надгробия. */
export type Writes<R extends StoreMap = StoreMap> = { [S in StoreOf<R>]?: R[S][] }

/** Сколько чего — число и склонение существительного: «3 позиции». */
export type Count = { count: number; forms: [string, string, string] }

/** Прежнее имя `Count` — приложения им пользуются. */
export type Added = Count

/**
 * Итог разбора раздела — и всего файла: у них одна форма.
 *
 * Что в `writes` — новое, правка или надгробие, — говорит приложение
 * счётом в `added`, `changed`, `removed`: ядро не сличает записи с базой
 * и слов для чужих записей не знает (Я-07). Промолчит приложение о правке —
 * промолчит и сводка.
 */
export type ImportPlan<R extends StoreMap = StoreMap> = {
  writes: Writes<R>
  added: Count[]
  /** Совпали с уже имеющимися — пропущены, а не перезаписаны. */
  skipped: number
  /** Не попадут в базу. */
  issues: Issue[]
  /** Попадут, но о них надо сказать (Я-07). */
  notes?: Note[]
  /** Сколько уже имеющихся записей изменится (Я-07). */
  changed?: Count[]
  /** Сколько уже имеющихся записей уйдёт надгробием (Я-07). */
  removed?: Count[]
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
function readSections(
  text: string,
  config: { importFormat: string; name: string },
): Record<string, unknown> {
  const IMPORT_FORMAT = config.importFormat
  const value = parseLoose(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('В файле не объект с разделами')
  }

  const raw = value as Record<string, unknown>
  if ('schemaVersion' in raw && 'data' in raw) {
    throw new Error('Это копия приложения, а не импорт записей. Её загружают кнопкой «Восстановить из копии»')
  }
  if (raw.format !== IMPORT_FORMAT) {
    throw new Error(
      `В файле нет строки "format": "${IMPORT_FORMAT}" — это не импорт записей приложения «${config.name}»`,
    )
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

/** Полная дата или месяц `ГГГГ-ММ` (Р-25 «Дневников»). */
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

function append<R extends StoreMap>(target: Writes<R>, source: Writes<R>, store: StoreOf<R>): void {
  // Записи берутся из того же хранилища источника, в какое кладутся, но
  // связь ключа с типом записей TypeScript здесь не проследит.
  const records = source[store] as unknown[] | undefined
  if (!records || records.length === 0) return
  const bag = target as Record<string, unknown[] | undefined>
  bag[store] = [...(bag[store] ?? []), ...records]
}

/** Счёт к счёту: одинаковое по склонению складывается. Входные не трогаются. */
function addCounts(target: Count[], source: readonly Count[] | undefined): void {
  for (const each of source ?? []) {
    const same = target.find((other) => other.forms[2] === each.forms[2])
    if (same) same.count += each.count
    else target.push({ ...each })
  }
}

/**
 * Разделы — в один план. Одинаковое добавленное, изменённое и удалённое
 * складывается. Необязательные поля в итоге есть всегда, пусть пустыми.
 */
export function mergeResults<R extends StoreMap>(results: readonly ImportPlan<R>[]): ImportPlan<R> {
  const writes: Writes<R> = {}
  const added: Count[] = []
  const changed: Count[] = []
  const removed: Count[] = []
  let skipped = 0
  const issues: Issue[] = []
  const notes: Note[] = []

  for (const result of results) {
    for (const store of Object.keys(result.writes) as StoreOf<R>[]) append(writes, result.writes, store)
    addCounts(added, result.added)
    addCounts(changed, result.changed)
    addCounts(removed, result.removed)
    skipped += result.skipped
    issues.push(...result.issues)
    notes.push(...(result.notes ?? []))
  }

  return { writes, added, skipped, issues, notes, changed, removed }
}

/** Сколько записей ляжет в базу: новые, изменённые и надгробия вместе. */
export function planTotal<R extends StoreMap>(plan: ImportPlan<R>): number {
  return Object.values(plan.writes).reduce((sum, records) => sum + (records?.length ?? 0), 0)
}

/** Счёт словами для сводки: «3 позиции, 1 категория». Пусто — пустая строка. */
export function countsText(counts: readonly Count[]): string {
  return counts.map((each) => `${each.count} ${plural(each.count, each.forms)}`).join(', ')
}

// ─── Промпт ────────────────────────────────────────────────────────────────

/**
 * Правила промпта, общие для всей семьи, — после своих правил приложения.
 * Свои (`promptRules` конфига) — про даты, минуты, оценку: у «Делу Время»
 * месяц без числа законен, у «Трапезы» — нет. Правила про поля — не здесь,
 * а в описаниях разделов: они живут в модуле, а ядро про модули не знает.
 */
export const COMMON_PROMPT_RULES: readonly string[] = [
  'Разделы, для которых данных нет, не пиши.',
  'Ответь одним блоком JSON. Если записей очень много — раздели на несколько блоков, каждый — ' +
    'полный файл в том же формате.',
  'После JSON отдельным списком перечисли, что не удалось разобрать или в чём сомневаешься.',
]

/** Импорт приложения: его строка `format`, имя в текстах и свои правила промпта. */
export function createImporting<R extends StoreMap>(config: AppConfig<R>) {
  /** Разделы файла импорта. Кидает с объяснением, если файл не тот. */
  function readImportFile(text: string): Record<string, unknown> {
    return readSections(text, config)
  }

  /**
   * Промпт для ИИ (Р-60 «Дневников»). Собирается из тех же описаний разделов, по которым
   * идёт проверка, — разойтись они не могут. Сегодняшняя дата внутри: без
   * неё «вчера» и год без числа не перевести.
   */
  function buildPrompt(specs: readonly ImportSpec[], day: DateStr): string {
    const example: Record<string, unknown> = { format: config.importFormat, version: IMPORT_VERSION }
    for (const spec of specs) example[spec.section] = spec.example

    const sections = specs.map((spec) =>
      [`"${spec.section}" — ${spec.about}`, ...spec.fields.map((field) => `  - ${field}`)].join('\n'),
    )

    const rules = [...config.promptRules, ...COMMON_PROMPT_RULES].map((rule, index) => `${index + 1}. ${rule}`)

    return [
      `Помоги перенести мои записи в приложение «${config.name}». Ниже — описание формата, а в конце — ` +
        `мои данные: ${config.about.sources}. Собери из них один JSON строго в этом формате.`,
      '',
      `Сегодня ${formatDate(day)}. От этой даты считай «вчера», «прошлой весной» и год там, где он не указан.`,
      '',
      'Правила:',
      ...rules,
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

  return {
    /** Строка `format` файла импорта приложения. */
    format: config.importFormat,
    readImportFile,
    buildPrompt,
  }
}

/** Импорт приложения. */
export type Importing = ReturnType<typeof createImporting>

