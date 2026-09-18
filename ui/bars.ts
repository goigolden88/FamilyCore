/**
 * Геометрия графика столбцами (Р-57): чистые числа, без React и без данных
 * модулей — `ui` про модули не знает. SVG рисует `BarChart.tsx`.
 *
 * Столбец не толще `MAX_COLUMN` и не занимает весь слот: остаток — воздух.
 * Скруглён сверху, прямой у основания; растёт от одной линии.
 */

/** Столбец не толще — даже когда слот широкий. */
export const MAX_COLUMN = 24
/** Какую долю слота столбец занимает, если слот узкий. */
export const COLUMN_SHARE = 0.6
/** Скругление верха столбца. */
export const COLUMN_RADIUS = 4
/** Ненулевое значение видно всегда, хотя бы полоской. */
const MIN_VISIBLE = 1

/** Поле графика: размеры и отступы под подписи. */
export type ColumnBox = { width: number; height: number; top: number; bottom: number; left: number; right: number }

export type Column = {
  index: number
  value: number | null
  x: number
  width: number
  top: number
  height: number
  /** Слот столбца — цель тапа шире самого столбца. */
  slotX: number
  slotWidth: number
}

export type Tick = { value: number; y: number }

export type ColumnLayout = { columns: Column[]; ticks: Tick[]; baseline: number }

/**
 * Круглый шаг делений в единицах `unit`: 1, 2 или 5, умноженные на степень
 * десяти, но не меньше одной единицы — «0,2 ч» на оси не бывает.
 */
export function niceStep(max: number, count: number, unit = 1): number {
  if (max <= 0 || count <= 0) return unit
  const raw = max / unit / count
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((each) => each * power).find((each) => each >= raw) ?? 10 * power
  return Math.max(1, step) * unit
}

/**
 * Раскладка столбцов по полю. `ticks` — сколько делений хотя бы; ноль —
 * без делений, шкала до наибольшего значения. `null` — столбца нет вовсе.
 */
export function columnLayout(
  values: readonly (number | null)[],
  box: ColumnBox,
  options: { ticks?: number; unit?: number } = {},
): ColumnLayout {
  const count = options.ticks ?? 0
  const max = Math.max(0, ...values.map((value) => value ?? 0))
  const step = count > 0 ? niceStep(max, count, options.unit) : 0
  const scale = count > 0 ? Math.max(step, Math.ceil(max / step) * step) : max
  const baseline = box.height - box.bottom
  const plot = baseline - box.top
  const slot = values.length > 0 ? (box.width - box.left - box.right) / values.length : 0
  const width = Math.min(MAX_COLUMN, slot * COLUMN_SHARE)

  const columns = values.map((value, index) => {
    const raw = value !== null && value > 0 && scale > 0 ? (value / scale) * plot : 0
    const height = raw > 0 ? Math.max(MIN_VISIBLE, raw) : 0
    const slotX = box.left + index * slot
    return { index, value, x: slotX + (slot - width) / 2, width, top: baseline - height, height, slotX, slotWidth: slot }
  })

  const ticks: Tick[] = []
  if (count > 0) {
    for (let value = 0; value <= scale; value += step) ticks.push({ value, y: baseline - (value / scale) * plot })
  }

  return { columns, ticks, baseline }
}

const round = (value: number) => Math.round(value * 100) / 100

/** Контур столбца: скруглённый верх, прямое основание. Пустой — пустая строка. */
export function columnPath(column: Pick<Column, 'x' | 'width' | 'top' | 'height'>, radius = COLUMN_RADIUS): string {
  if (column.height <= 0) return ''
  const r = round(Math.min(radius, column.width / 2, column.height))
  const x = round(column.x)
  const top = round(column.top)
  const right = round(column.x + column.width)
  const bottom = round(column.top + column.height)
  return (
    `M${x},${bottom}V${round(top + r)}Q${x},${top} ${round(x + r)},${top}` +
    `H${round(right - r)}Q${right},${top} ${right},${round(top + r)}V${bottom}Z`
  )
}
