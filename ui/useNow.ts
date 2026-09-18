import { useEffect, useState } from 'react'

/**
 * Текущее время, которое обновляется раз в `everyMs` — для идущих часов.
 * `enabled: false` — не тикать: незачем перерисовывать экран, где часов нет.
 */
export function useNow(everyMs: number, enabled = true): Date {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    if (!enabled) return
    setNow(new Date())
    const id = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(id)
  }, [everyMs, enabled])

  return now
}
