import { describe, expect, it } from 'vitest'
import {
  dateWords,
  escapeMarkdown,
  feedDateText,
  feedHeading,
  filterFeed,
  groupFeed,
  normalize,
  queryWords,
  recordsText,
  type FeedItem,
} from './feed.ts'

function item(date: string, over: Partial<FeedItem> = {}): FeedItem {
  return { kind: 'note', id: date || 'пусто', date, title: 'Купить фильтр', detail: '', link: '/', ...over }
}

const ids = (items: FeedItem[]) => items.map((each) => each.id)

describe('groupFeed', () => {
  it('новые сверху, месяцы заголовками', () => {
    const groups = groupFeed([item('2026-07-01'), item('2026-09-10'), item('2026-09-02')])
    expect(groups.map((group) => group.month)).toEqual(['2026-09', '2026-07'])
    expect(ids(groups[0]?.items ?? [])).toEqual(['2026-09-10', '2026-09-02'])
  })

  it('дата до месяца встаёт в конец своего месяца, а не на первое число', () => {
    const groups = groupFeed([item('2026-09'), item('2026-09-01'), item('2026-09-10')])
    expect(groups).toHaveLength(1)
    expect(ids(groups[0]?.items ?? [])).toEqual(['2026-09-10', '2026-09-01', '2026-09'])
  })

  it('без даты и с кривой датой — своей группой внизу, а не пропадает и не наверху — Р-08, Р-59', () => {
    const groups = groupFeed([item(''), item('2026-09-01'), item('вчера'), item('2026-07-01')])
    expect(groups.map((group) => group.month)).toEqual(['2026-09', '2026-07', null])
    expect(groups.at(-1)?.items).toHaveLength(2)
  })

  it('внутри одного дня — по виду в порядке реестра, затем по названию', () => {
    const groups = groupFeed(
      [
        item('2026-09-01', { id: 'review', kind: 'review', title: 'Обзор' }),
        item('2026-09-01', { id: 'b', title: 'Фильтр' }),
        item('2026-09-01', { id: 'time', kind: 'time', title: '5 ч' }),
        item('2026-09-01', { id: 'a', title: 'Бритва' }),
      ],
      ['note', 'time', 'review'],
    )
    expect(ids(groups[0]?.items ?? [])).toEqual(['a', 'b', 'time', 'review'])
  })
})

describe('filterFeed', () => {
  const list = [
    item('2026-09-10', { id: 'filter', detail: 'дело · сделано 14.09' }),
    item('2026-07-01', { id: 'day', kind: 'time', title: '5 ч', extra: 'Чтение Ютуб покер' }),
    item('2026-03-12', { id: 'thought', title: 'Ёлки у реки' }),
    item('', { id: 'undated', title: 'Старая мысль' }),
  ]

  it('без условий — всё', () => {
    expect(filterFeed(list)).toHaveLength(4)
  })

  it('по виду', () => {
    expect(ids(filterFeed(list, { kind: 'time' }))).toEqual(['day'])
  })

  it('все слова запроса, в любом порядке, по названию и подписи', () => {
    expect(ids(filterFeed(list, { query: 'сделано фильтр' }))).toEqual(['filter'])
    expect(filterFeed(list, { query: 'фильтр отменено' })).toEqual([])
  })

  it('ищет в том, что не показано: заметках блоков и категориях', () => {
    expect(ids(filterFeed(list, { query: 'покер' }))).toEqual(['day'])
  })

  it('регистр и «ё» не в счёт', () => {
    expect(ids(filterFeed(list, { query: 'ЕЛКИ' }))).toEqual(['thought'])
  })

  it('ищет по дате цифрами и словами — как «Заметки» (Р-61)', () => {
    expect(ids(filterFeed(list, { query: '01.07' }))).toEqual(['day'])
    expect(ids(filterFeed(list, { query: '2026-03' }))).toEqual(['thought'])
    expect(ids(filterFeed(list, { query: 'март' }))).toEqual(['thought'])
    expect(ids(filterFeed(list, { query: '12 марта' }))).toEqual(['thought'])
    expect(ids(filterFeed(list, { query: 'без даты' }))).toEqual(['undated'])
  })

  it('вид и поиск вместе', () => {
    expect(filterFeed(list, { kind: 'review', query: 'фильтр' })).toEqual([])
  })
})

describe('слова даты', () => {
  it('день — всеми видами, месяц — именительным', () => {
    expect(dateWords('2026-05-03')).toBe('2026-05-03 03.05.2026 3 мая 2026 май 2026')
  })

  it('нет даты — «без даты», кривая — как лежит', () => {
    expect(dateWords(null)).toBe('без даты')
    expect(dateWords('')).toBe('без даты')
    expect(dateWords('вчера')).toBe('вчера')
  })

  it('слова запроса', () => {
    expect(queryWords('  Воды   ФИЛЬТР ')).toEqual(['воды', 'фильтр'])
    expect(queryWords('   ')).toEqual([])
  })
})

describe('подписи', () => {
  it('день — числом и месяцем, месяц — «без числа», мусор — как есть, пусто — прочерк', () => {
    expect(feedDateText('2026-09-10')).toBe('10.09')
    expect(feedDateText('2026-09')).toBe('без числа')
    expect(feedDateText('вчера')).toBe('вчера')
    expect(feedDateText('')).toBe('—')
  })

  it('заголовок группы', () => {
    expect(feedHeading('2026-09')).toBe('Сентябрь 2026')
    expect(feedHeading(null)).toBe('Без даты')
  })

  it('счётчик склоняется', () => {
    expect(recordsText(1)).toBe('1 запись')
    expect(recordsText(3)).toBe('3 записи')
    expect(recordsText(12)).toBe('12 записей')
  })

  it('normalize', () => {
    expect(normalize('  Ёлки   ПАЛКИ ')).toBe('елки палки')
  })
})

describe('escapeMarkdown', () => {
  it('служебные знаки экранируются', () => {
    expect(escapeMarkdown('*Звёздные* войны [2]')).toBe('\\*Звёздные\\* войны \\[2\\]')
    expect(escapeMarkdown('# не заголовок')).toBe('\\# не заголовок')
  })

  it('переносы строк становятся пробелами — пункт списка не рвётся', () => {
    expect(escapeMarkdown('первая\nвторая\n\nтретья ')).toBe('первая вторая третья')
  })
})
