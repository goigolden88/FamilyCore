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
 */

import type { AppConfig, Base, Migration } from '../core/model.ts'

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

export type ShelfStores = {
  shelves: Shelf
  books: Book
  sessions: Session
  quotes: Quote
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
    stores: ['shelves', 'books', 'sessions', 'quotes'],
    v1Stores: ['shelves', 'books', 'sessions', 'quotes'],
    indexes: {
      shelves: [],
      books: ['addedOn', 'finishedOn'],
      sessions: ['date'],
      quotes: ['bookId'],
    },
    places: {
      shelves: { split: 'none', path: 'shelves.json' },
      // Месяц — по дню добавления: книга, дочитанная в июне, остаётся мартовской.
      books: { split: 'month', dir: 'books', dateOf: (book) => book.addedOn },
      sessions: { split: 'month', dir: 'sessions', dateOf: (session) => session.date },
      quotes: { split: 'none', path: 'quotes.json' },
    },
    storeNotes: {
      shelves: 'полки',
      books: 'книги — по месяцу, когда добавлены',
      sessions: 'сеансы чтения — по месяцу, когда читали',
      quotes: 'цитаты',
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
