/**
 * Напоминания: механика.
 *
 * Механика — «Дневников», их `notify.ts` с коммита `a913dcb`, через «Делу
 * Время» с d86f0aa: окно со звуком, тихое вне окна, со звуком не чаще раза
 * в день, журнал пробуждений, разрешение и фоновая проверка. О чём
 * напоминать — правило дня и тексты — у приложения: его `src/notify.ts`
 * собирает темы и отдаёт их сюда (Р-48 «Трапезы»: `notify.ts` разделяется).
 *
 * Одна функция на два вызова: service worker зовёт её, когда браузер будит
 * его фоновой синхронизацией, а «Настройки» — по кнопке «Проверить сейчас».
 * Считают они одинаково, и разойтись это не должно.
 *
 * Без сервера веб-пуш невозможен — пуш по определению присылает сервер.
 * Отсюда и ограничения: только Chrome на Android, только установленное
 * приложение, частоту и время решает браузер (примерно раз в сутки, без
 * гарантий). Выбрать время нельзя, но можно не шуметь ночью.
 */

import type { KeyValue } from './core/db.ts'
import { toDateStr } from './core/dates.ts'

/**
 * Имя фоновой проверки (Р-24 «Делу Время»). Общее на все напоминания
 * приложения и одинаковое у всей семьи. На установленных копиях проверка
 * заведена под этим именем — переименование выключило бы её молча.
 */
export const REMINDER_TAG = 'remind'

// Ключи в `settings`: у каждого устройства свои — напоминание на телефоне
// не отменяет напоминания на компьютере (02-Архитектура, «Локальное хранилище»).

/**
 * Дни громкого и тихого напоминания о незаполненном дне — первой темы
 * у каждого приложения семьи. Вторая тема заводит свои ключи
 * («Делу Время»: `reminderReviewDay`, `reminderReviewQuietDay`, Р-51 «Делу Время»).
 */
export const DAY_KEYS = { loud: 'reminderLastDay', quiet: 'reminderQuietDay' } as const
/** Часы со звуком. */
const WINDOW = 'reminderWindow'
/** Последние фоновые пробуждения. */
const LOG = 'reminderLog'

/** Чаще раза в полсуток браузер будить не станет, и просить незачем. */
const MIN_INTERVAL = 12 * 60 * 60 * 1000

export type RemindResult = 'shown' | 'quiet' | 'nothing' | 'already' | 'failed'

export type Notice = {
  title: string
  body: string
  /** Уведомление одной темы заменяет прежнее, а не копится стопкой. */
  tag: string
  /** Куда ведёт тап — путь хеш-роутинга. */
  target: string
}

/** О чём напоминать: текст, тема уведомления, куда ведёт тап, в какие ключи пишется день. */
export type Topic = {
  /** Null — напоминать не о чем. */
  notice: { title: string; body: string } | null
  tag: string
  target: string
  loudKey: string
  quietKey: string
}

/** Что даёт приложение: свои темы на день и текст «напоминать не о чем». */
export type ReminderRules = {
  /** Темы на день `day` — по своим данным и своим правилам (у «Трапезы» — Р-30 «Трапезы»). */
  topics: (day: string) => Promise<Topic[]>
  /** Уведомление «Проверить сейчас», когда напоминать не о чем: оно доказывает, что уведомления доходят. */
  idle: Notice
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

// ─── Напоминания приложения ────────────────────────────────────────────────

/**
 * Напоминания приложения поверх его настроек устройства и его правил.
 * Собирается в `src/notify.ts` приложения; тот же объект зовут работник
 * (`remind`) и «Настройки» (остальное).
 */
export function createReminders(settings: KeyValue, rules: ReminderRules) {
  /**
   * Показывает напоминание — со звуком не чаще раза в день.
   *
   * `force` — проверка руками: показывает всегда и со звуком, даже когда
   * напоминать не о чем, иначе не понять, дошло уведомление или сломалось.
   * День не отмечает и в журнал не пишется: проверка не должна отменять
   * настоящее напоминание, а журнал заведён ради фоновых пробуждений.
   */
  async function remind(
    registration: ServiceWorkerRegistration,
    options: { force?: boolean; now?: Date } = {},
  ): Promise<RemindResult> {
    const force = options.force === true
    const now = options.now ?? new Date()
    const result = await decide(registration, force, now)
    if (!force) await record({ at: now.toISOString(), result })
    return result
  }

  async function decide(registration: ServiceWorkerRegistration, force: boolean, now: Date): Promise<RemindResult> {
    const day = toDateStr(now)
    const topics = await rules.topics(day)

    if (force) return showAll(registration, topics)

    const window = parseWindow(await settings.get<unknown>(WINDOW))
    const results: RemindResult[] = []
    // По очереди: у каждого напоминания свои дни в настройках.
    for (const topic of topics) results.push(await remindTopic(registration, topic, day, now.getHours(), window))
    return combineResults(results)
  }

  /**
   * Одно напоминание при пробуждении — со своими днями громкого и тихого:
   * громкое одной темы не глушит другую (Р-51 «Делу Время»). Окно — общее.
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
      settings.get<string>(topic.loudKey),
      settings.get<string>(topic.quietKey),
    ])
    const plan = planWake({ day, hour, window, loudDay: loudDay ?? null, quietDay: quietDay ?? null })
    if (plan === 'already') return 'already'

    const loud = plan === 'loud'
    try {
      await show(registration, { ...topic.notice, tag: topic.tag, target: topic.target }, loud)
    } catch {
      return 'failed'
    }
    await settings.set(loud ? topic.loudKey : topic.quietKey, day)
    return loud ? 'shown' : 'quiet'
  }

  /**
   * «Проверить сейчас»: всё, о чём есть напомнить, — со звуком. Не о чем —
   * уведомление `idle` приложения, иначе не понять, дошло оно или сломалось.
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
      await show(registration, rules.idle, true)
      return 'nothing'
    } catch {
      return 'failed'
    }
  }

  /** Журнал не повод ронять напоминание: не записалось — и ладно. */
  async function record(wake: Wake): Promise<void> {
    try {
      await settings.set(LOG, appendWake(await settings.get<unknown>(LOG), wake))
    } catch {
      // Уведомление уже показано, а без строки в журнале жить можно.
    }
  }

  /** «Проверить сейчас»: не ждать сутки, чтобы узнать, работает ли. */
  async function checkReminder(): Promise<RemindResult | 'denied' | 'unsupported'> {
    const reg = await registration()
    if (!reg || !notifications()) return 'unsupported'
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return 'denied'
    return remind(reg, { force: true })
  }

  async function readWindow(): Promise<ReminderWindow> {
    return parseWindow(await settings.get<unknown>(WINDOW))
  }

  async function saveWindow(window: ReminderWindow): Promise<void> {
    await settings.set(WINDOW, window)
  }

  /** Журнал пробуждений, свежие сверху. */
  async function readWakes(): Promise<Wake[]> {
    const stored = await settings.get<unknown>(LOG)
    return Array.isArray(stored) ? stored.filter(isWake) : []
  }

  return {
    remind,
    checkReminder,
    reminderStatus,
    enableReminders,
    disableReminders,
    readWindow,
    saveWindow,
    readWakes,
  }
}

/** Напоминания приложения. */
export type Reminders = ReturnType<typeof createReminders>
