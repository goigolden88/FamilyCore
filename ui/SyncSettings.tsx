/**
 * Настройка и состояние синхронизации.
 *
 * Репозиторий и токен — поля на экране, а не константы в коде: иначе
 * приложением невозможно поделиться (Р-15 «Дневников»). Посторонний, ничего здесь не
 * заполнив, получает прежнюю работу — данные в браузере и никакой сети.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { days, daysBetween, formatDate, isDateStr, timeSpan, today } from '../core/dates.ts'
import { checkAccess, expiryDay, RETRY_MS } from '../core/sync.ts'
import type { SyncConfig, SyncStatus } from '../core/sync.ts'
import { useCore } from './core.tsx'
import { Fold } from './Fold.tsx'
import { useSyncStatus } from './useSync.ts'

/** За сколько дней до конца жизни токена начинать предупреждать. Есть в справке. */
export const WARN_DAYS = 30

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка'
}

/**
 * Итог у свёрнутого раздела (Р-61 «Дневников»). Беда видна и без разворачивания:
 * ошибка прохода и токен, который вот-вот истечёт, — красным.
 */
function summaryOf(status: SyncStatus, config: SyncConfig | null): ReactNode {
  const alarm = tokenAlarm(config)
  if (alarm) return <span className="error">{alarm}</span>
  if (status.state === 'off') return 'выключена'
  if (status.state === 'error') return <span className="error">ошибка</span>
  if (status.state === 'syncing') return 'идёт обмен'
  if (status.deferred) return `отложено на ${timeSpan(RETRY_MS)}`
  if (status.pending > 0) return `ждут отправки ${status.pending}`
  if (!status.lastAt) return 'обмена не было'
  return new Date(status.lastAt).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Токен истёк или истекает в пределах предупреждения. Null — всё в порядке. */
function tokenAlarm(config: SyncConfig | null): string | null {
  if (!config?.enabled || config.token === '') return null
  const day = expiryDay(config.tokenExpires)
  if (day === null) return null
  const left = daysBetween(today(), day)
  if (left < 0) return 'токен истёк'
  return left <= WARN_DAYS ? `токен истекает через ${days(left)}` : null
}

export function SyncSettings({ onChanged }: { onChanged: () => Promise<void> }) {
  const { readConfig, saveConfig, syncNow, getStatus } = useCore().sync
  const status = useSyncStatus()
  const [config, setConfig] = useState<SyncConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    void readConfig().then(setConfig)
  }, [])

  /**
   * Очередь записей настроек.
   *
   * Настройка сохраняется по ходу набора, а кнопку жмут сразу после вставки
   * токена — иногда тем же движением пальца. Без очереди обработчик кнопки
   * успевает прочитать настройки раньше, чем запись доехала до базы, и
   * синхронизация видит «токена нет». Проверено на телефоне: ровно так
   * первый запуск и провалился.
   */
  const writes = useRef<Promise<void>>(Promise.resolve())

  const patch = useCallback((change: Partial<SyncConfig>): Promise<void> => {
    writes.current = writes.current
      .then(() => saveConfig(change))
      .then(() => readConfig())
      .then((saved) => {
        setConfig(saved)
      })
    return writes.current
  }, [])

  /** Настройки, какими они лежат в базе после всех начатых записей. */
  const settled = useCallback(async () => {
    await writes.current
    return readConfig()
  }, [])

  if (!config) {
    return (
      <Fold id="settings:sync" title="Синхронизация" summary={summaryOf(status, config)} folded>
        <p className="muted">Читаю настройки…</p>
      </Fold>
    )
  }

  async function check() {
    setBusy(true)
    setNote('')
    setError('')
    try {
      const fresh = await settled()
      const access = await checkAccess(fresh)
      if (access.tokenExpiry) await patch({ tokenExpires: access.tokenExpiry })

      const parts = [
        `Репозиторий ${access.fullName} найден`,
        access.private ? 'приватный' : 'ПУБЛИЧНЫЙ — данные увидят все',
        access.canWrite ? 'запись разрешена' : 'запись ЗАПРЕЩЕНА',
      ]
      if (access.defaultBranch !== fresh.branch) {
        parts.push(`ветка по умолчанию — ${access.defaultBranch}`)
      }
      setNote(`${parts.join(', ')}.`)
      if (!access.canWrite) {
        setError(
          'Токену не хватает права «Contents: Read and write». ' +
            'Перевыпусти его с этим правом, иначе отправлять будет нечем.',
        )
      }
    } catch (failure) {
      setError(describe(failure))
    } finally {
      setBusy(false)
    }
  }

  async function run() {
    setBusy(true)
    setNote('')
    setError('')
    try {
      const fresh = await settled()
      const result = await syncNow()
      await onChanged()
      // Пустой ответ означает три разные вещи, и путать их нельзя: проход
      // упал, синхронизация выключена, настройки не заполнены. Текст ошибки
      // уже показан строкой состояния, дублировать его здесь незачем.
      if (result === null) {
        if (getStatus().state === 'error' || getStatus().deferred) setNote('')
        else if (!fresh.enabled) setNote('Синхронизация выключена')
        else setNote('Не заполнены репозиторий или токен')
      } else if (result.pulled === 0 && result.pushed === 0) setNote('Всё и так совпадает')
      else {
        const parts = []
        if (result.pulled > 0) parts.push(`получено записей ${result.pulled}`)
        if (result.pushed > 0) parts.push(`отправлено файлов ${result.pushed}`)
        setNote(parts.join(', '))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Fold id="settings:sync" title="Синхронизация" summary={summaryOf(status, config)} folded>
      <StatusLine />

      <label className="check">
        <input
          type="checkbox"
          checked={config.enabled}
          onChange={(event) => void patch({ enabled: event.target.checked })}
        />
        <span>Синхронизировать через приватный репозиторий</span>
      </label>

      {config.enabled && (
        <div className="form">
          <label className="field">
            Репозиторий данных
            <input
              type="text"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="владелец/репозиторий"
              defaultValue={config.repo}
              onChange={(event) => void patch({ repo: event.target.value })}
            />
          </label>

          <label className="field">
            Ветка
            <input
              type="text"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="main"
              defaultValue={config.branch}
              onChange={(event) => void patch({ branch: event.target.value })}
            />
          </label>

          <TokenField config={config} onSave={(token) => patch({ token })} />

          <div className="row">
            <button type="button" className="btn" onClick={() => void check()} disabled={busy}>
              Проверить доступ
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void run()}
              disabled={busy || status.state === 'syncing'}
            >
              Синхронизировать
            </button>
          </div>
        </div>
      )}

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}

      {config.enabled && <TokenExpiry config={config} onSave={(day) => patch({ tokenExpires: day })} />}

      <p className="muted">
        {config.enabled
          ? 'Токен хранится только в этом браузере и в выгрузку данных не попадает. ' +
            'Репозиторий должен быть приватным: в нём лежит всё, что записано в приложении.'
          : 'Пока выключено, данные живут только в этом браузере и никуда не уходят.'}
      </p>
    </Fold>
  )
}

/** Строка состояния. Видна и когда синхронизация выключена — там она молчит. */
function StatusLine() {
  const status = useSyncStatus()

  if (status.state === 'off') return null

  if (status.state === 'error') {
    return (
      <p className="error">
        {status.error}
        {status.pending > 0 && ` Ждут отправки: ${status.pending}.`}
      </p>
    )
  }

  if (status.state === 'syncing') return <p className="muted">Синхронизирую…</p>

  // Проигранная гонка (Р-62 «Дневников»): записи в очереди, делать ничего не надо.
  if (status.deferred) {
    return (
      <p className="muted">
        Другое устройство или окно отправляло в то же время. Повторю через {timeSpan(RETRY_MS)}
        {status.pending > 0 ? ` — ждут отправки ${status.pending}` : ''}.
      </p>
    )
  }

  const when = status.lastAt ? new Date(status.lastAt).toLocaleString('ru-RU') : null

  return (
    <p className="muted">
      {status.pending > 0 ? `Ждут отправки: ${status.pending}. ` : 'Всё отправлено. '}
      {when ? `Последний обмен: ${when}` : 'Обмена ещё не было'}
    </p>
  )
}

/**
 * Токен вводится один раз и дальше не показывается.
 *
 * Показывать его нечем помочь: проверить глазами длинную строку всё равно
 * нельзя, а на чужом экране она лишняя. Заменить — вставить новый.
 */
function TokenField({
  config,
  onSave,
}: {
  config: SyncConfig
  onSave: (token: string) => Promise<void>
}) {
  const { forgetToken } = useCore().sync
  const [editing, setEditing] = useState(config.token === '')
  const [value, setValue] = useState('')

  if (!editing) {
    return (
      <div className="field">
        Токен доступа
        <div className="row">
          <span className="muted">Сохранён в этом браузере</span>
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Заменить
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => void forgetToken().then(() => setEditing(true))}
          >
            Забыть
          </button>
        </div>
      </div>
    )
  }

  return (
    <label className="field">
      Токен доступа
      <input
        type="password"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="github_pat_…"
        value={value}
        onChange={(event) => {
          setValue(event.target.value)
          // Сохраняем сразу, а не по потере фокуса: кнопку жмут тем же
          // движением, каким вставляют токен, и фокус уйти не успевает.
          if (event.target.value) void onSave(event.target.value)
        }}
        onBlur={() => {
          if (!value) return
          setValue('')
          setEditing(false)
        }}
      />
    </label>
  )
}

/**
 * Срок жизни токена.
 *
 * Срок fine-grained токена выбирается при выпуске — до года или бессрочно
 * (Р-67 «Дневников»). Когда он выйдет, синхронизация просто перестанет работать,
 * и без этой строки причина будет неочевидна: приложение
 * ведь ничего не меняло. Дата берётся из заголовка ответа GitHub, а если
 * браузеру не разрешили его читать — вписывается руками один раз.
 */
function TokenExpiry({
  config,
  onSave,
}: {
  config: SyncConfig
  onSave: (day: string) => Promise<void>
}) {
  const day = expiryDay(config.tokenExpires)

  if (config.token === '') return null

  if (day === null) {
    return (
      <label className="field">
        Когда истекает токен — GitHub показал дату при выдаче
        <input
          type="date"
          onChange={(event) => {
            if (isDateStr(event.target.value)) void onSave(event.target.value)
          }}
        />
      </label>
    )
  }

  const left = daysBetween(today(), day)

  if (left < 0) {
    return (
      <p className="error">
        Токен истёк {formatDate(day)}. Перевыпусти его в GitHub и вставь новый —
        до этого синхронизация работать не будет.
      </p>
    )
  }

  return (
    <p className={left <= WARN_DAYS ? 'error' : 'muted'}>
      Токен действует до {formatDate(day)}
      {left <= WARN_DAYS && ` — осталось дней ${left}, пора перевыпускать`}.
    </p>
  )
}
