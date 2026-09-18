import { describe, expect, it } from 'vitest'
import { columnLayout, columnPath, MAX_COLUMN, niceStep } from './bars.ts'

describe('шаг делений — круглый', () => {
  it('1, 2 или 5 на степень десяти, в единицах', () => {
    // 700 минут на три деления — по 5 ч.
    expect(niceStep(700, 3, 60)).toBe(300)
    expect(niceStep(12000, 4, 60)).toBe(3000)
    expect(niceStep(5000, 4)).toBe(2000)
  })

  it('не меньше одной единицы; пусто — одна единица', () => {
    expect(niceStep(30, 3, 60)).toBe(60)
    expect(niceStep(0, 3, 60)).toBe(60)
  })
})

describe('раскладка столбцов', () => {
  const box = { width: 360, height: 200, top: 20, bottom: 20, left: 0, right: 0 }

  it('высота — от основания по шкале делений; null и ноль — без столбца', () => {
    const layout = columnLayout([60, 120, null, 0], box, { ticks: 2, unit: 60 })
    expect(layout.baseline).toBe(180)
    expect(layout.ticks).toEqual([
      { value: 0, y: 180 },
      { value: 60, y: 100 },
      { value: 120, y: 20 },
    ])
    expect(layout.columns.map((column) => [column.top, column.height])).toEqual([
      [100, 80],
      [20, 160],
      [180, 0],
      [180, 0],
    ])
  })

  it('столбец не толще предела и не во весь слот; слот — цель тапа', () => {
    const wide = columnLayout([1, 2, 3, 4], box).columns[0]
    expect(wide).toMatchObject({ width: MAX_COLUMN, x: 33, slotX: 0, slotWidth: 90 })
    const narrow = columnLayout(Array.from({ length: 12 }, () => 1), { ...box, width: 120 }).columns[0]
    expect(narrow?.width).toBeCloseTo(6)
  })

  it('маленькое значение рядом с большим видно хотя бы полоской', () => {
    const [small] = columnLayout([1, 100000], box).columns
    expect(small?.height).toBeGreaterThanOrEqual(1)
  })
})

describe('контур столбца', () => {
  it('скруглённый верх, прямое основание', () => {
    expect(columnPath({ x: 0, width: 10, top: 10, height: 20 })).toBe('M0,30V14Q0,10 4,10H6Q10,10 10,14V30Z')
  })

  it('низкий столбец — скругление не выше самого столбца; пустой — ничего', () => {
    expect(columnPath({ x: 0, width: 10, top: 28, height: 2 })).toBe('M0,30V30Q0,28 2,28H8Q10,28 10,30V30Z')
    expect(columnPath({ x: 0, width: 10, top: 30, height: 0 })).toBe('')
  })
})
