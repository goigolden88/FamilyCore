import { describe, expect, it } from 'vitest'
import {
  appendWake,
  combineResults,
  DEFAULT_WINDOW,
  inWindow,
  LOG_SIZE,
  parseWindow,
  planWake,
  REMINDER_TAG,
  type Wake,
} from './notify.ts'

// Правила — «Дневников», и тесты их же: механика перенесена без изменений.

describe('имя фоновой проверки — Р-24 «Делу Время»', () => {
  it('общее, не про день: после выпуска не меняется', () => {
    expect(REMINDER_TAG).toBe('remind')
  })
})

describe('окно со звуком', () => {
  it('по умолчанию 12–20, как в Архитектуре', () => {
    expect(DEFAULT_WINDOW).toEqual({ from: 12, to: 20 })
  })

  it('начало включительно, конец исключительно', () => {
    const window = { from: 12, to: 20 }
    expect(inWindow(11, window)).toBe(false)
    expect(inWindow(12, window)).toBe(true)
    expect(inWindow(19, window)).toBe(true)
    expect(inWindow(20, window)).toBe(false)
  })

  it('окно через полночь', () => {
    const night = { from: 22, to: 8 }
    expect(inWindow(23, night)).toBe(true)
    expect(inWindow(3, night)).toBe(true)
    expect(inWindow(8, night)).toBe(false)
    expect(inWindow(12, night)).toBe(false)
  })

  it('равные концы — круглые сутки', () => {
    expect(inWindow(3, { from: 9, to: 9 })).toBe(true)
    expect(inWindow(15, { from: 9, to: 9 })).toBe(true)
  })

  it('кривое окно в настройках даёт умолчание, а не падение', () => {
    expect(parseWindow(undefined)).toEqual(DEFAULT_WINDOW)
    expect(parseWindow({ from: '9', to: 21 })).toEqual(DEFAULT_WINDOW)
    expect(parseWindow({ from: 24, to: 5 })).toEqual(DEFAULT_WINDOW)
    expect(parseWindow({ from: 9.5, to: 21 })).toEqual(DEFAULT_WINDOW)
    expect(parseWindow({ from: 9, to: 21 })).toEqual({ from: 9, to: 21 })
  })
})

describe('что делать при пробуждении', () => {
  const base = { day: '2026-09-13', window: DEFAULT_WINDOW, loudDay: null, quietDay: null }

  it('в окне — со звуком', () => {
    expect(planWake({ ...base, hour: 14 })).toBe('loud')
  })

  it('ночью — без звука, а не никогда', () => {
    expect(planWake({ ...base, hour: 3 })).toBe('quiet')
  })

  it('второй раз за ночь не показывает', () => {
    expect(planWake({ ...base, hour: 5, quietDay: '2026-09-13' })).toBe('already')
  })

  it('днём после ночного тихого — повторяет со звуком', () => {
    expect(planWake({ ...base, hour: 13, quietDay: '2026-09-13' })).toBe('loud')
  })

  it('громкое сегодня уже было — молчит и в окне', () => {
    expect(planWake({ ...base, hour: 15, loudDay: '2026-09-13' })).toBe('already')
  })

  it('вчерашнее громкое сегодня не мешает', () => {
    expect(planWake({ ...base, hour: 15, loudDay: '2026-09-12' })).toBe('loud')
  })
})

describe('два напоминания в одно пробуждение — Р-51 «Делу Время»', () => {
  it('сбой — первым, потом показанное; «не о чем» — только если не о чем ни по одному', () => {
    expect(combineResults(['nothing', 'shown'])).toBe('shown')
    expect(combineResults(['quiet', 'already'])).toBe('quiet')
    expect(combineResults(['shown', 'failed'])).toBe('failed')
    expect(combineResults(['already', 'nothing'])).toBe('already')
    expect(combineResults(['nothing', 'nothing'])).toBe('nothing')
  })
})

describe('журнал пробуждений', () => {
  const wake = (at: string): Wake => ({ at, result: 'nothing' })

  it('новое пробуждение — первым', () => {
    const log = appendWake([wake('2026-09-12T03:00:00.000Z')], wake('2026-09-13T03:00:00.000Z'))
    expect(log.map((each) => each.at)).toEqual(['2026-09-13T03:00:00.000Z', '2026-09-12T03:00:00.000Z'])
  })

  it('помнит не больше LOG_SIZE', () => {
    const full = Array.from({ length: LOG_SIZE }, (_, index) =>
      wake(`2026-08-${String(index + 1).padStart(2, '0')}T03:00:00.000Z`),
    )
    const log = appendWake(full, wake('2026-09-13T03:00:00.000Z'))
    expect(log).toHaveLength(LOG_SIZE)
    expect(log[0]?.at).toBe('2026-09-13T03:00:00.000Z')
  })

  it('мусор в настройках не роняет журнал', () => {
    expect(appendWake('не массив', wake('2026-09-13T03:00:00.000Z'))).toHaveLength(1)
    const log = appendWake(
      [{ at: 1 }, { at: 'x', result: 'чепуха' }, wake('2026-09-12T03:00:00.000Z')],
      wake('2026-09-13T03:00:00.000Z'),
    )
    expect(log).toHaveLength(2)
  })
})
