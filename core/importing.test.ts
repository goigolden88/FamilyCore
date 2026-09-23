import { describe, expect, it } from 'vitest'
import { shelf } from '../testing/shelf.ts'
import {
  COMMON_PROMPT_RULES,
  countsText,
  createImporting,
  IMPORT_VERSION,
  mergeResults,
  numberOf,
  planTotal,
  recordsOf,
  type ImportSpec,
} from './importing.ts'

// У importing.ts на d86f0aa тестов не было: разбор разделов проверяли модули
// «Делу Время». Здесь — то, что стало параметром приложения (Р-47 «Трапезы»),
// и общие помощники. Приложение — подставная «Полка» (`testing/shelf.ts`).

const importing = createImporting(shelf)

const books: ImportSpec = {
  section: 'books',
  about: 'книги',
  fields: ['title — название', 'addedOn — ГГГГ-ММ-ДД'],
  example: [{ title: 'Мастер и Маргарита', addedOn: '2026-03-01' }],
}

describe('файл импорта', () => {
  it('принимает свой format и отдаёт разделы без служебных строк', () => {
    const sections = importing.readImportFile(
      JSON.stringify({ format: 'polka-import', version: 1, books: [{ title: 'Х' }] }),
    )
    expect(sections).toEqual({ books: [{ title: 'Х' }] })
  })

  it('чужой format — отказ с именем приложения из конфига', () => {
    expect(() => importing.readImportFile(JSON.stringify({ format: 'trapeza-import' }))).toThrow(
      'это не импорт записей приложения «Полка»',
    )
  })

  it('JSON в блоке ```json с текстом вокруг — так его отдаёт ИИ', () => {
    const text = 'Вот файл:\n```json\n{"format":"polka-import","books":[]}\n```\nГотово.'
    expect(importing.readImportFile(text)).toEqual({ books: [] })
  })

  it('слепок приложения сюда не заходит — у него свой вход', () => {
    expect(() => importing.readImportFile(JSON.stringify({ schemaVersion: 1, data: {} }))).toThrow(
      'Восстановить из копии',
    )
  })

  it('файл более новой версии — «обнови приложение»', () => {
    expect(() =>
      importing.readImportFile(JSON.stringify({ format: 'polka-import', version: IMPORT_VERSION + 1 })),
    ).toThrow('Обнови приложение')
  })
})

describe('промпт', () => {
  const prompt = importing.buildPrompt([books], '2026-09-18')

  it('говорит о приложении и его данных словами конфига', () => {
    expect(prompt).toContain('в приложение «Полка»')
    expect(prompt).toContain(shelf.about.sources)
  })

  it('свои правила приложения — первыми, общие — следом, нумерация сплошная', () => {
    const rules = [...shelf.promptRules, ...COMMON_PROMPT_RULES]
    rules.forEach((rule, index) => expect(prompt).toContain(`${index + 1}. ${rule}`))
    expect(prompt.indexOf(`1. ${shelf.promptRules[0]}`)).toBeLessThan(prompt.indexOf(COMMON_PROMPT_RULES[0] ?? '—'))
  })

  it('пример файла — с format приложения, собран из описаний разделов', () => {
    expect(prompt).toContain('"format": "polka-import"')
    expect(prompt).toContain('"title": "Мастер и Маргарита"')
    expect(prompt).toContain('"books" — книги')
  })

  it('чужого приложения в промпте нет', () => {
    expect(prompt).not.toMatch(/Делу Время|Трапез|минутах: «1:20»/)
  })
})

describe('помощники разбора', () => {
  it('число — и строкой, как его пишут', () => {
    expect(numberOf('1 829,50')).toBe(1829.5)
    expect(numberOf('')).toBeNull()
  })

  it('раздел не списком — в отчёт, а не в падение', () => {
    const { records, issues } = recordsOf('books', 'нет')
    expect(records).toEqual([])
    expect(issues[0]?.reason).toContain('не список')
  })

  it('разделы сводятся в один план, одинаковое добавленное складывается', () => {
    const forms: [string, string, string] = ['книга', 'книги', 'книг']
    const plan = mergeResults([
      { writes: { books: [] }, added: [{ count: 2, forms }], skipped: 1, issues: [] },
      { writes: {}, added: [{ count: 3, forms }], skipped: 0, issues: [] },
    ])
    expect(plan.added).toEqual([{ count: 5, forms }])
    expect(plan.skipped).toBe(1)
    expect(planTotal(plan)).toBe(0)
  })
})

describe('заметки, правки и удаления — Я-07', () => {
  const book: [string, string, string] = ['книга', 'книги', 'книг']
  const shelfForms: [string, string, string] = ['полка', 'полки', 'полок']

  it('раздел без новых полей — прежней формы, и сводится как раньше', () => {
    const plan = mergeResults([{ writes: {}, added: [], skipped: 0, issues: [] }])
    expect(plan.notes).toEqual([])
    expect(plan.changed).toEqual([])
    expect(plan.removed).toEqual([])
  })

  it('заметки идут отдельно от отказов и не примешиваются к ним', () => {
    const plan = mergeResults([
      {
        writes: {},
        added: [],
        skipped: 0,
        issues: [{ section: 'books', title: 'книга 1', reason: 'нет названия' }],
        notes: [{ section: 'books', title: 'округление', text: 'сумма округлена' }],
      },
      {
        writes: {},
        added: [],
        skipped: 0,
        issues: [],
        notes: [{ section: 'sessions', title: 'сеанс', text: 'шесть часов подряд — похоже на опечатку' }],
      },
    ])
    expect(plan.issues).toHaveLength(1)
    expect(plan.notes?.map((each) => each.title)).toEqual(['округление', 'сеанс'])
  })

  it('правки и удаления складываются по склонению, как добавленное', () => {
    const plan = mergeResults([
      { writes: {}, added: [], skipped: 0, issues: [], changed: [{ count: 1, forms: book }] },
      {
        writes: {},
        added: [],
        skipped: 0,
        issues: [],
        changed: [
          { count: 2, forms: book },
          { count: 1, forms: shelfForms },
        ],
        removed: [{ count: 1, forms: shelfForms }],
      },
    ])
    expect(plan.changed).toEqual([
      { count: 3, forms: book },
      { count: 1, forms: shelfForms },
    ])
    expect(plan.removed).toEqual([{ count: 1, forms: shelfForms }])
  })

  it('сведение не портит планы разделов', () => {
    const changed = [{ count: 1, forms: book }]
    mergeResults([
      { writes: {}, added: [], skipped: 0, issues: [], changed },
      { writes: {}, added: [], skipped: 0, issues: [], changed: [{ count: 4, forms: book }] },
    ])
    expect(changed).toEqual([{ count: 1, forms: book }])
  })

  it('счёт словами: число и склонение через запятую', () => {
    expect(countsText([{ count: 1, forms: book }, { count: 5, forms: shelfForms }])).toBe('1 книга, 5 полок')
    expect(countsText([])).toBe('')
  })
})
