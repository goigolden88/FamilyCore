import { useEffect, useState } from 'react'
import type { KeyValue } from '../core/db.ts'
import { useCore } from '../ui/core.tsx'
import { useInstall } from '../ui/install.ts'
import {
  iosNote,
  isEmptyBase,
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

async function readFlag(settings: KeyValue, key: string): Promise<boolean> {
  try {
    return (await settings.get<boolean>(key)) === true
  } catch {
    return false
  }
}

/**
 * Пуста ли база и что из этого следует на «Сегодня». Взято из «Дневников».
 * `own` — хранилища, где лежат записи человека (`firstRun.ts`).
 * Пересчитывается на любую запись — своей рукой или приехавшую
 * синхронизацией. Пока ничего не прочитано, не показывает ничего:
 * мигнуть приветствием у человека с данными хуже, чем опоздать на миг.
 */
export function useFirstRun(own: readonly string[]): FirstRun {
  const { db } = useCore()
  // Список сравнивается по содержимому: приложение вправе собирать его
  // заново на каждой отрисовке.
  const ownKey = own.join(',')
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
        for (const store of own) next[store] = await db.count(store)
        if (alive) setCounts(next)
      } catch {
        // База не открылась — об этом скажут «Настройки». Здесь молчим.
      }
    }

    void count()
    void readFlag(db.settings, WELCOME_DONE).then((value) => {
      if (alive) setDone(value)
    })
    void readFlag(db.settings, IOS_NOTE_HIDDEN).then((value) => {
      if (alive) setHiddenForever(value)
    })

    const off = db.onChange((event) => {
      if (own.includes(event.store)) void count()
    })
    return () => {
      alive = false
      off()
    }
    // own — по ownKey: новый массив с тем же содержимым не повод перечитывать.
  }, [db, ownKey])

  const known = counts !== null && done !== null
  const empty = counts === null || isEmptyBase(counts, own)
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
