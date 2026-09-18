import { describe, expect, it } from 'vitest'
import { MIDNIGHT_MARGIN_MS, msUntilMidnight } from './today.ts'

const HOUR = 60 * 60 * 1000

describe('msUntilMidnight', () => {
  it('вечером — до ближайшей полуночи', () => {
    expect(msUntilMidnight(new Date(2026, 8, 13, 23, 0, 0))).toBe(HOUR + MIDNIGHT_MARGIN_MS)
  })

  it('ровно в полночь — до следующей, а не ноль', () => {
    expect(msUntilMidnight(new Date(2026, 8, 13, 0, 0, 0))).toBe(24 * HOUR + MIDNIGHT_MARGIN_MS)
  })

  it('в конце месяца и года — через границу', () => {
    const at = new Date(2026, 11, 31, 23, 30, 0)
    const woke = new Date(at.getTime() + msUntilMidnight(at))
    expect([woke.getFullYear(), woke.getMonth(), woke.getDate()]).toEqual([2027, 0, 1])
  })

  it('после срабатывания уже завтра, а не вчера', () => {
    const at = new Date(2026, 8, 13, 18, 45, 12)
    const woke = new Date(at.getTime() + msUntilMidnight(at))
    expect(woke.getDate()).toBe(14)
    expect(woke.getHours()).toBe(0)
  })
})
