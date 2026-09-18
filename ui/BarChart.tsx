import { useEffect, useRef, useState } from 'react'
import { columnLayout, columnPath, type ColumnBox } from './bars.ts'

/**
 * График столбцами — свой SVG, без библиотек (Р-57 «Делу Время»). Про данные ничего не
 * знает: столбцы, подписи и адреса ему дают готовыми.
 *
 * Один ряд — один цвет, легенды нет: что на графике, говорит заголовок.
 * Подписано только наибольшее значение; остальные — деления оси, подсказка
 * и таблица рядом. Тап — по всему слоту, а не по столбцу.
 */

export type BarItem = {
  value: number | null
  /** Подпись под столбцом: «янв». */
  label: string
  /** Подсказка и текст для чтения с экрана: что и сколько, с основанием. */
  title: string
  href?: string
  /** Подпись серым: столбца нет — месяц не наступил или без учёта. */
  muted?: boolean
}

/** Поля под подписи: сверху — значение наибольшего, слева — деления, снизу — подписи. */
const MARGIN = { top: 18, bottom: 22, left: 40, right: 4 }

/** Ширина контейнера: SVG рисуется в пикселях, чтобы шрифт не рос с экраном. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/** Индекс наибольшего положительного значения; нет такого — −1. */
function peakOf(items: readonly BarItem[]): number {
  let peak = -1
  items.forEach((item, index) => {
    if (item.value !== null && item.value > 0 && (peak < 0 || item.value > (items[peak]?.value ?? 0))) peak = index
  })
  return peak
}

export function BarChart({
  items,
  label,
  tickText,
  peakText,
  height = 180,
  ticks = 3,
  unit = 1,
}: {
  items: readonly BarItem[]
  /** Что на графике — для чтения с экрана. */
  label: string
  tickText: (value: number) => string
  peakText: (value: number) => string
  height?: number
  ticks?: number
  /** Единица делений: шаг кратен ей. */
  unit?: number
}) {
  const { ref, width } = useWidth()
  const box: ColumnBox = { width, height, ...MARGIN }
  const layout = width > 0 ? columnLayout(items.map((item) => item.value), box, { ticks, unit }) : null
  const peak = peakOf(items)

  return (
    <div ref={ref} className="chart">
      {layout && (
        <svg className="chart__svg" width={width} height={height} role="img" aria-label={label}>
          {layout.ticks.map((tick) => (
            <g key={tick.value} className="chart__grid">
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={tick.y} y2={tick.y} />
              <text x={MARGIN.left - 6} y={tick.y} textAnchor="end" dominantBaseline="middle">
                {tickText(tick.value)}
              </text>
            </g>
          ))}
          {layout.columns.map((column) => {
            const item = items[column.index]
            if (!item) return null
            const center = column.x + column.width / 2
            // Крайнее значение не вылезает за край: прижимается к столбцу.
            const edge = column.index === 0 ? 'start' : column.index === items.length - 1 ? 'end' : 'middle'
            const peakX = edge === 'start' ? column.x : edge === 'end' ? column.x + column.width : center
            const body = (
              <>
                <rect
                  className="chart__hit"
                  x={column.slotX}
                  y={MARGIN.top}
                  width={column.slotWidth}
                  height={height - MARGIN.top}
                />
                {column.height > 0 && <path className="chart__bar" d={columnPath(column)} />}
                <text
                  className={item.muted ? 'chart__label chart__label--muted' : 'chart__label'}
                  x={center}
                  y={height - 6}
                  textAnchor="middle"
                >
                  {item.label}
                </text>
                {column.index === peak && item.value !== null && (
                  <text className="chart__value" x={peakX} y={column.top - 5} textAnchor={edge}>
                    {peakText(item.value)}
                  </text>
                )}
                <title>{item.title}</title>
              </>
            )
            return item.href ? (
              <a key={column.index} className="chart__col" href={item.href}>
                {body}
              </a>
            ) : (
              <g key={column.index} className="chart__col">
                {body}
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

/**
 * Малые столбики в строке таблицы: форма ряда своей шкалой, без осей.
 * Величина названа числом рядом; значения — в подсказке.
 */
export function MiniBars({
  values,
  titles,
  width = 96,
  height = 24,
}: {
  values: readonly number[]
  titles: readonly string[]
  width?: number
  height?: number
}) {
  const layout = columnLayout(values, { width, height, top: 2, bottom: 1, left: 0, right: 0 })
  return (
    <svg className="minibars" width={width} height={height}>
      <line className="minibars__base" x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} />
      {layout.columns.map((column) =>
        column.height > 0 ? (
          <path key={column.index} className="chart__bar" d={columnPath(column, 2)}>
            <title>{titles[column.index] ?? ''}</title>
          </path>
        ) : null,
      )}
    </svg>
  )
}
