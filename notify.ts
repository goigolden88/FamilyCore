/**
 * Напоминания: о незаполненном дне (Р-14, Р-24) и об обзоре недели (Р-51).
 *
 * Механика — «Дневников», их `notify.ts` с коммита `a913dcb`: окно со
 * звуком, тихое вне окна, со звуком не чаще раза в день, журнал
 * пробуждений. Своё здесь — о чём напоминать и имя фоновой проверки.
 *
 * Одна функция на два вызова: service worker зовёт её, когда браузер будит
 * его фоновой синхронизацией, а «Настройки» — по кнопке «Проверить сейчас».
 * Считают они одинаково, и разойтись это не должно.
 *
 * Живёт на уровне приложения, рядом с `app.tsx`, а не в `core`: она знает
 * модули, а ядру это запрещено.
 *
 * Без сервера веб-пуш невозможен — пуш по определению присылает сервер.
 * Отсюда и ограничения: только Chrome на Android, только установленное
 * приложение, частоту и время решает браузер (примерно раз в сутки, без
 * гарантий). Выбрать время нельзя, но можно не шуметь ночью.
 */

import { db } from './core/db.ts'
import { toDateStr } from './core/dates.ts'
import { unfilledNotice } from './modules/time/remind.ts'
import { reviewNotice } from './screens/review.ts'
import { readScreenNames } from './ui/screenNames.ts'

/**
 * Имя фоновой проверки (Р-24). Общее на все напоминания приложения:
 * обзор недели встанет под него же. На установленных копиях проверка
 * заведена под этим именем — переименование выключило бы её молча.
 */
export const REMINDER_TAG = 'remind'

// Ключи в `settings`: у каждого устройства свои — напоминание на телефоне
// не отменяет напоминания на компьютере (02-Архитектура, «Локальное хранилище»).

/** В какой день уже приходило напоминание со звуком. */
const LOUD_DAY = 'reminderLastDay'
/** В какой день уже приходило тихое, вне окна. Второй раз за ночь незачем. */
const QUIET_DAY = 'reminderQuietDay'
/** Часы со звуком. */
const WINDOW = 'reminderWindow'
/** Последние фоновые пробуждения. */
const LOG = 'reminderLog'
/** То же для напоминания об обзоре недели (Р-51): свои дни, прежние ключи смысла не меняют. */
const REVIEW_LOUD_DAY = 'reminderReviewDay'
const REVIEW_QUIET_DAY = 'reminderReviewQuietDay'

/** Чаще раза в полсуток браузер будить не станет, и просить незачем. */
const MIN_INTERVAL = 12 * 60 * 60 * 1000

export type RemindResult = 'shown' | 'quiet' | 'nothing' | 'already' | 'failed'

type Notice = {
  title: string
  body: string
  /** Уведомление одной темы заменяет прежнее, а не копится стопкой. */
  tag: string
  /** Куда ведёт тап — путь хеш-роутинга. */
  target: string
}

// ─── Тихие часы ────────────────────────────────────────────────────────────

/** Часы со звуком: с `from` включительно до `to` исключительно, 0..23. */
export type ReminderWindow = { from: number; to: number }

export const DEFAULT_WINDOW: ReminderWindow = { from: 12, to: 20 }

function isHour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23
}

/** Окно из настроек. Кривое или отсутствующее — умолчание, а не падение. */
export function parseWindow(value: unknown): ReminderWindow {
  if (typeof value !== 'object' || value === null) return DEFAULT_WINDOW
  const { from, to } = value as { from?: unknown; to?: unknown }
  return isHour(from) && isHour(to) ? { from, to } : DEFAULT_WINDOW
}

/**
 * Попадает ли час в окно. Окно через полночь — «с 22 до 8» — допустимо:
 * кто-то работает ночью. Равные концы — круглые сутки.
 */
export function inWindow(hour: number, window: ReminderWindow): boolean {
  if (window.from === window.to) return true
  if (window.from < window.to) return hour >= window.from && hour < window.to
  return hour >= window.from || hour < window.to
}

/**
 * Что делать, когда браузер разбудил проверку.
 *
 * Вне окна — без звука, а не никогда: браузер может будить проверку раз
 * в сутки и как раз ночью, и пропуск означал бы, что напоминание не приходит
 * вовсе. Тихое не закрывает день: если браузер разбудит проверку ещё раз
 * уже в окне, то же уведомление повторится со звуком.
 */
export function planWake(state: {
  day: string
  hour: number
  window: ReminderWindow
  /** День последнего напоминания со звуком. */
  loudDay: string | null
  /** День последнего тихого. */
  quietDay: string | null
}): 'loud' | 'quiet' | 'already' {
  if (state.loudDay === state.day) return 'already'
  if (inWindow(state.hour, state.window)) return 'loud'
  return state.quietDay === state.day ? 'already' : 'quiet'
}

// ─── Журнал пробуждений ────────────────────────────────────────────────────

/** Одно пробуждение фоновой проверки: когда и чем кончилось. */
export type Wake = { at: string; result: RemindResult }

/** Сколько пробуждений помнить. Раз в сутки — это три недели. */
export const LOG_SIZE = 20

const RESULTS: readonly RemindResult[] = ['shown', 'quiet', 'nothing', 'already', 'failed']

function isWake(value: unknown): value is Wake {
  if (typeof value !== 'object' || value === null) return false
  const { at, result } = value as { at?: unknown; result?: unknown }
  return typeof at === 'string' && RESULTS.includes(result as RemindResult)
}

/** Новое пробуждение — первым, старые обрезаются. Мусор в настройках отбрасывается. */
export function appendWake(stored: unknown, wake: Wake, size: number = LOG_SIZE): Wake[] {
  const previous = Array.isArray(stored) ? stored.filter(isWake) : []
  return [wake, ...previous].slice(0, size)
}

// ─── Показ ─────────────────────────────────────────────────────────────────

/**
 * Показывает напоминание — со звуком не чаще раза в день.
 *
 * `force` — проверка руками: показывает всегда и со звуком, даже когда
 * напоминать не о чем, иначе не понять, дошло уведомление или сломалось.
 * День не отмечает и в журнал не пишется: проверка не должна отменять
 * настоящее напоминание, а журнал заведён ради фоновых пробуждений.
 */
export async function remind(
  registration: ServiceWorkerRegistration,
  options: { force?: boolean; now?: Date } = {},
): Promise<RemindResult> {
  const force = options.force === true
  const now = options.now ?? new Date()
  const result = await decide(registration, force, now)
  if (!force) await record({ at: now.toISOString(), result })
  return result
}

/** О чём напоминать: текст, тема уведомления, куда ведёт тап, в какие ключи пишется день. */
type Topic = {
  /** Null — напоминать не о чем. */
  notice: { title: string; body: string } | null
  tag: string
  target: string
  loudKey: string
  quietKey: string
}

async function decide(
  registration: ServiceWorkerRegistration,
  force: boolean,
  now: Date,
): Promise<RemindResult> {
  const day = toDateStr(now)
  // Экран в тексте — своим именем этого устройства (Р-26).
  const [names, blocks, reviews] = await Promise.all([readScreenNames(), db.getAll('time'), db.getAll('reviews')])
  const topics: Topic[] = [
    {
      notice: unfilledNotice(blocks, day, names.time),
      tag: 'day',
      target: '/time',
      loudKey: LOUD_DAY,
      quietKey: QUIET_DAY,
    },
    {
      notice: reviewNotice(reviews, day),
      tag: 'review',
      target: '/review',
      loudKey: REVIEW_LOUD_DAY,
      quietKey: REVIEW_QUIET_DAY,
    },
  ]

  if (force) return showAll(registration, topics)

  const window = parseWindow(await db.settings.get<unknown>(WINDOW))
  const results: RemindResult[] = []
  // По очереди: у каждого напоминания свои дни в настройках.
  for (const topic of topics) results.push(await remindTopic(registration, topic, day, now.getHours(), window))
  return combineResults(results)
}

/**
 * Одно напоминание при пробуждении — со своими днями громкого и тихого:
 * громкое о дне не глушит напоминание об обзоре (Р-51). Окно — общее.
 */
async function remindTopic(
  registration: ServiceWorkerRegistration,
  topic: Topic,
  day: string,
  hour: number,
  window: ReminderWindow,
): Promise<RemindResult> {
  if (!topic.notice) return 'nothing'
  const [loudDay, quietDay] = await Promise.all([
    db.settings.get<string>(topic.loudKey),
    db.settings.get<string>(topic.quietKey),
  ])
  const plan = planWake({ day, hour, window, loudDay: loudDay ?? null, quietDay: quietDay ?? null })
  if (plan === 'already') return 'already'

  const loud = plan === 'loud'
  try {
    await show(registration, { ...topic.notice, tag: topic.tag, target: topic.target }, loud)
  } catch {
    return 'failed'
  }
  await db.settings.set(loud ? topic.loudKey : topic.quietKey, day)
  return loud ? 'shown' : 'quiet'
}

/**
 * «Проверить сейчас»: всё, о чём есть напомнить, — со звуком. Не о чем —
 * пустое уведомление, иначе не понять, дошло оно или сломалось.
 */
async function showAll(registration: ServiceWorkerRegistration, topics: readonly Topic[]): Promise<RemindResult> {
  try {
    let shown = false
    for (const topic of topics) {
      if (!topic.notice) continue
      await show(registration, { ...topic.notice, tag: topic.tag, target: topic.target }, true)
      shown = true
    }
    if (shown) return 'shown'
    await show(
      registration,
      {
        title: 'Напоминать не о чем',
        body: 'За сегодня время уже учтено, обзор недели не ждёт. Уведомление пришло, чтобы было видно: они доходят.',
        tag: 'day',
        target: '/time',
      },
      true,
    )
    return 'nothing'
  } catch {
    return 'failed'
  }
}

/** Порядок важности итогов: у пробуждения одна строка журнала. */
const RESULT_ORDER: readonly RemindResult[] = ['failed', 'shown', 'quiet', 'already', 'nothing']

/**
 * Итог пробуждения по нескольким напоминаниям. Сбой — первым: его надо
 * увидеть; «не о чем» — только если не о чем ни по одному.
 */
export function combineResults(results: readonly RemindResult[]): RemindResult {
  return RESULT_ORDER.find((result) => results.includes(result)) ?? 'nothing'
}

function show(registration: ServiceWorkerRegistration, notice: Notice, loud: boolean): Promise<void> {
  // `renotify`: ночное тихое уже лежит в шторке под той же темой, и без
  // этого флага замена его громким прошла бы молча. В типах DOM флага нет.
  const options = {
    body: notice.body,
    tag: notice.tag,
    icon: `${import.meta.env.BASE_URL}pwa-192x192.png`,
    lang: 'ru',
    silent: !loud,
    renotify: loud,
    // Адрес целиком: тап обрабатывает service worker, а у него нет роутера.
    data: { url: `${registration.scope}#${notice.target}` },
  } as NotificationOptions
  return registration.showNotification(notice.title, options)
}

/** Журнал не повод ронять напоминание: не записалось — и ладно. */
async function record(wake: Wake): Promise<void> {
  try {
    await db.settings.set(LOG, appendWake(await db.settings.get<unknown>(LOG), wake))
  } catch {
    // Уведомление уже показано, а без строки в журнале жить можно.
  }
}

// ─── Для экрана настроек ───────────────────────────────────────────────────

/**
 * Где мы: браузер не умеет, человек запретил, выключено, включено.
 * `not-installed` — уведомления разрешены, но фоновую проверку браузер не
 * дал: так бывает у приложения, открытого во вкладке, а не установленного.
 */
export type ReminderStatus = 'unsupported' | 'denied' | 'off' | 'not-installed' | 'on'

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  return (await navigator.serviceWorker.getRegistration()) ?? null
}

function notifications(): boolean {
  return typeof Notification !== 'undefined'
}

export async function reminderStatus(): Promise<ReminderStatus> {
  const reg = await registration()
  if (!reg?.periodicSync || !notifications()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  if (Notification.permission !== 'granted') return 'off'
  const tags = await reg.periodicSync.getTags()
  return tags.includes(REMINDER_TAG) ? 'on' : 'off'
}

/** Разрешение браузер спрашивает только по действию человека — отсюда кнопка. */
export async function enableReminders(): Promise<ReminderStatus> {
  const reg = await registration()
  if (!reg?.periodicSync || !notifications()) return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission === 'denied') return 'denied'
  if (permission !== 'granted') return 'off'

  try {
    await reg.periodicSync.register(REMINDER_TAG, { minInterval: MIN_INTERVAL })
  } catch {
    return 'not-installed'
  }
  return 'on'
}

export async function disableReminders(): Promise<void> {
  const reg = await registration()
  await reg?.periodicSync?.unregister(REMINDER_TAG)
}

/** «Проверить сейчас»: не ждать сутки, чтобы узнать, работает ли. */
export async function checkReminder(): Promise<RemindResult | 'denied' | 'unsupported'> {
  const reg = await registration()
  if (!reg || !notifications()) return 'unsupported'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'
  return remind(reg, { force: true })
}

export async function readWindow(): Promise<ReminderWindow> {
  return parseWindow(await db.settings.get<unknown>(WINDOW))
}

export async function saveWindow(window: ReminderWindow): Promise<void> {
  await db.settings.set(WINDOW, window)
}

/** Журнал пробуждений, свежие сверху. */
export async function readWakes(): Promise<Wake[]> {
  const stored = await db.settings.get<unknown>(LOG)
  return Array.isArray(stored) ? stored.filter(isWake) : []
}
