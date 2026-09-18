import { describe, expect, it } from 'vitest'
import {
  addDays,
  addMonths,
  lastDayOf,
  monthEndIn,
  monthOf,
  monthPeriod,
  monthsOf,
  weeksEndingIn,
  yearPeriod,
  days,
  daysAgo,
  daysBetween,
  formatDate,
  formatDateLong,
  formatDateLoose,
  formatDateOrMonth,
  formatMonth,
  formatPeriod,
  inPeriod,
  isDateStr,
  parseDate,
  periodDays,
  plural,
  timeSpan,
  toDateStr,
  today,
  weekPeriod,
  weekStart,
} from './dates.ts'

describe('parseDate', () => {
  it('разбирает три формата, которые лежат вперемешку в дневниках Obsidian', () => {
    expect(parseDate('24.01.26')).toBe('2026-01-24')
    expect(parseDate('20-02-2026')).toBe('2026-02-20')
    expect(parseDate('03.03-2026')).toBe('2026-03-03')
  })

  it('разбирает ISO и однозначные числа', () => {
    expect(parseDate('2026-09-07')).toBe('2026-09-07')
    expect(parseDate('7.9.2026')).toBe('2026-09-07')
    expect(parseDate('  05.09.2026  ')).toBe('2026-09-05')
  })

  it('двузначный год: 00–79 в двухтысячные, 80–99 в девяностые', () => {
    expect(parseDate('01.01.26')).toBe('2026-01-01')
    expect(parseDate('01.01.79')).toBe('2079-01-01')
    expect(parseDate('01.01.80')).toBe('1980-01-01')
  })

  it('отвергает несуществующие дни, а не подставляет соседние', () => {
    expect(parseDate('31.02.2026')).toBeNull()
    expect(parseDate('01.13.2026')).toBeNull()
    expect(parseDate('00.01.2026')).toBeNull()
  })

  it('отвергает мусор', () => {
    expect(parseDate('')).toBeNull()
    expect(parseDate('вчера')).toBeNull()
    expect(parseDate('2026')).toBeNull()
  })
})

describe('часовой пояс', () => {
  // Ради этого дата нигде не строится из строки через new Date(строка):
  // такой разбор идёт как UTC и в минусовом поясе сдвигает день назад.
  it('today() совпадает с локальным календарём, а не с UTC', () => {
    const now = new Date()
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate(),
    ).padStart(2, '0')}`
    expect(today()).toBe(expected)
  })

  it('toDateStr берёт локальные компоненты даты', () => {
    // 1 января, час ночи по местному времени. В UTC это ещё 31 декабря.
    expect(toDateStr(new Date(2026, 0, 1, 1, 0, 0))).toBe('2026-01-01')
  })

  it('daysAgo(сегодня) равен нулю', () => {
    expect(daysAgo(today())).toBe(0)
  })
})

describe('арифметика дней', () => {
  it('считает разницу', () => {
    expect(daysBetween('2026-09-01', '2026-09-07')).toBe(6)
    expect(daysBetween('2026-09-07', '2026-09-01')).toBe(-6)
    expect(daysBetween('2026-09-07', '2026-09-07')).toBe(0)
  })

  it('переходит через границу месяца и года', () => {
    expect(daysBetween('2026-01-31', '2026-02-01')).toBe(1)
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1)
  })

  it('знает про високосный год', () => {
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2)
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1)
  })

  it('пережил бы перевод часов: разница в сутках, а не в 23 часах', () => {
    // Последнее воскресенье марта — там, где переход на летнее время есть.
    expect(daysBetween('2026-03-28', '2026-03-29')).toBe(1)
    expect(daysBetween('2026-10-24', '2026-10-25')).toBe(1)
  })

  it('addDays', () => {
    expect(addDays('2026-09-07', 1)).toBe('2026-09-08')
    expect(addDays('2026-09-07', -7)).toBe('2026-08-31')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29')
  })

  it('interval + addDays возвращает исходную дату', () => {
    const from = '2026-01-15'
    const to = '2026-07-04'
    expect(addDays(from, daysBetween(from, to))).toBe(to)
  })
})

describe('lastDayOf', () => {
  it('последний день месяца, февраль високосного тоже', () => {
    expect(lastDayOf('2026-02')).toBe('2026-02-28')
    expect(lastDayOf('2024-02')).toBe('2024-02-29')
    expect(lastDayOf('2026-04')).toBe('2026-04-30')
    expect(lastDayOf('2026-12')).toBe('2026-12-31')
  })
})

describe('формат', () => {
  it('formatDate', () => {
    expect(formatDate('2026-09-07')).toBe('07.09.2026')
  })

  it('formatDateLong — родительный падеж без ведущего нуля', () => {
    expect(formatDateLong('2026-09-07')).toBe('7 сентября 2026')
    expect(formatDateLong('2026-01-31')).toBe('31 января 2026')
    expect(formatDateLong('2026-05-01')).toBe('1 мая 2026')
  })

  it('isDateStr', () => {
    expect(isDateStr('2026-09-07')).toBe(true)
    expect(isDateStr('2026-02-31')).toBe(false)
    expect(isDateStr('07.09.2026')).toBe(false)
  })
})

describe('склонения', () => {
  it('единственное число', () => {
    expect(days(1)).toBe('1 день')
    expect(days(21)).toBe('21 день')
    expect(days(101)).toBe('101 день')
  })

  it('от двух до четырёх', () => {
    expect(days(2)).toBe('2 дня')
    expect(days(3)).toBe('3 дня')
    expect(days(4)).toBe('4 дня')
    expect(days(22)).toBe('22 дня')
    expect(days(103)).toBe('103 дня')
  })

  it('множественное', () => {
    expect(days(0)).toBe('0 дней')
    expect(days(5)).toBe('5 дней')
    expect(days(10)).toBe('10 дней')
    expect(days(100)).toBe('100 дней')
  })

  it('11–14 — исключение, без него выходит «11 день»', () => {
    expect(days(11)).toBe('11 дней')
    expect(days(12)).toBe('12 дней')
    expect(days(13)).toBe('13 дней')
    expect(days(14)).toBe('14 дней')
    expect(days(111)).toBe('111 дней')
    expect(days(112)).toBe('112 дней')
  })

  it('отрицательные склоняются по модулю', () => {
    expect(days(-1)).toBe('-1 день')
    expect(days(-11)).toBe('-11 дней')
  })

  it('работает не только со днями', () => {
    const forms: [string, string, string] = ['раз', 'раза', 'раз']
    expect(plural(1, forms)).toBe('раз')
    expect(plural(2, forms)).toBe('раза')
    expect(plural(5, forms)).toBe('раз')
  })
})

describe('склонение дробных', () => {
  it('дробное число всегда берёт вторую форму', () => {
    expect(plural(3.5, ['день', 'дня', 'дней'])).toBe('дня')
    expect(plural(0.5, ['день', 'дня', 'дней'])).toBe('дня')
    expect(plural(11.5, ['день', 'дня', 'дней'])).toBe('дня')
  })

  it('дробные дни пишутся через запятую', () => {
    expect(days(3.5)).toBe('3,5 дня')
    expect(days(1)).toBe('1 день')
  })
})

describe('timeSpan', () => {
  it('секунды — с числом и склонением', () => {
    expect(timeSpan(1000)).toBe('1 секунду')
    expect(timeSpan(3000)).toBe('3 секунды')
    expect(timeSpan(5000)).toBe('5 секунд')
  })

  it('одна минута — без числа: «через минуту»', () => {
    expect(timeSpan(60_000)).toBe('минуту')
  })

  it('несколько минут — с числом', () => {
    expect(timeSpan(120_000)).toBe('2 минуты')
    expect(timeSpan(300_000)).toBe('5 минут')
    expect(timeSpan(21 * 60_000)).toBe('21 минуту')
  })
})

describe('formatDateLoose', () => {
  it('обычную дату форматирует как formatDate', () => {
    expect(formatDateLoose('2026-09-07')).toBe('07.09.2026')
  })

  it('кривую строку отдаёт как есть, а не роняет экран', () => {
    // Битая дата может приехать с другого устройства или из файла,
    // поправленного руками. Строка покажется странно — это лучше,
    // чем белый экран вместо всего списка.
    expect(formatDateLoose('когда-то')).toBe('когда-то')
    expect(formatDateLoose('2026-13-45')).toBe('2026-13-45')
    expect(formatDateLoose('')).toBe('')
  })
})

describe('formatMonth и formatDateOrMonth', () => {
  it('месяц показывается месяцем, а не первым числом — Р-25', () => {
    expect(formatMonth('2026-01')).toBe('январь 2026')
    expect(formatMonth('2026-09')).toBe('сентябрь 2026')
  })

  it('дата известной точности показывается по своей точности', () => {
    expect(formatDateOrMonth('2026-01')).toBe('январь 2026')
    expect(formatDateOrMonth('2026-01-05')).toBe('05.01.2026')
  })

  it('нечитаемое отдаётся как есть — экран не должен падать из-за строки', () => {
    expect(formatDateOrMonth('когда-то весной')).toBe('когда-то весной')
    expect(formatDateOrMonth('2026-13')).toBe('2026-13')
    expect(formatMonth('2026-01-05')).toBe('2026-01-05')
    expect(formatDateOrMonth('')).toBe('')
  })
})

describe('недели и промежутки — Р-41, Р-52', () => {
  it('понедельник недели: сам понедельник, середина, воскресенье', () => {
    // 14.09.2026 — понедельник, 13.09.2026 — воскресенье.
    expect(weekStart('2026-09-14')).toBe('2026-09-14')
    expect(weekStart('2026-09-17')).toBe('2026-09-14')
    expect(weekStart('2026-09-13')).toBe('2026-09-07')
  })

  it('неделя через границу месяца и года', () => {
    expect(weekPeriod('2026-09-02')).toEqual({ from: '2026-08-31', to: '2026-09-06' })
    // 01.01.2026 — четверг.
    expect(weekPeriod('2026-01-01')).toEqual({ from: '2025-12-29', to: '2026-01-04' })
  })

  it('день в промежутке — концы включительно, кривая строка — нет', () => {
    const week = { from: '2026-09-07', to: '2026-09-13' }
    expect(inPeriod('2026-09-07', week)).toBe(true)
    expect(inPeriod('2026-09-13', week)).toBe(true)
    expect(inPeriod('2026-09-14', week)).toBe(false)
    expect(inPeriod('2026-09-1', week)).toBe(false)
    expect(inPeriod('2026-09-10x', week)).toBe(false)
  })

  it('дни промежутка по порядку, через конец месяца', () => {
    expect(periodDays({ from: '2026-02-27', to: '2026-03-02' })).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ])
    expect(periodDays({ from: '2026-09-07', to: '2026-09-07' })).toEqual(['2026-09-07'])
  })

  it('подпись промежутка не повторяет общий месяц и год', () => {
    expect(formatPeriod({ from: '2026-09-07', to: '2026-09-13' })).toBe('7–13 сентября 2026')
    expect(formatPeriod({ from: '2026-08-31', to: '2026-09-06' })).toBe('31 августа – 6 сентября 2026')
    expect(formatPeriod({ from: '2025-12-29', to: '2026-01-04' })).toBe('29 декабря 2025 – 4 января 2026')
    expect(formatPeriod({ from: '2026-09-07', to: '2026-09-07' })).toBe('7 сентября 2026')
  })
})

describe('месяцы и годы — Р-54, Р-55, Р-57', () => {
  it('месяц дня; кривая строка кидает', () => {
    expect(monthOf('2026-09-14')).toBe('2026-09')
    expect(monthOf('2026-12-31')).toBe('2026-12')
    expect(() => monthOf('2026-02-30')).toThrow()
  })

  it('промежуток месяца: февраль обычный и високосный, декабрь', () => {
    expect(monthPeriod('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(monthPeriod('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(monthPeriod('2026-12')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
    expect(() => monthPeriod('2026-13')).toThrow()
  })

  it('сдвиг на месяцы через границу года в обе стороны', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-12', 1)).toBe('2027-01')
    expect(addMonths('2026-09', 0)).toBe('2026-09')
    expect(addMonths('2026-09', 13)).toBe('2027-10')
    expect(addMonths('2026-03', -14)).toBe('2025-01')
  })

  it('месяцы года и год целиком', () => {
    const months = monthsOf(2026)
    expect(months).toHaveLength(12)
    expect(months[0]).toBe('2026-01')
    expect(months[11]).toBe('2026-12')
    expect(yearPeriod(2026)).toEqual({ from: '2026-01-01', to: '2026-12-31' })
  })

  it('недели месяца — по воскресенью: сентябрь с вторника, июнь с понедельника, май до воскресенья', () => {
    // 01.09.2026 — вторник: первая неделя кончается 6-го и вся — сентябрьская.
    const september = weeksEndingIn(monthPeriod('2026-09'))
    expect(september.map((week) => week.to)).toEqual(['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'])
    expect(september[0]).toEqual({ from: '2026-08-31', to: '2026-09-06' })
    // 01.06.2026 — понедельник; 29–30 июня — неделя июля.
    expect(weeksEndingIn(monthPeriod('2026-06')).map((week) => week.from)).toEqual([
      '2026-06-01',
      '2026-06-08',
      '2026-06-15',
      '2026-06-22',
    ])
    // 31.05.2026 — воскресенье: пять недель.
    expect(weeksEndingIn(monthPeriod('2026-05'))).toHaveLength(5)
  })

  it('каждая неделя года — ровно в одном месяце', () => {
    const byMonths = monthsOf(2026).flatMap((month) => weeksEndingIn(monthPeriod(month)))
    const year = weeksEndingIn(yearPeriod(2026))
    expect(byMonths).toEqual(year)
    // 04.01.2026 — первое воскресенье года, 27.12.2026 — последнее.
    expect(year).toHaveLength(52)
    expect(year[0]?.to).toBe('2026-01-04')
    expect(year.at(-1)?.to).toBe('2026-12-27')
  })

  it('неделя, закрывающая месяц: конец внутри, на воскресенье, через год; нет конца — null', () => {
    expect(monthEndIn({ from: '2026-09-28', to: '2026-10-04' })).toBe('2026-09')
    expect(monthEndIn({ from: '2026-05-25', to: '2026-05-31' })).toBe('2026-05')
    expect(monthEndIn({ from: '2026-12-28', to: '2027-01-03' })).toBe('2026-12')
    expect(monthEndIn({ from: '2026-09-07', to: '2026-09-13' })).toBeNull()
    // 31 мая — накануне понедельника 1 июня: неделя 1–7 июня май не закрывает.
    expect(monthEndIn({ from: '2026-06-01', to: '2026-06-07' })).toBeNull()
  })
})
