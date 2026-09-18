import { describe, expect, it } from 'vitest'
import { MONTH_FOLD_FROM, monthFoldedByDefault } from './monthFold.ts'

describe('месяцы длинного списка — Р-78, Р-82', () => {
  it('свежий месяц развёрнут всегда', () => {
    expect(monthFoldedByDefault(0, MONTH_FOLD_FROM * 10)).toBe(false)
  })

  it('старые свёрнуты, только когда список длинный', () => {
    expect(monthFoldedByDefault(1, MONTH_FOLD_FROM + 1)).toBe(true)
    expect(monthFoldedByDefault(1, MONTH_FOLD_FROM)).toBe(false)
    expect(monthFoldedByDefault(3, 5)).toBe(false)
  })
})
