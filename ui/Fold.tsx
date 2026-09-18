import { useEffect, type ReactNode } from 'react'
import { useFold } from './useFold.ts'

/**
 * Блок экрана, который сворачивается тапом по заголовку (Р-55, Р-61).
 *
 * Рядом с заголовком всегда стоит итог — число записей или сумма, — и
 * у свёрнутого тоже: «Гигиена · 5», «Требует внимания · 2». Свёрнутое
 * не должно пропадать молча, тот же принцип, что у фильтров (Р-46).
 *
 * Что свёрнуто, помнит устройство. Отдельного выключателя в настройках
 * нет: тап по заголовку короче, чем заход в настройки.
 *
 * `sub` — подгруппа внутри блока: «Циклы» и «Здоровье» в «Категориях
 * и названиях». Заголовок мельче, отступы короче, механика та же.
 */
export function Fold({
  id,
  title,
  summary,
  folded: byDefault = false,
  reveal = false,
  sub = false,
  children,
}: {
  /** Постоянный ключ блока: по нему устройство помнит, что свёрнуто. */
  id: string
  title: string
  summary?: ReactNode
  /** Свёрнут ли блок, пока его ни разу не трогали. */
  folded?: boolean
  /** Внутри — цель перехода: развернуть, даже если свёрнут. */
  reveal?: boolean
  /** Подгруппа внутри другого блока. */
  sub?: boolean
  children: ReactNode
}) {
  const { folded, known, toggle, set } = useFold(id, byDefault)

  // Пришли к записи, которая лежит в свёрнутом блоке (Р-56): блок
  // разворачивается и остаётся развёрнутым. Спрятанная цель перехода хуже
  // лишнего раскрытого блока.
  useEffect(() => {
    if (reveal && known && folded) set(false)
  }, [reveal, known, folded, set])

  const Head = sub ? 'h3' : 'h2'
  // Свёрнутый — строка оглавления: плотно, с линией до соседа (Р-73).
  const classes = ['block', sub ? 'fold--sub' : '', known && folded ? 'fold--folded' : '']

  return (
    <section className={classes.filter(Boolean).join(' ')}>
      <Head className="fold__head">
        <button type="button" className="fold__btn" aria-expanded={!folded} onClick={toggle}>
          {title}
        </button>
        {summary !== undefined && summary !== '' && <span className="fold__summary">· {summary}</span>}
      </Head>
      {/* Пока не прочитано, что свёрнуто, содержимого нет: иначе свёрнутый
          блок на мгновение раскрывался бы и схлопывался, и экран прыгал. */}
      {known && !folded && children}
    </section>
  )
}
