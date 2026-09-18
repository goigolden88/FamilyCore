import { describe, expect, it } from 'vitest'
import { appendError, ERROR_LOG_SIZE, issueUrl, ISSUE_TITLE, reportText, screenPath, shortMessage } from './report.ts'
import type { AppError, ReportFacts } from './report.ts'

function error(minute: number, message = `ошибка ${minute}`): AppError {
  return {
    at: `2026-09-12T10:${String(minute).padStart(2, '0')}:00.000Z`,
    message,
    where: '#/inbox',
  }
}

const FACTS: ReportFacts = {
  built: '2026-09-12T09:00:00.000Z',
  schema: 2,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
  installed: true,
  viewport: { width: 390, height: 664, ratio: 3 },
  sync: 'off',
  errors: [],
}

describe('журнал ошибок', () => {
  it('новая ошибка — первой', () => {
    expect(appendError([error(1)], error(2))).toEqual([error(2), error(1)])
  })

  it('старые обрезаются по размеру журнала', () => {
    const full = Array.from({ length: ERROR_LOG_SIZE }, (_, index) => error(index))
    const next = appendError(full, error(59))
    expect(next).toHaveLength(ERROR_LOG_SIZE)
    expect(next[0]).toEqual(error(59))
    expect(next).not.toContainEqual(full.at(-1))
  })

  it('мусор в настройках отбрасывается, а не роняет журнал', () => {
    expect(appendError('чушь', error(1))).toEqual([error(1)])
    expect(appendError([null, {}, 'x', { at: 1, message: 'm', where: '#/' }, error(2)], error(3))).toEqual([
      error(3),
      error(2),
    ])
  })
})

describe('экран ошибки — путь без запроса, Р-66 «Делу Время»', () => {
  it('текст из «Поделиться» в отчёт не попадает', () => {
    expect(screenPath('#/inbox?shared=%D0%BB%D0%B8%D1%87%D0%BD%D0%BE%D0%B5')).toBe('#/inbox')
    expect(screenPath('#/time?day=2026-09-10')).toBe('#/time')
  })

  it('главный экран — «#/»', () => {
    expect(screenPath('')).toBe('#/')
    expect(screenPath('#')).toBe('#/')
    expect(screenPath('#/?x=1')).toBe('#/')
  })
})

describe('текст ошибки', () => {
  it('берётся первая строка — стек сборки ничего не скажет', () => {
    expect(shortMessage('  TypeError: x is undefined \n    at a (index.js:1:2)')).toBe('TypeError: x is undefined')
  })

  it('пустой — называется словами', () => {
    expect(shortMessage('')).toBe('без текста')
    expect(shortMessage('\n')).toBe('без текста')
  })

  it('длинный обрезается многоточием', () => {
    const long = 'я'.repeat(1000)
    const short = shortMessage(long)
    expect(short.length).toBeLessThan(long.length)
    expect(short.endsWith('…')).toBe(true)
  })
})

describe('отчёт', () => {
  it('несёт технику и место для слов человека', () => {
    const text = reportText(FACTS)
    expect(text).toContain('Что случилось')
    expect(text).toContain('Схема данных: 2')
    expect(text).toContain('Режим: установлено иконкой')
    expect(text).toContain('Окно: 390×664, плотность 3')
    expect(text).toContain('Синхронизация: выключена')
    expect(text).toContain('iPhone OS')
    expect(text).toContain('Ошибок приложение не записало')
    expect(text).not.toContain('undefined')
  })

  it('вкладка и синхронизация с ошибкой — словами, без текста ошибки', () => {
    const text = reportText({ ...FACTS, installed: false, sync: 'error' })
    expect(text).toContain('Режим: во вкладке браузера')
    expect(text).toContain('Синхронизация: включена, последний обмен с ошибкой')
  })

  it('ошибки — списком: экран и текст', () => {
    const text = reportText({ ...FACTS, errors: [error(2, 'TypeError: сломалось'), error(1)] })
    expect(text).toContain('последние 2')
    expect(text).toMatch(/- .+ · #\/inbox · TypeError: сломалось/)
    expect(text).not.toContain('не записало')
  })
})

describe('адрес issue — из адреса сайта', () => {
  it('сайт проекта → его репозиторий', () => {
    const url = issueUrl({ hostname: 'goigolden88.github.io', pathname: '/DeluVremya/' }, ISSUE_TITLE, 'тело')
    expect(url?.startsWith('https://github.com/goigolden88/DeluVremya/issues/new?')).toBe(true)
  })

  it('заголовок и отчёт доезжают целиком — кириллица, переносы, звёздочки', () => {
    const body = reportText({ ...FACTS, errors: [error(1, 'Ошибка: «кавычки» & амперсанд')] })
    const url = issueUrl({ hostname: 'goigolden88.github.io', pathname: '/DeluVremya/' }, ISSUE_TITLE, body)
    const params = new URL(url ?? '').searchParams
    expect(params.get('title')).toBe(ISSUE_TITLE)
    expect(params.get('body')).toBe(body)
  })

  it('форк — в свой репозиторий', () => {
    const url = issueUrl({ hostname: 'friend.github.io', pathname: '/DeluVremya/index.html' }, ISSUE_TITLE, '')
    expect(url?.startsWith('https://github.com/friend/DeluVremya/issues/new?')).toBe(true)
  })

  it('сайт пользователя в корне — репозиторий по адресу', () => {
    expect(issueUrl({ hostname: 'friend.github.io', pathname: '/' }, ISSUE_TITLE, '')).toMatch(
      /^https:\/\/github\.com\/friend\/friend\.github\.io\/issues\/new\?/,
    )
    expect(issueUrl({ hostname: 'friend.github.io', pathname: '/index.html' }, ISSUE_TITLE, '')).toMatch(
      /^https:\/\/github\.com\/friend\/friend\.github\.io\/issues\/new\?/,
    )
  })

  it('не GitHub Pages — адреса нет', () => {
    expect(issueUrl({ hostname: 'localhost', pathname: '/DeluVremya/' }, ISSUE_TITLE, '')).toBeNull()
    expect(issueUrl({ hostname: 'diary.example.com', pathname: '/' }, ISSUE_TITLE, '')).toBeNull()
    expect(issueUrl({ hostname: 'github.io', pathname: '/x/' }, ISSUE_TITLE, '')).toBeNull()
  })
})
