import { describe, expect, it } from 'vitest'
import { expiryDay as fromSync } from './sync.ts'
import { expiryDay, WARN_DAYS } from './token.ts'
import { WARN_DAYS as fromSettings } from '../ui/SyncSettings.tsx'
import source from './token.ts?raw'

describe('token', () => {
  it('порог и разбор дня — одни на приложения и бота (Я-39)', () => {
    expect(WARN_DAYS).toBe(30)
    expect(fromSettings).toBe(WARN_DAYS)
    expect(fromSync).toBe(expiryDay)
    expect(expiryDay('2027-09-09 12:00:00 +0300')).toBe('2027-09-09')
    expect(expiryDay(null)).toBeNull()
  })

  it('берёт только dates.ts — бот запускает его в Node без сборки', () => {
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])
    expect(new Set(imports)).toEqual(new Set(['./dates.ts']))
  })
})
