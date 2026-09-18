import { describe, expect, it } from 'vitest'
import { installAdvice, isIos, type InstallFacts } from './install.ts'

const tab: InstallFacts = { standalone: false, justInstalled: false, ios: false, canPrompt: false }

describe('совет по установке — Р-69', () => {
  it('открыто иконкой — установлено, что бы ни присылал браузер', () => {
    expect(installAdvice({ ...tab, standalone: true, canPrompt: true })).toBe('installed')
    expect(installAdvice({ ...tab, standalone: true, ios: true })).toBe('installed')
  })

  it('установили из этой вкладки — установлено, хоть вкладка и осталась', () => {
    expect(installAdvice({ ...tab, justInstalled: true })).toBe('installed')
  })

  it('Chrome прислал событие — кнопка', () => {
    expect(installAdvice({ ...tab, canPrompt: true })).toBe('prompt')
  })

  it('iPhone во вкладке — инструкция, а не кнопка', () => {
    expect(installAdvice({ ...tab, ios: true })).toBe('ios')
    expect(installAdvice({ ...tab, ios: true, canPrompt: true })).toBe('ios')
  })

  it('браузер не предлагает — через его меню', () => {
    expect(installAdvice(tab)).toBe('manual')
  })
})

describe('isIos', () => {
  it('iPhone и старый iPad — по строке браузера', () => {
    expect(isIos('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 'iPhone', 5)).toBe(true)
    expect(isIos('Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X)', 'iPad', 5)).toBe(true)
  })

  it('новый iPad называет себя Маком — выдаёт сенсорный экран', () => {
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 5)).toBe(true)
  })

  it('Мак без сенсора, Android и Windows — нет', () => {
    expect(isIos('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'MacIntel', 0)).toBe(false)
    expect(isIos('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'Linux armv8l', 5)).toBe(false)
    expect(isIos('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 0)).toBe(false)
  })
})
