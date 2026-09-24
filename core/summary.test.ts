import { describe, expect, it } from 'vitest'
import { shelfSummary } from '../testing/shelf.ts'
import type { Book, Session } from '../testing/shelf.ts'
import {
  SUMMARY_PATH,
  buildSummary,
  checkSummary,
  lastEditOf,
  parseSummary,
  summaryFile,
  summaryPeriods,
  type Summary,
} from './summary.ts'

// Срез итогов — Я-16, Я-17, Я-18. Форма проверяется на «Полке»
// (`testing/shelf.ts`), а не на настоящем приложении (Р-47 «Трапезы»).

const DAY = '2026-09-24' // четверг

function session(id: string, date: string, minutes: number): Session {
  return { id, updatedAt: `${date}T10:00:00.000Z`, bookId: 'b1', date, minutes }
}

function book(id: string, addedOn: string | null): Book {
  return { id, updatedAt: '2026-09-01T10:00:00.000Z', title: `Книга ${id}`, addedOn }
}

const data = {
  sessions: [session('s1', '2026-09-15', 30), session('s2', '2026-09-22', 45), session('s3', '2026-08-03', 20)],
  books: [book('b1', '2026-09'), book('b2', null)],
}

function good(): Summary {
  return buildSummary(shelfSummary(data, DAY), data, DAY)
}

/** Копия годного среза с правкой — для проверок отказа. */
function broken(change: (summary: Record<string, unknown> & Summary) => void): unknown {
  const summary = structuredClone(good()) as Record<string, unknown> & Summary
  change(summary)
  return summary
}

describe('отрезки среза — Я-17', () => {
  it('прошлая и идущая неделя с понедельника, прошлый и идущий календарный месяц', () => {
    expect(summaryPeriods(DAY)).toEqual([
      { grain: 'week', from: '2026-09-14', to: '2026-09-20' },
      { grain: 'week', from: '2026-09-21', to: '2026-09-27' },
      { grain: 'month', from: '2026-08-01', to: '2026-08-31' },
      { grain: 'month', from: '2026-09-01', to: '2026-09-30' },
    ])
  })

  it('на понедельник идущая неделя начинается им же; первого января прошлый месяц — декабрь', () => {
    const periods = summaryPeriods('2027-01-04')
    expect(periods[0]).toEqual({ grain: 'week', from: '2026-12-28', to: '2027-01-03' })
    expect(periods[1]).toEqual({ grain: 'week', from: '2027-01-04', to: '2027-01-10' })
    expect(periods[2]).toEqual({ grain: 'month', from: '2026-12-01', to: '2026-12-31' })
  })
})

describe('свежесть — Я-16', () => {
  it('lastEdit — день самой поздней правки, надгробие тоже правка', () => {
    const edited = lastEditOf({
      books: [book('b1', null)],
      sessions: [{ ...session('s1', '2026-09-10', 5), updatedAt: '2026-09-20T09:00:00.000Z', deleted: true }],
    })
    expect(edited).toBe('2026-09-20')
  })

  it('записей нет или время не читается — null, а не выдуманный день', () => {
    expect(lastEditOf({ books: [] })).toBeNull()
    expect(lastEditOf({ books: [{ ...book('b1', null), updatedAt: 'вчера' }] })).toBeNull()
  })

  it('день расчёта и форму ставит ядро, а не приложение', () => {
    const summary = good()
    expect(summary.format).toBe(1)
    expect(summary.computedOn).toBe(DAY)
    expect(summary.lastEdit).toBe('2026-09-22')
  })
})

describe('файл среза', () => {
  it('одинаковый срез — побайтно одинаковый файл, в каком бы порядке ни собирались ключи', () => {
    const summary = good()
    const { format, computedOn, lastEdit, periods, attention } = summary
    const reordered: Summary = { attention, periods, lastEdit, computedOn, format }
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(summary))
    expect(summaryFile(reordered).content).toBe(summaryFile(summary).content)
    expect(summaryFile(summary).path).toBe(SUMMARY_PATH)
    expect(summaryFile(summary).content.endsWith('}\n')).toBe(true)
  })

  it('читатель получает тот же срез из текста', () => {
    const summary = good()
    expect(parseSummary(summaryFile(summary).content)).toEqual(summary)
    expect(() => parseSummary('{')).toThrow('не JSON')
  })
})

describe('проверка формы — Я-17, Я-20', () => {
  it('годный срез «Полки» проходит; отрезок без записей — «не известно» с причиной', () => {
    const summary = checkSummary(good())
    expect(summary.periods[2]?.metrics).toEqual([
      { key: 'reading', label: 'Чтение', value: { n: 20, unit: 'minutes' }, basis: 'по 1 сеансам' },
    ])
    expect(summary.periods[1]?.through).toBe(DAY)
    expect(summary.periods[0]?.through).toBeNull()
  })

  it('отрезок, которого приложение не считает, говорит об этом прямо', () => {
    const summary = broken((s) => {
      s.periods[3] = { ...s.periods[3]!, metrics: { unknown: 'not-provided', text: 'месяц пока не считается' } }
    })
    expect(() => checkSummary(summary)).not.toThrow()
  })

  it('чужая форма — отказ с номером, а не догадка', () => {
    expect(() => checkSummary(broken((s) => Object.assign(s, { format: 2 })))).toThrow('формы 2')
    expect(() => checkSummary(broken((s) => Object.assign(s, { computedOn: '24.09' })))).toThrow('computedOn')
  })

  it('отрезков не четыре или неделя не с понедельника — отказ', () => {
    expect(() => checkSummary(broken((s) => s.periods.pop()))).toThrow('отрезков должно быть 4')
    expect(() =>
      checkSummary(broken((s) => Object.assign(s.periods[1]!, { from: '2026-09-20', to: '2026-09-26' }))),
    ).toThrow('ждали 2026-09-21…2026-09-27')
  })

  it('«месяц» приложения вправе быть не календарным — это видно по концам (Я-12)', () => {
    const summary = broken((s) => Object.assign(s.periods[3]!, { from: '2026-09-05', to: '2026-10-04', through: DAY }))
    expect(() => checkSummary(summary)).not.toThrow()
  })

  it('through вне отрезка — отказ', () => {
    expect(() => checkSummary(broken((s) => Object.assign(s.periods[1]!, { through: '2026-10-01' })))).toThrow(
      'through',
    )
  })

  it('число без основания, повтор ключа, пустая подпись — отказ', () => {
    const metric = { key: 'reading', label: 'Чтение', value: { n: 1, unit: 'minutes' }, basis: 'по 1 сеансу' }
    expect(() => checkSummary(broken((s) => Object.assign(s.periods[3]!, { metrics: [{ ...metric, basis: ' ' }] })))).toThrow(
      'нет основания',
    )
    expect(() => checkSummary(broken((s) => Object.assign(s.periods[3]!, { metrics: [metric, metric] })))).toThrow(
      'повторяется',
    )
    expect(() => checkSummary(broken((s) => Object.assign(s.periods[3]!, { metrics: [{ ...metric, label: '' }] })))).toThrow(
      'пустая подпись',
    )
  })

  it('значения: деньги целым с кодом ISO, вердикт из трёх, единица из списка, «не известно» со словами', () => {
    const check = (value: unknown) => () =>
      checkSummary(
        broken((s) =>
          Object.assign(s.periods[3]!, { metrics: [{ key: 'k', label: 'Подпись', value, basis: 'основание' }] }),
        ),
      )

    expect(check({ money: 150000, currency: 'RUB' })).not.toThrow()
    expect(check({ verdict: 'open' })).not.toThrow()
    expect(check({ n: 0.5, unit: 'share' })).not.toThrow()

    expect(check({ money: 1500.5, currency: 'RUB' })).toThrow('минимальных единицах')
    expect(check({ money: 1500, currency: 'руб' })).toThrow('ISO 4217')
    expect(check({ verdict: 'good' })).toThrow('вердикт good')
    expect(check({ n: 3, unit: 'hours' })).toThrow('единица hours')
    expect(check({ n: Number.NaN, unit: 'count' })).toThrow('не конечное')
    expect(check({ unknown: 'no-data', text: '' })).toThrow('нет слов причины')
    expect(check(null)).toThrow('значения нет')
    expect(check({ amount: 5 })).toThrow('ни числом')
  })

  it('«требует внимания»: count — целое от нуля или null, day — день, ключи без повторов', () => {
    const item = { key: 'k', label: 'Подпись', count: 2, day: DAY, link: '/x', basis: 'по записям' }
    expect(() => checkSummary(broken((s) => Object.assign(s, { attention: [{ ...item, count: null }] })))).not.toThrow()
    expect(() => checkSummary(broken((s) => Object.assign(s, { attention: [{ ...item, count: -1 }] })))).toThrow(
      'count',
    )
    expect(() => checkSummary(broken((s) => Object.assign(s, { attention: [{ ...item, day: 'вчера' }] })))).toThrow(
      'day — не день',
    )
    expect(() => checkSummary(broken((s) => Object.assign(s, { attention: [item, item] })))).toThrow('повторяется')
    expect(() => checkSummary(broken((s) => Object.assign(s, { attention: [{ ...item, basis: '' }] })))).toThrow(
      'attention[0]: нет основания',
    )
  })

  it('все расхождения — одной ошибкой, а не по одному за прогон', () => {
    const summary = broken((s) => {
      Object.assign(s, { lastEdit: 'давно' })
      Object.assign(s, { attention: 'нет' })
    })
    expect(() => checkSummary(summary)).toThrow(/lastEdit.*attention/)
  })
})
