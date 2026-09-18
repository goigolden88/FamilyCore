import type { Change } from '../changes.ts'
import { formatDate } from '../core/dates.ts'

/**
 * «Что нового» на главном экране после обновления (Р-65 «Делу Время»). Обновления
 * приходят сами и молча, и без этого блока человек не узнает, что
 * поменялось. Взято из «Дневников».
 */
export function WhatsNew({ changes, onDone }: { changes: readonly Change[]; onDone: () => void }) {
  return (
    <section className="panel block">
      <h2>Что нового</h2>
      <ChangeList changes={changes} />
      <div className="row row--wrap">
        <button type="button" className="btn btn--primary" onClick={onDone}>
          Понятно
        </button>
      </div>
    </section>
  )
}

/** Записи от новых к старым: свежее — первым. */
export function ChangeList({ changes }: { changes: readonly Change[] }) {
  return (
    <>
      {[...changes].reverse().map((change) => (
        <div key={change.id}>
          <p className="muted">{formatDate(change.date)}</p>
          <ul>
            {change.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}
