import { describe, expect, it } from 'vitest'
import { iosNote, isEmptyBase, showWelcome } from './firstRun.ts'

describe('приветствие', () => {
  it('пустая база, не закрывали — показать', () => {
    expect(showWelcome({ empty: true, done: false })).toBe(true)
  })

  it('первая запись убирает его сама', () => {
    expect(showWelcome({ empty: false, done: false })).toBe(false)
  })

  it('«Понятно» — насовсем, даже на пустой базе', () => {
    expect(showWelcome({ empty: true, done: true })).toBe(false)
  })
})

describe('пустая база', () => {
  // Хранилища, где лежат записи человека, — у приложения: у «Делу Время»
  // справочники не в счёт, они заводятся сами. Здесь — как у неё.
  const own = ['notes', 'time', 'reviews']

  it('ничего не посчитано — пусто', () => {
    expect(isEmptyBase({}, own)).toBe(true)
  })

  it('справочники не в счёт, если приложение их не назвало', () => {
    expect(isEmptyBase({ categories: 8, presets: 3, templates: 2 }, own)).toBe(true)
  })

  it('любая запись человека — уже не пусто', () => {
    expect(isEmptyBase({ notes: 1 }, own)).toBe(false)
    expect(isEmptyBase({ time: 1 }, own)).toBe(false)
    expect(isEmptyBase({ reviews: 1 }, own)).toBe(false)
  })

  it('приложение, у которого в счёт все хранилища, — и справочник тоже', () => {
    // «Трапеза»: стартовых блюд в коде нет, импорт блюд — уже данные (Р-15 «Трапезы»).
    expect(isEmptyBase({ dishes: 3 }, ['categories', 'dishes', 'intake'])).toBe(false)
  })
})

describe('строка про iPhone', () => {
  const base = { iosTab: true, empty: true, welcome: false, hiddenNow: false, hiddenForever: false }

  it('не iPhone во вкладке — строки нет', () => {
    expect(iosNote({ ...base, iosTab: false })).toBeNull()
  })

  it('пусто — «ставь до первых записей»', () => {
    expect(iosNote(base)).toBe('before')
  })

  it('пока пусто, скрытая возвращается при следующем открытии', () => {
    expect(iosNote({ ...base, hiddenNow: true })).toBeNull()
    expect(iosNote({ ...base, hiddenForever: true })).toBe('before')
  })

  it('записи есть — «перенеси копией», скрывается насовсем', () => {
    expect(iosNote({ ...base, empty: false })).toBe('after')
    expect(iosNote({ ...base, empty: false, hiddenForever: true })).toBeNull()
  })

  it('пока на экране приветствие — строки нет, там сказано то же', () => {
    expect(iosNote({ ...base, welcome: true })).toBeNull()
  })
})
