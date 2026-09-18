import { useEffect, useState } from 'react'
import { useCore } from '../ui/core.tsx'
import { latestChange, unseenChanges, type Change } from './changes.ts'

/** Последняя прочитанная запись «Что нового» (Р-65 «Делу Время»). В `settings`: у каждого устройства своя. */
const SEEN = 'seenChanges'

/**
 * Что показать в «Что нового». Ждёт, пока посчитано, пуста ли база:
 * по ней свежая установка отличается от обновившейся копии.
 *
 * `changes` — список приложения, `CHANGES` из его `src/changes.ts` (Я-06).
 */
export function useWhatsNew(
  base: { counted: boolean; empty: boolean },
  changes: readonly Change[],
): {
  show: Change[]
  dismiss: () => void
} {
  // undefined — ещё не прочитано, null — ключа нет.
  const { db } = useCore()
  const [seen, setSeen] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    db.settings
      .get<number>(SEEN)
      .then((value) => {
        if (alive) setSeen(typeof value === 'number' ? value : null)
      })
      .catch(() => {
        if (alive) setSeen(null)
      })
    return () => {
      alive = false
    }
  }, [db])

  const plan = seen === undefined || !base.counted ? null : unseenChanges(changes, seen, base.empty)
  const mark = plan?.markSeen ?? null

  // Свежая установка: всё прочитано сразу, без показа.
  useEffect(() => {
    if (mark === null) return
    setSeen(mark)
    void db.settings.set(SEEN, mark)
  }, [db, mark])

  return {
    show: plan?.show ?? [],
    dismiss: () => {
      const latest = latestChange(changes)
      setSeen(latest)
      void db.settings.set(SEEN, latest)
    },
  }
}
