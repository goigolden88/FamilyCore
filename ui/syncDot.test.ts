import { describe, expect, it } from 'vitest'
import { syncDot } from './syncDot.ts'

describe('точка на шестерёнке', () => {
  it('выключенная синхронизация точки не даёт, даже с неотправленным', () => {
    expect(syncDot({ state: 'off', pending: 12 })).toBe('')
  })

  it('ошибка — красная, с очередью и без', () => {
    expect(syncDot({ state: 'error', pending: 0 })).toBe('dot dot--error')
    expect(syncDot({ state: 'error', pending: 3 })).toBe('dot dot--error')
  })

  it('очередь не ушла — серая', () => {
    expect(syncDot({ state: 'idle', pending: 2 })).toBe('dot')
    expect(syncDot({ state: 'syncing', pending: 1 })).toBe('dot')
  })

  it('всё отправлено — точки нет', () => {
    expect(syncDot({ state: 'idle', pending: 0 })).toBe('')
  })
})
