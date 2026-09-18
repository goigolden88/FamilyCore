import { useEffect, useState } from 'react'
import { db } from '../core/db.ts'
import { useInstall } from '../ui/install.ts'
import {
  iosNote,
  isEmptyBase,
  OWN_STORES,
  showWelcome,
  type Counts,
  type IosNoteKind,
} from './firstRun.ts'

// Ключи в `settings`: у каждого устройства свои.

/** Приветствие закрыли «Понятно». */
const WELCOME_DONE = 'welcomeDone'
/** Строку про iPhone скрыли насовсем. */
const IOS_NOTE_HIDDEN = 'installNoteHidden'

/**
 * Скрыта ли строка про iPhone в этом открытии. Модульная переменная, а не
 * состояние компонента: переход на другую вкладку и обратно её не
 * возвращает, а новое открытие приложения — возвращает.
 */
let hiddenNow = false

export type FirstRun = {
  /** Посчитано ли, пуста ли база. */
  counted: boolean
  empty: boolean
  welcome: boolean
  dismissWelcome: () => void
  iosNote: IosNoteKind
  hideIosNote: () => void
}

async function readFlag(key: string): Promise<boolean> {
  try {
    return (await db.settings.get<boolean>(key)) === true
  } catch {
    return false
  }
}

/**
 * Пуста ли база и что из этого следует на «Сегодня». Взято из «Дневников».
 * Пересчитывается на любую запись — своей рукой или приехавшую
 * синхронизацией. Пока ничего не прочитано, не показывает ничего:
 * мигнуть приветствием у человека с данными хуже, чем опоздать на миг.
 */
export function useFirstRun(): FirstRun {
  const [counts, setCounts] = useState<Counts | null>(null)
  const [done, setDone] = useState<boolean | null>(null)
  const [hiddenForever, setHiddenForever] = useState(false)
  const [hidden, setHidden] = useState(hiddenNow)
  const { advice } = useInstall()

  useEffect(() => {
    let alive = true

    async function count() {
      try {
        const next: Counts = {}
        for (const store of OWN_STORES) next[store] = await db.count(store)
        if (alive) setCounts(next)
      } catch {
        // База не открылась — об этом скажут «Настройки». Здесь молчим.
      }
    }

    void count()
    void readFlag(WELCOME_DONE).then((value) => {
      if (alive) setDone(value)
    })
    void readFlag(IOS_NOTE_HIDDEN).then((value) => {
      if (alive) setHiddenForever(value)
    })

    const stores: readonly string[] = OWN_STORES
    const off = db.onChange((event) => {
      if (stores.includes(event.store)) void count()
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  const known = counts !== null && done !== null
  const empty = counts === null || isEmptyBase(counts)
  const welcome = known && showWelcome({ empty, done })

  return {
    counted: counts !== null,
    empty,
    welcome,
    dismissWelcome: () => {
      setDone(true)
      void db.settings.set(WELCOME_DONE, true)
    },
    iosNote: known
      ? iosNote({ iosTab: advice === 'ios', empty, welcome, hiddenNow: hidden, hiddenForever })
      : null,
    hideIosNote: () => {
      hiddenNow = true
      setHidden(true)
      if (!empty) {
        setHiddenForever(true)
        void db.settings.set(IOS_NOTE_HIDDEN, true)
      }
    },
  }
}
