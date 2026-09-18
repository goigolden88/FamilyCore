import { useEffect, useState } from 'react'

/** С какого расстояния до края страницы кнопка имеет смысл. */
const MARGIN = 240

/** Сколько кнопки видны после прокрутки. Дальше прячутся, чтобы не закрывать текст (Р-73). */
const AWAKE_MS = 2500

/**
 * Кнопки «в начало» и «в конец» (Р-55).
 *
 * Экраны длинные — циклы по категориям, лента за год, — а то, что нужно
 * редко, стоит внизу. Кнопка появляется, только когда до края страницы
 * есть куда ехать: на коротком экране их нет вовсе.
 *
 * Видны, пока экран листают, и ещё пару секунд после (Р-73): висящие
 * постоянно, они закрывали числа у правого края — суммы, оценки.
 *
 * Высота страницы меняется без прокрутки — развернули блок, приехали
 * записи с другого устройства, — поэтому следим и за размером страницы,
 * а не только за прокруткой.
 */
export function ScrollButtons() {
  const [room, setRoom] = useState({ up: false, down: false })
  const [awake, setAwake] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    function update() {
      const below = document.documentElement.scrollHeight - window.innerHeight - window.scrollY
      setRoom({ up: window.scrollY > MARGIN, down: below > MARGIN })
    }

    function scrolled() {
      update()
      setAwake(true)
      clearTimeout(timer)
      timer = setTimeout(() => setAwake(false), AWAKE_MS)
    }

    update()
    window.addEventListener('scroll', scrolled, { passive: true })
    window.addEventListener('resize', update)
    const observer = new ResizeObserver(update)
    observer.observe(document.body)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('scroll', scrolled)
      window.removeEventListener('resize', update)
      observer.disconnect()
    }
  }, [])

  if (!room.up && !room.down) return null

  return (
    <div className={awake ? 'scroll-btns no-print' : 'scroll-btns scroll-btns--idle no-print'}>
      {room.up && (
        <button
          type="button"
          className="scroll-btn"
          aria-label="В начало"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          ↑
        </button>
      )}
      {room.down && (
        <button
          type="button"
          className="scroll-btn"
          aria-label="В конец"
          onClick={() =>
            window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
          }
        >
          ↓
        </button>
      )}
    </div>
  )
}
