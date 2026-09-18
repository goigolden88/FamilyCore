/**
 * Что сказать про копию данных: есть ли она вообще и стоит ли тревожиться.
 *
 * Чистая функция, а не кусок компонента, потому что правило здесь не
 * очевидное. Предупреждение «последняя выгрузка была N дней назад»
 * писалось, когда файл был единственной копией вне браузера. С Этапа 2
 * копия лежит в приватном репозитории, и та же красная строка стала
 * ложной тревогой — а ложная тревога хуже отсутствующей: на неё
 * перестают смотреть, и настоящую пропускают вместе с ней.
 *
 * Приглушается она не от того, что синхронизация настроена, а от того,
 * что она **хотя бы раз прошла**. Настроенная, но падающая синхронизация
 * копии не даёт, и молчать о ней нельзя вдвойне.
 */

import { daysBetween, days, formatDate, toDateStr } from '../core/dates.ts'
import type { DateStr } from '../core/dates.ts'
import type { SyncState } from '../core/sync.ts'

/** Через сколько дней без выгрузки напоминание становится тревожным. */
export const STALE_DAYS = 14

export type BackupNote = {
  tone: 'muted' | 'error'
  text: string
}

export type SyncFacts = {
  state: SyncState
  /** Время последнего успешного прохода. Null — ни одного не было. */
  lastAt: string | null
}

/** Когда забирали копию: «сегодня», «вчера», «12 дней назад, 28.08.2026». */
function when(at: string, now: DateStr): string {
  const day = toDateStr(new Date(at))
  const ago = daysBetween(day, now)
  if (ago === 0) return 'сегодня'
  if (ago === 1) return 'вчера'
  return `${days(ago)} назад, ${formatDate(day)}`
}

function agoDays(at: string, now: DateStr): number {
  return daysBetween(toDateStr(new Date(at)), now)
}

/**
 * `lastExportAt` — когда в последний раз сохраняли файл, null — ни разу.
 * `sync` — состояние синхронизации на этом устройстве.
 */
export function backupNote(
  lastExportAt: string | null,
  sync: SyncFacts,
  now: DateStr,
): BackupNote {
  // Копия в репозитории есть: файл теперь запасной путь, а не единственный.
  if (sync.state !== 'off' && sync.state !== 'error' && sync.lastAt !== null) {
    const synced = when(sync.lastAt, now)
    const saved =
      lastExportAt === null
        ? 'Файлом копию не забирали.'
        : `Файлом — ${when(lastExportAt, now)}.`
    return { tone: 'muted', text: `Копия есть в репозитории, синхронизировано ${synced}. ${saved}` }
  }

  // Синхронизация настроена, но копии от неё нет. Причину надо назвать:
  // иначе человек видит настроенную синхронизацию и считает себя в порядке.
  const broken =
    sync.state === 'error'
      ? 'Синхронизация не проходит. '
      : sync.state !== 'off' && sync.lastAt === null
        ? 'Синхронизация ещё ни разу не прошла. '
        : ''

  if (lastExportAt === null) {
    return {
      tone: 'error',
      text:
        `${broken}Копию ещё ни разу не забирали. Данные есть только в этом браузере — ` +
        'очистка данных сайта сотрёт их целиком.',
    }
  }

  const stale = agoDays(lastExportAt, now) >= STALE_DAYS
  return {
    tone: broken || stale ? 'error' : 'muted',
    text:
      `${broken}Последняя выгрузка: ${when(lastExportAt, now)}.` +
      (stale ? ' С тех пор всё новое живёт только здесь.' : ''),
  }
}

/**
 * То же в два-три слова — для заголовка свёрнутого раздела (Р-61).
 *
 * Тон берётся у `backupNote`, чтобы правило было одно: свёрнутый раздел
 * не должен молчать о том, что копии нет, и не должен тревожить, когда
 * она лежит в репозитории.
 */
export function backupSummary(
  lastExportAt: string | null,
  sync: SyncFacts,
  now: DateStr,
): BackupNote {
  const { tone } = backupNote(lastExportAt, sync, now)
  if (sync.state !== 'off' && sync.state !== 'error' && sync.lastAt !== null) {
    return { tone, text: 'копия в репозитории' }
  }
  if (lastExportAt === null) return { tone, text: 'копии нет' }

  const ago = agoDays(lastExportAt, now)
  const text = ago === 0 ? 'сегодня' : ago === 1 ? 'вчера' : `${days(ago)} назад`
  return { tone, text: `файлом ${text}` }
}
