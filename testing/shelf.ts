/**
 * Подставное приложение «Полка» — для тестов ядра (План, Этап 1, п. 8).
 *
 * Выдуманное, не «Трапеза» и не «Делу Время»: тесты ядра обязаны проходить
 * без единого настоящего приложения рядом (Р-47 «Трапезы»), а хранилища
 * настоящего приложения в тестах ядра — ровно та связь, которую вынос
 * разрывает.
 *
 * Формы хранилищ повторяют то, что встречается в семье:
 *
 * | «Полка»    | Раскладка                 | Как у                               |
 * |------------|---------------------------|-------------------------------------|
 * | `shelves`  | одним файлом, без индексов | справочник: категории, блюда        |
 * | `books`    | по месяцам, дата бывает null | заметки «Делу Время»: без даты — undated |
 * | `sessions` | по месяцам, дата обязательна | блоки времени, записи еды           |
 * | `quotes`   | одним файлом, с индексом   | обзоры недели «Делу Время»          |
 * | `reviews`  | по годам, дата — день, месяц или null | контент «Дневников» (Я-09) |
 */

import { inPeriod } from '../core/dates.ts'
import type { AppConfig, Base, Migration } from '../core/model.ts'
import { summaryPeriods, type SummaryBody } from '../core/summary.ts'

/** Полка: «Читаю», «Прочитано». Справочник. */
export type Shelf = Base & {
  name: string
  order: number
}

/** Книга. Дата добавления может быть неизвестна — тогда файл `undated`. */
export type Book = Base & {
  title: string
  shelfId?: string
  /** YYYY-MM-DD или YYYY-MM; null — неизвестно */
  addedOn: string | null
  finishedOn?: string | null
}

/** Сеанс чтения: день, книга, минуты. */
export type Session = Base & {
  /** YYYY-MM-DD */
  date: string
  bookId: string
  minutes: number
  note?: string
}

/** Цитата из книги. */
export type Quote = Base & {
  bookId: string
  text: string
}

/**
 * Отзыв о книге. Пишутся редко — лежат по годам (Я-09). Когда написан,
 * бывает известно только до месяца; бывает неизвестно вовсе.
 */
export type Review = Base & {
  bookId: string
  /** YYYY-MM-DD или YYYY-MM; null — неизвестно */
  writtenOn: string | null
  text: string
}

export type ShelfStores = {
  shelves: Shelf
  books: Book
  sessions: Session
  quotes: Quote
  reviews: Review
}

/** Конфиг «Полки» с заданными миграциями — для проверок версий схемы. */
export function shelfConfig(
  over: Partial<AppConfig<ShelfStores>> & { migrations?: readonly Migration[] } = {},
): AppConfig<ShelfStores> {
  return {
    name: 'Полка',
    dbName: 'polka',
    schemaVersion: 1,
    migrations: [],
    stores: ['shelves', 'books', 'sessions', 'quotes', 'reviews'],
    v1Stores: ['shelves', 'books', 'sessions', 'quotes', 'reviews'],
    indexes: {
      shelves: [],
      books: ['addedOn', 'finishedOn'],
      sessions: ['date'],
      quotes: ['bookId'],
      reviews: [],
    },
    places: {
      shelves: { split: 'none', path: 'shelves.json' },
      // Месяц — по дню добавления: книга, дочитанная в июне, остаётся мартовской.
      books: { split: 'month', dir: 'books', dateOf: (book) => book.addedOn },
      sessions: { split: 'month', dir: 'sessions', dateOf: (session) => session.date },
      quotes: { split: 'none', path: 'quotes.json' },
      reviews: { split: 'year', dir: 'reviews', dateOf: (review) => review.writtenOn },
    },
    storeNotes: {
      shelves: 'полки',
      books: 'книги — по месяцу, когда добавлены',
      sessions: 'сеансы чтения — по месяцу, когда читали',
      quotes: 'цитаты',
      reviews: 'отзывы — по году, когда написаны',
    },
    importFormat: 'polka-import',
    promptRules: [
      'Ничего не выдумывай: чего нет в моих данных — не пиши.',
      'Даты — ГГГГ-ММ-ДД.',
      'Время чтения — в минутах: «1,5 ч» → 90.',
    ],
    about: {
      data: 'учёт книг и чтения',
      privacy: 'внутри то, что и когда вы читали',
      sources: 'списки книг, таблицы чтения или скриншоты из других сервисов',
    },
    ...over,
  }
}

export const shelf = shelfConfig()

/**
 * Срез итогов «Полки» (Я-16, Я-17) — образец функции среза: минуты чтения
 * по отрезкам с основанием и одна тема «требует внимания» — книги без даты.
 * Идущий отрезок неокончателен: число верно по день расчёта.
 */
export function shelfSummary(data: { sessions: Session[]; books: Book[] }, day: string): SummaryBody {
  return {
    periods: summaryPeriods(day).map((period) => {
      const sessions = data.sessions.filter((session) => inPeriod(session.date, period))
      const minutes = sessions.reduce((sum, session) => sum + session.minutes, 0)
      return {
        ...period,
        through: period.to >= day ? day : null,
        metrics:
          sessions.length === 0
            ? { unknown: 'no-data', text: 'сеансов чтения нет' }
            : [{ key: 'reading', label: 'Чтение', value: { n: minutes, unit: 'minutes' }, basis: `по ${sessions.length} сеансам` }],
      }
    }),
    attention: [
      {
        key: 'undated-books',
        label: 'Книги без даты',
        count: data.books.filter((book) => book.addedOn === null).length,
        day,
        link: '/books',
      },
    ],
  }
}
