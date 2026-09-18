import { useEffect, useState } from 'react'
import { SCHEMA_VERSION } from '../core/model.ts'
import { useInstall } from './install.ts'
import { clearErrors, issueUrl, ISSUE_TITLE, readErrors, reportText, type AppError } from './report.ts'
import { useSyncStatus } from './useSync.ts'

/**
 * «Сообщить об ошибке» (Р-66 «Делу Время»). Стоит в «Настройки» → «О приложении».
 *
 * Отчёт показывается целиком до отправки: человек видит, что уходит,
 * и дописывает, что случилось. Сам ничего никуда не отправляет.
 */
export function ReportBug() {
  const { advice } = useInstall()
  const sync = useSyncStatus()
  const [errors, setErrors] = useState<AppError[] | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    void readErrors().then(setErrors)
  }, [])

  if (errors === null) return <p className="muted">Читаю журнал ошибок…</p>

  const text = reportText({
    built: __BUILD_TIME__,
    schema: SCHEMA_VERSION,
    userAgent: navigator.userAgent,
    installed: advice === 'installed',
    viewport: { width: window.innerWidth, height: window.innerHeight, ratio: window.devicePixelRatio },
    sync: sync.state,
    errors,
  })
  const url = issueUrl(window.location, ISSUE_TITLE, text)
  const sharable = typeof navigator.share === 'function'

  async function share() {
    setNote('')
    try {
      await navigator.share({ title: ISSUE_TITLE, text })
    } catch (failure) {
      // Закрытое меню «Поделиться» — не ошибка.
      if (failure instanceof DOMException && failure.name === 'AbortError') return
      setNote('Поделиться не вышло — скопируй отчёт')
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setNote('Отчёт скопирован')
    } catch {
      setNote('Скопировать не вышло — выдели текст отчёта руками')
    }
  }

  async function clear() {
    await clearErrors()
    setErrors([])
    setNote('Журнал ошибок очищен')
  }

  return (
    <>
      <p className="muted">
        Отчёт — только техника: версия, устройство и ошибки, которые приложение успело записать.
        Записей в нём нет. Допиши сверху, что случилось, и отправь.
        {url && ' На GitHub отчёт увидят все.'}
      </p>

      <div className="row row--wrap">
        {url && (
          <a className="btn btn--primary" href={url} target="_blank" rel="noopener noreferrer">
            Открыть на GitHub
          </a>
        )}
        {sharable && (
          <button type="button" className="btn" onClick={() => void share()}>
            Поделиться
          </button>
        )}
        <button type="button" className="btn" onClick={() => void copy()}>
          Скопировать
        </button>
      </div>

      {note && <p className="muted">{note}</p>}

      <pre className="report">{text}</pre>

      {errors.length > 0 && (
        <button type="button" className="btn" onClick={() => void clear()}>
          Очистить журнал ошибок
        </button>
      )}
    </>
  )
}
