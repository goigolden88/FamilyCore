/**
 * Первый запуск: пуста ли база и что показать новому человеку.
 *
 * Чистые функции: правила здесь неочевидные — что считать пустой базой,
 * когда возвращать скрытое, — и проверяются тестами, а не глазами.
 * Взято из «Дневников»; своё здесь — только список хранилищ.
 */

import type { SyncedStore } from '../core/model.ts'

/**
 * Где лежат записи человека. Справочники не в счёт: категории заводятся
 * сами при первом запуске (Этап 1), пресеты и шаблоны дня — только вслед
 * за записями.
 */
export const OWN_STORES = ['notes', 'time', 'reviews'] as const satisfies readonly SyncedStore[]

export type Counts = Partial<Record<SyncedStore, number>>

/** Нет ни одной живой записи человека. */
export function isEmptyBase(counts: Counts): boolean {
  return OWN_STORES.every((store) => (counts[store] ?? 0) === 0)
}

/**
 * Показывать ли приветствие: база пуста и его не закрывали.
 *
 * Первая запись убирает его само собой — своя или приехавшая синхронизацией
 * со второго устройства. «Понятно» — насовсем, даже если база пуста.
 */
export function showWelcome(state: { empty: boolean; done: boolean }): boolean {
  return state.empty && !state.done
}

/** Какую строку про iPhone показать на «Сегодня». Null — никакую. */
export type IosNoteKind = 'before' | 'after' | null

/**
 * Строка про установку на iPhone во вкладке Safari.
 *
 * Пока база пуста — «ставь до первых записей». Скрытая, она возвращается
 * при следующем открытии: закрыть её могли случайно, а ошибка дорогая —
 * записи во вкладке, которых не будет в установленном приложении.
 *
 * Записи уже есть — совет другой, «перенеси копией», и скрывают его
 * насовсем: человек видел оба и выбрал вкладку.
 *
 * Пока на экране приветствие, строки нет: там это сказано тоже.
 */
export function iosNote(state: {
  /** iPhone во вкладке, не установлено. */
  iosTab: boolean
  empty: boolean
  welcome: boolean
  /** Скрыта в этом открытии. */
  hiddenNow: boolean
  /** Скрыта насовсем — когда записи уже были. */
  hiddenForever: boolean
}): IosNoteKind {
  if (!state.iosTab || state.welcome || state.hiddenNow) return null
  if (state.empty) return 'before'
  return state.hiddenForever ? null : 'after'
}
