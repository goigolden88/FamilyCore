/**
 * Вход в демо и выход из него (Я-44, Я-45): признак в `localStorage`,
 * стирание демо-базы и перезагрузка страницы — `db` и `sync` приложения
 * собираются уже под новый режим.
 *
 * Без React: правила проверяются тестом, экраны — `Demo.tsx`.
 */

import { deleteBase } from '../core/db.ts'
import { demoDbName, pageStorage, setDemoFlag, type FlagStorage } from '../core/demo.ts'

/**
 * Ключ в `settings` настоящей базы: предложение демо уже показано и на него
 * ответили (Я-45). Не выбор базы — асинхронное чтение здесь годится.
 */
export const DEMO_OFFERED = 'demoOffered'

/** Что вход и выход трогают снаружи. Тесты подставляют своё. */
export type DemoDeps = {
  storage?: FlagStorage | null
  reload?: () => void
}

function reloadPage(): void {
  window.location.reload()
}

/**
 * Войти в демо. Прежняя демо-база стирается: повторный вход собирает демо
 * заново, от сегодняшнего дня (Я-44).
 */
export async function enterDemo(dbName: string, deps: DemoDeps = {}): Promise<void> {
  const storage = deps.storage === undefined ? pageStorage() : deps.storage
  await deleteBase(demoDbName(dbName))
  setDemoFlag(dbName, true, storage)
  ;(deps.reload ?? reloadPage)()
}

/**
 * Выйти из демо: снять признак и стереть демо-базу. Сначала признак — не
 * сотрётся база (другая вкладка держит), приложение всё равно откроется
 * в настоящей, а хвост сотрёт следующий вход. Подтверждение — на экране.
 */
export async function leaveDemo(dbName: string, deps: DemoDeps = {}): Promise<void> {
  const storage = deps.storage === undefined ? pageStorage() : deps.storage
  setDemoFlag(dbName, false, storage)
  try {
    await deleteBase(demoDbName(dbName))
  } finally {
    ;(deps.reload ?? reloadPage)()
  }
}

/** Вопрос перед выходом (Я-45): вход открыт и на устройстве с настоящими данными. */
export const LEAVE_CONFIRM = 'Выйти из демо? Всё, что записано в демо, сотрётся.'

/**
 * Вопрос перед входом из настроек (Я-46): там демо открывают и на устройстве
 * с настоящими данными — случайное нажатие не должно увести в демо молча.
 * Предложение на первом запуске само и есть вопрос, ему он не нужен.
 */
export const ENTER_CONFIRM =
  'Открыть демо? Ваши записи останутся как есть и вернутся при выходе. Пока открыто демо, ' +
  'синхронизация на паузе; всё, что запишете в демо, сотрётся при выходе.'
