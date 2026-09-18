import { describe, expect, it } from 'vitest'
import { ULID_LEN, isUlid, ulid, ulidTime } from './id.ts'

describe('ulid', () => {
  it('26 символов из алфавита Crockford', () => {
    const id = ulid()
    expect(id).toHaveLength(ULID_LEN)
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it('не повторяется', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => ulid()))
    expect(ids.size).toBe(10_000)
  })

  it('хранит время создания', () => {
    const now = Date.now()
    expect(ulidTime(ulid(now))).toBe(now)
  })

  it('сортируется по времени как строка — ради этого он и выбран', () => {
    const early = ulid(1_600_000_000_000)
    const late = ulid(1_700_000_000_000)
    expect(early < late).toBe(true)
  })

  it('сохраняет порядок внутри одной миллисекунды', () => {
    // Так выглядит импорт из Obsidian: сотня событий создаётся в цикле,
    // Date.now() у всех одинаковый. Без монотонности порядок случайный.
    const ms = 1_700_000_000_000
    const ids = Array.from({ length: 500 }, () => ulid(ms))
    expect([...ids].sort()).toEqual(ids)
  })

  it('порядок сохраняется и на живых вызовах подряд', () => {
    const ids = Array.from({ length: 2000 }, () => ulid())
    expect([...ids].sort()).toEqual(ids)
  })
})

describe('isUlid', () => {
  it('принимает свои', () => {
    expect(isUlid(ulid())).toBe(true)
  })

  it('отвергает чужое', () => {
    expect(isUlid('')).toBe(false)
    expect(isUlid('коротко')).toBe(false)
    // I, L, O, U исключены из алфавита, чтобы не путались с 1 и 0.
    expect(isUlid('01JIIIIIIIIIIIIIIIIIIIIIII')).toBe(false)
    expect(isUlid('01j8x9k2m3n4p5q6r7s8t9v0w1')).toBe(false)
  })

  it('ulidTime отвергает не-ULID', () => {
    expect(ulidTime('мусор')).toBeNull()
  })
})
