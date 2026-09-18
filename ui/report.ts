/**
 * «Сообщить об ошибке» (Р-66 «Делу Время»; механика «Дневников», Р-78 «Дневников»): журнал ошибок
 * и отчёт.
 *
 * Отчёт — только техника: ни записей, ни имени репозитория данных. Он уходит
 * в публичный issue или в мессенджер, и человек видит его целиком до отправки.
 *
 * Сборка отчёта и адрес issue — чистые функции с тестами. Ниже — журнал:
 * ловля необработанных ошибок страницы и запись в `settings` базы приложения —
 * она приходит аргументом (Я-03).
 */

import type { KeyValue } from '../core/db.ts'
import type { SyncState } from '../core/sync.ts'

/** Одна ошибка страницы: когда, текст, на каком экране. */
export type AppError = { at: string; message: string; where: string }

/** Сколько ошибок помнить. Хватает, чтобы увидеть повтор, и адрес issue не раздувается. */
export const ERROR_LOG_SIZE = 10

/** Длиннее сообщение обрезается: стек минифицированной сборки ничего не скажет. */
const MESSAGE_MAX = 300

/** Ключ в `settings`. Не синхронизируется: у каждого устройства свои ошибки. */
const KEY = 'errorLog'

/** Заголовок issue. Человек поправит его, прежде чем отправить. */
export const ISSUE_TITLE = 'Ошибка в приложении'

function isAppError(value: unknown): value is AppError {
  if (typeof value !== 'object' || value === null) return false
  const { at, message, where } = value as { at?: unknown; message?: unknown; where?: unknown }
  return typeof at === 'string' && typeof message === 'string' && typeof where === 'string'
}

/** Новая ошибка — первой, старые обрезаются. Мусор в настройках отбрасывается. */
export function appendError(stored: unknown, error: AppError, size: number = ERROR_LOG_SIZE): AppError[] {
  const previous = Array.isArray(stored) ? stored.filter(isAppError) : []
  return [error, ...previous].slice(0, size)
}

/** Первая строка сообщения, обрезанная. */
export function shortMessage(message: string): string {
  const first = message.split('\n')[0]?.trim() ?? ''
  const text = first === '' ? 'без текста' : first
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX)}…` : text
}

// ─── Отчёт ─────────────────────────────────────────────────────────────────

export type ReportFacts = {
  /** Время сборки, ISO. */
  built: string
  schema: number
  userAgent: string
  installed: boolean
  /** Окно в CSS-пикселях и плотность экрана. */
  viewport: { width: number; height: number; ratio: number }
  /**
   * Только состояние. Текст ошибки синхронизации в отчёт не идёт: в нём
   * бывает имя репозитория данных, а issue публичный.
   */
  sync: SyncState
  errors: readonly AppError[]
}

const SYNC_WORDS: Record<SyncState, string> = {
  off: 'выключена',
  idle: 'включена, без ошибок',
  syncing: 'включена, идёт обмен',
  error: 'включена, последний обмен с ошибкой',
}

function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Текст отчёта. Сверху — место для слов человека, ниже — техника. */
export function reportText(facts: ReportFacts): string {
  const { width, height, ratio } = facts.viewport
  const lines = [
    '**Что случилось**',
    '',
    '<что делал, чего ждал и что вышло — своими словами>',
    '',
    '---',
    '',
    `Сборка: ${when(facts.built)}`,
    `Схема данных: ${facts.schema}`,
    `Режим: ${facts.installed ? 'установлено иконкой' : 'во вкладке браузера'}`,
    `Окно: ${width}×${height}, плотность ${ratio}`,
    `Синхронизация: ${SYNC_WORDS[facts.sync]}`,
    `Браузер: ${facts.userAgent}`,
    '',
  ]

  if (facts.errors.length === 0) {
    lines.push('Ошибок приложение не записало.')
  } else {
    lines.push(`Ошибки приложения, последние ${facts.errors.length}:`)
    for (const error of facts.errors) {
      lines.push(`- ${when(error.at)} · ${error.where} · ${error.message}`)
    }
  }

  return lines.join('\n')
}

/**
 * Адрес формы нового issue — из адреса сайта: `<владелец>.github.io/<репозиторий>/`
 * → `github.com/<владелец>/<репозиторий>`. Константы в коде нет, и форк
 * получает отчёты в свой репозиторий.
 *
 * null — сайт живёт не на GitHub Pages: разработка, свой домен. Тогда
 * остаются «Поделиться» и «Скопировать».
 */
export function issueUrl(
  place: { hostname: string; pathname: string },
  title: string,
  body: string,
): string | null {
  const owner = /^([a-z0-9-]+)\.github\.io$/i.exec(place.hostname)?.[1]
  if (!owner) return null

  // Сайт пользователя живёт в корне, и его репозиторий называется по адресу.
  const first = place.pathname.split('/').find((part) => part !== '')
  const repo = first === undefined || first.endsWith('.html') ? `${owner}.github.io` : first

  const query = new URLSearchParams({ title, body })
  return `https://github.com/${owner}/${repo}/issues/new?${query.toString()}`
}

// ─── Журнал ────────────────────────────────────────────────────────────────

/** Записи журнала идут очередью: две ошибки разом не должны затереть друг друга. */
let writes: Promise<void> = Promise.resolve()

/** Куда пишется журнал. Приходит в `listenErrors`; до этого ошибки не пишутся. */
let journal: KeyValue | null = null

/**
 * Экран, на котором случилась ошибка, — путь без запроса (Р-66 «Делу Время»). В запросе
 * здесь бывает текст из «Поделиться», `#/inbox?shared=…` (Р-16 «Делу Время»), а отчёт
 * уходит в публичный issue.
 */
export function screenPath(hash: string): string {
  const path = hash.split('?')[0] ?? ''
  return path === '' || path === '#' ? '#/' : path
}

function record(message: string): void {
  const error: AppError = {
    at: new Date().toISOString(),
    message: shortMessage(message),
    where: screenPath(location.hash),
  }
  writes = writes.then(async () => {
    try {
      if (journal) await journal.set(KEY, appendError(await journal.get<unknown>(KEY), error))
    } catch {
      // Журнал — не повод падать. И не повод писать в журнал.
    }
  })
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  return typeof value === 'string' ? value : 'без текста'
}

/**
 * Ловит необработанные ошибки страницы. Зовётся один раз из `main.tsx`,
 * до первого экрана: ошибка при отрисовке тоже должна попасть в журнал —
 * React 19 сообщает о ней событием `error` окна.
 *
 * `settings` — настройки базы приложения: журнал у каждого устройства свой.
 */
export function listenErrors(settings: KeyValue): void {
  journal = settings
  window.addEventListener('error', (event) => {
    record(event.error instanceof Error ? describe(event.error) : event.message)
  })
  window.addEventListener('unhandledrejection', (event) => {
    record(describe(event.reason))
  })
}

export async function readErrors(settings: KeyValue): Promise<AppError[]> {
  const stored = await settings.get<unknown>(KEY)
  return Array.isArray(stored) ? stored.filter(isAppError) : []
}

export async function clearErrors(settings: KeyValue): Promise<void> {
  await writes
  await settings.remove(KEY)
}
