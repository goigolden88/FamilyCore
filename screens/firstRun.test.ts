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
  it('ничего не посчитано — пусто', () => {
    expect(isEmptyBase({})).toBe(true)
  })

  it('справочники не в счёт: категории заводятся сами', () => {
    expect(isEmptyBase({ categories: 8, presets: 3, templates: 2 })).toBe(true)
  })

  it('любая запись человека — уже не пусто', () => {
    expect(isEmptyBase({ notes: 1 })).toBe(false)
    expect(isEmptyBase({ time: 1 })).toBe(false)
    expect(isEmptyBase({ reviews: 1 })).toBe(false)
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
