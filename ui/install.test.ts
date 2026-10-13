import { describe, expect, it } from 'vitest'
import { installAdvice, isIos, isMacSafari, type InstallFacts } from './install.ts'

const tab: InstallFacts = { standalone: false, justInstalled: false, ios: false, macSafari: false, canPrompt: false }

describe('совет по установке — Р-69 «Дневников»', () => {
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

  it('Safari на Маке во вкладке — «Добавить в Dock»; установлено — установлено', () => {
    expect(installAdvice({ ...tab, macSafari: true })).toBe('mac-safari')
    expect(installAdvice({ ...tab, macSafari: true, standalone: true })).toBe('installed')
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

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const BLINK = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)'

describe('isMacSafari', () => {
  it('Safari на Маке — да', () => {
    expect(isMacSafari(`${MAC} Version/18.0 Safari/605.1.15`, 'MacIntel', 0)).toBe(true)
  })

  it('Chrome, Edge, Opera, Яндекс и Firefox на Маке — нет', () => {
    expect(isMacSafari(`${BLINK} Chrome/140.0.0.0 Safari/537.36`, 'MacIntel', 0)).toBe(false)
    expect(isMacSafari(`${BLINK} Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0`, 'MacIntel', 0)).toBe(false)
    expect(isMacSafari(`${BLINK} Chrome/140.0.0.0 Safari/537.36 OPR/120.0.0.0`, 'MacIntel', 0)).toBe(false)
    expect(isMacSafari(`${BLINK} Chrome/140.0.0.0 YaBrowser/25.8.0.0 Safari/537.36`, 'MacIntel', 0)).toBe(false)
    expect(isMacSafari('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0', 'MacIntel', 0)).toBe(false)
  })

  it('iPad (сенсорный «Мак») и Safari не на Маке — нет', () => {
    expect(isMacSafari(`${MAC} Version/18.0 Safari/605.1.15`, 'MacIntel', 5)).toBe(false)
    expect(isMacSafari('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1', 'iPhone', 5)).toBe(false)
  })
})
