/**
 * Что свёрнуто на экране (Р-55, Р-61).
 *
 * Помнится на устройстве, в `settings`, а не синхронизируется: свернуть
 * «Дачу» на телефоне не значит свернуть её на компьютере, как и дата
 * последней выгрузки у каждого устройства своя.
 *
 * Состояние общее на все блоки и живёт здесь один раз: иначе каждый блок
 * читал бы и переписывал ключ сам, и два быстрых тапа по соседним
 * заголовкам затёрли бы друг друга.
 *
 * Запись идёт по одному блоку поверх того, что лежит в базе, а не всей
 * картой из памяти. Приложение бывает открыто в двух окнах сразу —
 * установленное и вкладкой, — и карта из памяти одного окна стёрла бы то,
 * что свернули в другом. По той же причине при возврате в приложение карта
 * перечитывается.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { db } from '../core/db.ts'

const KEY = 'folds'

type Folds = Record<string, boolean>

/** id блока → свёрнут ли. Нет ключа — умолчание блока. Null — ещё не прочитано. */
let folds: Folds | null = null
let loading: Promise<void> | null = null
/** Перечитать, дописать и записать — по очереди, без перекрытий. */
let queue: Promise<void> = Promise.resolve()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): Folds | null {
  return folds
}

/** Не прочиталось — все блоки в умолчании. Сворачивание не повод показывать ошибку. */
async function read(): Promise<Folds> {
  try {
    return (await db.settings.get<Folds>(KEY)) ?? {}
  } catch {
    return {}
  }
}

function load(): Promise<void> {
  loading ??= read().then((stored) => {
    // Тап, случившийся до конца чтения, главнее прочитанного.
    folds = { ...stored, ...(folds ?? {}) }
    notify()
  })
  return loading
}

function save(id: string, value: boolean): void {
  queue = queue
    .then(async () => {
      const stored = await read()
      await db.settings.set(KEY, { ...stored, [id]: value })
    })
    .catch(() => undefined)
}

function reread(): void {
  queue = queue
    .then(async () => {
      folds = await read()
      notify()
    })
    .catch(() => undefined)
}

// Читается сразу при запуске, а не при первом блоке: экран тогда рисуется
// уже с известным состоянием.
if (typeof document !== 'undefined') {
  void load()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reread()
  })
}

export type FoldState = {
  folded: boolean
  /** Прочитано ли, что свёрнуто. До этого содержимое блока не рисуется. */
  known: boolean
  toggle: () => void
  set: (folded: boolean) => void
}

export function useFold(id: string, byDefault: boolean): FoldState {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot)

  useEffect(() => {
    void load()
  }, [])

  const folded = current?.[id] ?? byDefault

  function set(value: boolean): void {
    if (current !== null && folded === value) return
    folds = { ...(folds ?? {}), [id]: value }
    notify()
    save(id, value)
  }

  return { folded, known: current !== null, toggle: () => set(!folded), set }
}
