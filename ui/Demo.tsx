import { useEffect, useState } from 'react'
import { family } from '../core/db.ts'
import { showDemoOffer } from '../core/demo.ts'
import { useFirstRun } from '../screens/useFirstRun.ts'
import { useCore } from './core.tsx'
import { DEMO_OFFERED, ENTER_CONFIRM, LEAVE_CONFIRM, enterDemo, leaveDemo } from './demo.ts'
import { Fold } from './Fold.tsx'

/**
 * Экраны демо (Я-44, Я-45): полоса «Демо» на каждом экране, предложение на
 * первом запуске и блок настроек. Тексты — ядра, имя приложения — из `name`.
 * У приложения без `demo` в конфиге не рисуется ничего.
 */

/** Ошибка входа или выхода — словами, а не молчанием. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Полоса «Демо: данные выдуманные · Выйти» — над каждым экраном, её ставит
 * `Layout`. Базу не читает: и при упавшей демо-базе из демо можно выйти.
 */
export function DemoBar() {
  const { config, db } = useCore()
  const [error, setError] = useState('')

  if (!db.demo) return null

  function leave() {
    if (!window.confirm(LEAVE_CONFIRM)) return
    leaveDemo(config.dbName).catch((reason: unknown) => setError(errorText(reason)))
  }

  return (
    <div className="demo-bar" role="status">
      <span>Демо: данные выдуманные</span>
      <button type="button" className="demo-bar__leave" onClick={leave}>
        Выйти
      </button>
      {error && <span className="demo-bar__error">{error}</span>}
    </div>
  )
}

/**
 * Предложение демо на первом запуске — один раз и только устройству без
 * токена «семья» (Я-45). Ставит приложение — на экран приветствия: только
 * оно знает, в каких хранилищах записи человека (`own`, как у `useFirstRun`).
 */
export function DemoOffer({ own }: { own: readonly string[] }) {
  const { config, db } = useCore()
  const { counted, empty } = useFirstRun(own)
  const [hasToken, setHasToken] = useState<boolean | null>(null)
  const [offered, setOffered] = useState<boolean | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    family
      .read()
      .then((value) => {
        if (alive) setHasToken(value.token !== null)
      })
      // Общая база не открылась — молчим: предложить демо человеку с данными хуже.
      .catch(() => {})
    db.settings
      .get<boolean>(DEMO_OFFERED)
      .then((value) => {
        if (alive) setOffered(value === true)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [db])

  const show = showDemoOffer({
    hasDemo: typeof config.demo === 'function',
    demo: db.demo === true,
    empty: counted ? empty : null,
    hasToken,
    offered,
  })
  if (!show) return null

  async function answer(open: boolean) {
    setError('')
    try {
      await db.settings.set(DEMO_OFFERED, true)
      if (open) await enterDemo(config.dbName)
      else setOffered(true)
    } catch (reason) {
      setError(errorText(reason))
    }
  }

  return (
    <section className="panel block demo-offer">
      <h2>Посмотреть на демо-данных?</h2>
      <p>
        «{config.name}» заполнится выдуманными записями — видно, как всё устроено. Ваши данные это не
        трогает: демо живёт отдельно, без синхронизации. Выйти можно в любой момент — демо сотрётся.
      </p>
      <div className="row row--wrap">
        <button type="button" className="btn btn--primary" onClick={() => void answer(true)}>
          Открыть демо
        </button>
        <button type="button" className="btn" onClick={() => void answer(false)}>
          Нет, начну своё
        </button>
      </div>
      <p className="muted">Позже — «Настройки» → «Демо-данные».</p>
      {error && <p className="error">{error}</p>}
    </section>
  )
}

/** Блок настроек «Демо-данные»: вход в любой момент, в демо — выход (Я-44); оба — с вопросом (Я-45, Я-46). */
export function DemoSettings() {
  const { config, db } = useCore()
  const [error, setError] = useState('')

  if (typeof config.demo !== 'function') return null

  function act() {
    setError('')
    if (db.demo) {
      if (!window.confirm(LEAVE_CONFIRM)) return
      leaveDemo(config.dbName).catch((reason: unknown) => setError(errorText(reason)))
    } else {
      // Вход — тоже с вопросом (Я-46): случайное нажатие не уводит в демо молча.
      if (!window.confirm(ENTER_CONFIRM)) return
      enterDemo(config.dbName).catch((reason: unknown) => setError(errorText(reason)))
    }
  }

  return (
    <Fold id="settings:demo" title="Демо-данные" summary={db.demo ? 'сейчас демо' : undefined} folded reveal={db.demo === true}>
      {db.demo ? (
        <p>Сейчас демо: записи выдуманные, синхронизации нет. Выход сотрёт всё, что записано в демо.</p>
      ) : (
        <p>
          Посмотреть «{config.name}» на выдуманных записях. Ваши данные остаются как есть, но пока открыто
          демо, они не синхронизируются. Выход стирает демо; новый вход собирает его заново.
        </p>
      )}
      <div className="row row--wrap">
        <button type="button" className="btn" onClick={act}>
          {db.demo ? 'Выйти из демо' : 'Открыть демо'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </Fold>
  )
}
