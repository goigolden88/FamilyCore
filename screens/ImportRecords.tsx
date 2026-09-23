import { useEffect, useRef, useState, type ReactNode } from 'react'
import { nowIso, today, type DateStr } from '../core/dates.ts'
import type { StoreData } from '../core/db.ts'
import { ulid } from '../core/id.ts'
import { countsText, planTotal, type ImportContext, type ImportPlan, type Writes } from '../core/importing.ts'
import type { StoreMap } from '../core/model.ts'
import { useCore, type SharedDb } from '../ui/core.tsx'
import { Fold } from '../ui/Fold.tsx'

/** Сколько строк отчёта показывать. Остальные — числом. */
const ISSUE_LINES = 20

/** Разбор файла приложением: его разделы, его проверки (Я-03). */
export type PlanImport<R extends StoreMap> = (text: string, data: StoreData<R>, context: ImportContext) => ImportPlan<R>

function write(db: SharedDb, store: string, writes: Writes): Promise<unknown> {
  const records = writes[store]
  return records && records.length > 0 ? db.putMany(store, records) : Promise.resolve()
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка'
}

/**
 * Импорт записей из других источников (Р-60 «Дневников»).
 *
 * Текстом или файлом. Текстом — главный путь на телефоне: ответ ИИ
 * приходит в чате, и сохранять его файлом ради загрузки неудобно.
 * Сначала сводка — `ImportSummary`, — запись только по кнопке.
 *
 * Разбор разделов и промпт — приложения, из его `registry.ts`; `intro` —
 * его слова над полем: что сюда загружают (Я-03).
 */
export function ImportRecords<R extends StoreMap>({
  planImport,
  importPrompt,
  intro,
  onChanged,
}: {
  planImport: PlanImport<R>
  importPrompt: (day: DateStr) => string
  intro: ReactNode
  onChanged: () => Promise<void>
}) {
  const { config } = useCore()
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  // Номер разбора — ключ сводки: тот же текст, разобранный заново, —
  // новая сводка по свежему слепку базы, а не прежняя.
  const [source, setSource] = useState<{ text: string; round: number } | null>(null)
  const [note, setNote] = useState('')

  function examine(value: string) {
    setNote('')
    setSource((was) => ({ text: value, round: (was?.round ?? 0) + 1 }))
  }

  async function applied(plan: ImportPlan<R>) {
    setNote(`Загружено записей: ${planTotal(plan)}`)
    setSource(null)
    setText('')
    await onChanged()
  }

  return (
    <div className="import">
      {intro}
      <p className="muted">
        Файл готовится по промпту ниже — например, с ИИ. То, что уже есть, не удваивается: повторная загрузка
        ничего не добавит дважды. До записи сводка покажет, что добавится, а если изменится что-то из уже
        имеющегося — назовёт и это.
      </p>

      <textarea
        className="import__text"
        rows={3}
        value={text}
        placeholder="Вставь сюда JSON из ответа ИИ"
        onChange={(event) => setText(event.target.value)}
      />

      <div className="row row--wrap">
        <button type="button" className="btn" disabled={!text.trim()} onClick={() => examine(text)}>
          Разобрать
        </button>
        <button type="button" className="btn" onClick={() => input.current?.click()}>
          Выбрать файл
        </button>
      </div>

      <input
        ref={input}
        type="file"
        accept="application/json,.json,.txt"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void file.text().then(examine)
          // Тот же файл должен выбираться повторно.
          event.target.value = ''
        }}
      />

      {note && <p className="muted">{note}</p>}

      {source && (
        <ImportSummary
          key={source.round}
          text={source.text}
          planImport={planImport}
          onApplied={applied}
          onCancel={() => setSource(null)}
        />
      )}

      <Prompt prompt={importPrompt(today())} sources={config.about.sources} />
    </div>
  )
}

/**
 * Сводка импорта по готовому тексту и запись по кнопке (Я-07).
 *
 * Одна на приложение: её ставит `ImportRecords`, и её же ставит приложение
 * там, где файл импорта у него появился сам — ответ публичного источника,
 * собранный скриптом перенос. Разбор — тот же `planImport`, что у экрана.
 *
 * Порядок записи — `stores` конфига: справочники раньше записей, которые
 * на них ссылаются, и прерванная посередине запись оставит категорию без
 * блоков, а не блок без категории.
 *
 * После записи сводка пропадает и отдаёт план в `onApplied`: что сказать
 * человеку о записанном, решает место, где она стоит.
 */
export function ImportSummary<R extends StoreMap>({
  text,
  planImport,
  onApplied,
  onCancel,
}: {
  text: string
  planImport: PlanImport<R>
  onApplied: (plan: ImportPlan<R>) => Promise<void> | void
  onCancel: () => void
}) {
  const { config, db } = useCore()
  const [plan, setPlan] = useState<ImportPlan<R> | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  // Разбор — по тексту, а не по каждой новой функции разбора: приложение
  // вправе передать её стрелкой прямо в разметке.
  const parse = useRef(planImport)
  parse.current = planImport

  useEffect(() => {
    let stale = false
    setPlan(null)
    setError('')
    setDone(false)
    void (async () => {
      try {
        // Слепок базы приложения — той самой, чьи хранилища знает `planImport`.
        const data = (await db.exportAll()).data as StoreData<R>
        const next = parse.current(text, data, { newId: ulid, now: nowIso() })
        if (!stale) setPlan(next)
      } catch (failure) {
        if (!stale) setError(describe(failure))
      }
    })()
    return () => {
      stale = true
    }
  }, [db, text])

  async function apply() {
    if (!plan) return
    setBusy(true)
    setError('')
    try {
      for (const store of config.stores) await write(db, store, plan.writes as Writes)
      setDone(true)
      await onApplied(plan)
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setBusy(false)
    }
  }

  // Записано; упасть могло только то, что приложение делает после записи.
  if (done) return error ? <p className="error">{error}</p> : null

  if (error && !plan) {
    return (
      <div className="form import__plan">
        <p className="error">{error}</p>
        <div className="row row--wrap">
          <button type="button" className="btn" onClick={onCancel}>
            Закрыть
          </button>
        </div>
      </div>
    )
  }

  if (!plan) return <p className="muted">Разбираю…</p>

  const total = planTotal(plan)
  const added = countsText(plan.added)
  const changed = countsText(plan.changed ?? [])
  const removed = countsText(plan.removed ?? [])
  const notes = plan.notes ?? []

  return (
    <div className="form import__plan">
      {total === 0 && <p>Добавлять нечего.</p>}
      {added && <p>Добавится: {added}.</p>}
      {changed && <p>Изменится: {changed}.</p>}
      {removed && <p>Удалится: {removed}.</p>}
      {/* Приложение не назвало, что это за записи, — число всё равно звучит. */}
      {total > 0 && !added && !changed && !removed && <p>Запишется записей: {total}.</p>}
      {plan.skipped > 0 && <p className="muted">Уже есть — пропущено, не перезаписано: {plan.skipped}.</p>}

      {notes.length > 0 && (
        <>
          <p>Загрузится, но стоит посмотреть: {notes.length}.</p>
          <Lines lines={notes.map((each) => `${each.title}: ${each.text}`)} />
        </>
      )}

      {plan.issues.length > 0 && (
        <>
          <p className="error">Не разобрано — в базу не попадёт: {plan.issues.length}.</p>
          <Lines lines={plan.issues.map((each) => `${each.title}: ${each.reason}`)} />
        </>
      )}

      {error && <p className="error">{error}</p>}

      <div className="row row--wrap">
        <button type="button" className="btn btn--primary" disabled={total === 0 || busy} onClick={() => void apply()}>
          Загрузить {total}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  )
}

/** Строки отчёта — первые `ISSUE_LINES`, остальные числом. */
function Lines({ lines }: { lines: readonly string[] }) {
  const rest = lines.length - ISSUE_LINES
  return (
    <>
      <ul className="plain">
        {lines.slice(0, ISSUE_LINES).map((line, index) => (
          <li key={index} className="muted">
            {line}
          </li>
        ))}
      </ul>
      {rest > 0 && <p className="muted">и ещё {rest}</p>}
    </>
  )
}

/**
 * Промпт — свёрнутым: он длинный, а нужен раз. Копируется кнопкой; не
 * вышло (браузер не дал доступа к буферу) — текст виден и выделяется руками.
 */
function Prompt({ prompt, sources }: { prompt: string; sources: string }) {
  const [copied, setCopied] = useState('')

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied('Промпт скопирован — вставь его в чат с ИИ и добавь свои данные.')
    } catch {
      setCopied('Скопировать не вышло — открой промпт ниже и выдели его вручную.')
    }
  }

  return (
    // Тем же сворачиванием, что блоки, а не ссылкой-треугольником (Р-73 «Дневников»).
    <Fold id="settings:import:how" title="Как подготовить файл" sub folded>
      <ol>
        <li>Скопируй промпт и вставь в чат с ИИ — ChatGPT, Claude, любой.</li>
        <li>Добавь в конце свои данные — {sources}.</li>
        <li>Ответ — JSON — вставь в поле выше и нажми «Разобрать». До записи будет видно, что добавится.</li>
      </ol>
      <button type="button" className="btn" onClick={() => void copy()}>
        Скопировать промпт
      </button>
      {copied && <p className="muted">{copied}</p>}
      <Fold id="settings:import:prompt" title="Показать промпт" sub folded>
        <pre className="prompt">{prompt}</pre>
      </Fold>
    </Fold>
  )
}
