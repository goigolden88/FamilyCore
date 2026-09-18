import { describe, expect, it } from 'vitest'
import { backupNote, backupSummary, STALE_DAYS } from './backup.ts'
import type { SyncFacts } from './backup.ts'

const NOW = '2026-09-09'

/** Время в ISO по дате: выгрузка отмечается моментом, а не днём. */
function at(day: string): string {
  return `${day}T12:00:00.000Z`
}

const off: SyncFacts = { state: 'off', lastAt: null }
const working: SyncFacts = { state: 'idle', lastAt: at('2026-09-09') }

describe('backupSummary — итог у свёрнутого раздела', () => {
  it('прошедшая синхронизация — копия в репозитории, без тревоги', () => {
    expect(backupSummary(null, working, NOW)).toEqual({ tone: 'muted', text: 'копия в репозитории' })
  })

  it('без единой выгрузки и без синхронизации — тревога', () => {
    expect(backupSummary(null, off, NOW)).toEqual({ tone: 'error', text: 'копии нет' })
  })

  it('свежая выгрузка называется днём', () => {
    expect(backupSummary(at('2026-09-08'), off, NOW)).toEqual({ tone: 'muted', text: 'файлом вчера' })
  })

  it('старая выгрузка краснеет тем же порогом, что и полная строка', () => {
    const summary = backupSummary(at('2026-08-26'), off, NOW)
    expect(summary.tone).toBe('error')
    expect(summary.text).toMatch(/^файлом 14\sдней назад$/)
  })

  it('падающая синхронизация не прячет тревогу за свежей выгрузкой', () => {
    const failing: SyncFacts = { state: 'error', lastAt: at('2026-09-01') }
    expect(backupSummary(at('2026-09-08'), failing, NOW)).toEqual({ tone: 'error', text: 'файлом вчера' })
  })
})

describe('backupNote', () => {
  describe('синхронизация выключена — файл единственная копия', () => {
    it('без единой выгрузки тревожится', () => {
      const note = backupNote(null, off, NOW)
      expect(note.tone).toBe('error')
      expect(note.text).toContain('ни разу не забирали')
    })

    it('свежая выгрузка не тревожит', () => {
      const note = backupNote(at('2026-09-08'), off, NOW)
      expect(note.tone).toBe('muted')
      expect(note.text).toBe('Последняя выгрузка: вчера.')
    })

    it('краснеет через две недели', () => {
      const note = backupNote(at('2026-08-26'), off, NOW)
      expect(note.tone).toBe('error')
      expect(note.text).toContain('всё новое живёт только здесь')
    })

    it('порог ровно на STALE_DAYS, не позже', () => {
      expect(STALE_DAYS).toBe(14)
      // 26.08 — ровно четырнадцатый день, 27.08 — тринадцатый.
      expect(backupNote(at('2026-08-26'), off, NOW).tone).toBe('error')
      expect(backupNote(at('2026-08-27'), off, NOW).tone).toBe('muted')
    })
  })

  describe('синхронизация работает — тревога ложная', () => {
    it('приглушает даже без единой выгрузки файлом', () => {
      const note = backupNote(null, working, NOW)
      expect(note.tone).toBe('muted')
      expect(note.text).toContain('Копия есть в репозитории')
      expect(note.text).toContain('Файлом копию не забирали')
    })

    it('приглушает и старую выгрузку — копия в репозитории свежая', () => {
      const note = backupNote(at('2026-01-01'), working, NOW)
      expect(note.tone).toBe('muted')
      expect(note.text).not.toContain('только здесь')
    })

    it('называет обе даты: когда синхронизировано и когда забирали файлом', () => {
      const note = backupNote(at('2026-09-08'), working, NOW)
      expect(note.text).toBe('Копия есть в репозитории, синхронизировано сегодня. Файлом — вчера.')
    })

    it('идущий проход тоже считается: копия от прошлого прохода на месте', () => {
      const note = backupNote(null, { state: 'syncing', lastAt: at('2026-09-01') }, NOW)
      expect(note.tone).toBe('muted')
    })
  })

  describe('синхронизация настроена, но копии от неё нет', () => {
    it('упавшая синхронизация тревожит даже при свежей выгрузке', () => {
      // Настроенная синхронизация выглядит как «я в порядке». Если она
      // не проходит, молчать об этом нельзя вдвойне.
      const note = backupNote(at('2026-09-09'), { state: 'error', lastAt: at('2026-09-01') }, NOW)
      expect(note.tone).toBe('error')
      expect(note.text).toContain('Синхронизация не проходит')
      expect(note.text).toContain('сегодня')
    })

    it('ни разу не прошедшая синхронизация называет причину', () => {
      const note = backupNote(at('2026-09-09'), { state: 'idle', lastAt: null }, NOW)
      expect(note.tone).toBe('error')
      expect(note.text).toContain('ещё ни разу не прошла')
    })

    it('без выгрузки и без прохода — самый тревожный случай', () => {
      const note = backupNote(null, { state: 'error', lastAt: null }, NOW)
      expect(note.tone).toBe('error')
      expect(note.text).toContain('Синхронизация не проходит')
      expect(note.text).toContain('ни разу не забирали')
    })
  })
})
