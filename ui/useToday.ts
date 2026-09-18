import { useEffect, useState } from 'react'
import { today, type DateStr } from '../core/dates.ts'
import { msUntilMidnight } from './today.ts'

/**
 * Сегодняшний день, который сам сменяется в полночь.
 *
 * Установленное приложение неделями не перезапускается: вкладка уходит
 * в фон и возвращается. Без этого «сегодня» застыло бы на дне открытия,
 * и блок времени, поставленный утром, лёг бы во вчера.
 *
 * Два пути, потому что ни один не надёжен сам: таймер к полуночи —
 * для открытого экрана, возврат из фона — для телефона, где таймеры
 * спящей вкладки браузер замораживает. Взято из «Дневников», там это
 * было в каждом хуке модуля; здесь — один общий.
 */
export function useToday(): DateStr {
  const [day, setDay] = useState(today)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    function refresh() {
      setDay(today())
      clearTimeout(timer)
      timer = setTimeout(refresh, msUntilMidnight(new Date()))
    }

    function onVisible() {
      if (document.visibilityState === 'visible') refresh()
    }

    timer = setTimeout(refresh, msUntilMidnight(new Date()))
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return day
}
