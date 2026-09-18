import { useRef, useState } from 'react'
import { db } from '../core/db.ts'
import { nowIso, plural, today } from '../core/dates.ts'
import { ulid } from '../core/id.ts'
import { planTotal, type ImportPlan, type Writes } from '../core/importing.ts'
import type { SyncedStore } from '../core/model.ts'
import { importPrompt, planImport } from '../registry.ts'
import { Fold } from '../ui/Fold.tsx'

/**
 * Справочники раньше записей, которые на них ссылаются: прерванная
 * посередине запись оставит категорию без блоков, а не блок без категории.
 */
const WRITE_ORDER: readonly SyncedStore[] = ['categories', 'presets', 'templates', 'notes', 'time', 'reviews']

/** Сколько строк отчёта показывать. Остальные — числом. */
const ISSUE_LINES = 20

function write<S extends SyncedStore>(store: S, writes: Writes): Promise<unknown> {
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
 * Сначала сводка — что добавится, что уже есть, что не разобрано, —
 * запись только по кнопке.
 */
export function ImportRecords({ onChanged }: { onChanged: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  async function examine(source: string) {
    setNote('')
    setError('')
    setPlan(null)
    try {
      const data = (await db.exportAll()).data
      setPlan(planImport(source, data, { newId: ulid, now: nowIso() }))
    } catch (failure) {
      setError(describe(failure))
    }
  }

  async function apply() {
    if (!plan) return
    setBusy(true)
    setError('')
    try {
      for (const store of WRITE_ORDER) await write(store, plan.writes)
      setNote(`Загружено записей: ${planTotal(plan)}`)
      setPlan(null)
      setText('')
      await onChanged()
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="import">
      <p className="muted">
        Записи из таблиц, заметок и других сервисов. Файл готовится по промпту ниже — например, с ИИ.
        Импорт только добавляет: то, что уже есть, не перезаписывается, и повторная загрузка
        ничего не удвоит.
      </p>

      <textarea
        className="import__text"
        rows={3}
        value={text}
        placeholder="Вставь сюда JSON из ответа ИИ"
        onChange={(event) => setText(event.target.value)}
      />

      <div className="row row--wrap">
        <button type="button" className="btn" disabled={!text.trim()} onClick={() => void examine(text)}>
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

      {error && <p className="error">{error}</p>}
      {note && <p className="muted">{note}</p>}

      {plan && <Plan plan={plan} busy={busy} onApply={() => void apply()} onCancel={() => setPlan(null)} />}

      <Prompt />
    </div>
  )
}

function Plan({
  plan,
  busy,
  onApply,
  onCancel,
}: {
  plan: ImportPlan
  busy: boolean
  onApply: () => void
  onCancel: () => void
}) {
  const total = planTotal(plan)
  const rest = plan.issues.length - ISSUE_LINES

  return (
    <div className="form import__plan">
      <p>
        {total === 0
          ? 'Добавлять нечего.'
          : `Добавится: ${plan.added
              .map((each) => `${each.count} ${plural(each.count, each.forms)}`)
              .join(', ')}.`}
      </p>
      {plan.skipped > 0 && (
        <p className="muted">Уже есть — пропущено, не перезаписано: {plan.skipped}.</p>
      )}

      {plan.issues.length > 0 && (
        <>
          <p className="error">Не разобрано — в базу не попадёт: {plan.issues.length}.</p>
          <ul className="plain">
            {plan.issues.slice(0, ISSUE_LINES).map((issue, index) => (
              <li key={index} className="muted">
                {issue.title}: {issue.reason}
              </li>
            ))}
          </ul>
          {rest > 0 && <p className="muted">и ещё {rest}</p>}
        </>
      )}

      <div className="row row--wrap">
        <button type="button" className="btn btn--primary" disabled={total === 0 || busy} onClick={onApply}>
          Загрузить {total}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  )
}

/**
 * Промпт — свёрнутым: он длинный, а нужен раз. Копируется кнопкой; не
 * вышло (браузер не дал доступа к буферу) — текст виден и выделяется руками.
 */
function Prompt() {
  const [copied, setCopied] = useState('')
  const prompt = importPrompt(today())

  async function copy() {
    try {
      await navigator.clipboard.writeText(prompt)
      setCopied('Промпт скопирован — вставь его в чат с ИИ и добавь свои записи.')
    } catch {
      setCopied('Скопировать не вышло — открой промпт ниже и выдели его вручную.')
    }
  }

  return (
    // Тем же сворачиванием, что блоки, а не ссылкой-треугольником (Р-73 «Дневников»).
    <Fold id="settings:import:how" title="Как подготовить файл" sub folded>
      <ol>
        <li>Скопируй промпт и вставь в чат с ИИ — ChatGPT, Claude, любой.</li>
        <li>Добавь в конце свои записи: текст заметок, таблицу или скриншоты.</li>
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
