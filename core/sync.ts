/**
 * Синхронизация через приватный репозиторий данных.
 *
 * Принцип — local-first: запись уже лежит в базе и уже на экране, когда
 * синхронизация только начинается. Она может отставать, падать и ждать сети,
 * не ломая работу. Сеть в критическом пути записи не стоит нигде (Р-05 «Дневников»).
 *
 * Один проход:
 *
 *   1. Голова ветки и дерево файлов — два запроса
 *   2. Скачиваем только те наши файлы, чей отпечаток разошёлся с запомненным
 *   3. Вливаем их в базу по правилу Р-07 «Дневников»: по `id` побеждает поздний `updatedAt`
 *   4. Пересобираем дерево из базы целиком (Р-33 «Дневников»)
 *   5. Отправляем одним коммитом только разошедшиеся файлы (Р-32 «Дневников»)
 *   6. Ветка ушла вперёд — перечитываем и сливаемся заново: три попытки
 *      с паузой, потом повтор через минуту (Р-62 «Дневников»)
 *
 * Тихий проход, когда ничего не менялось, — два запроса и ни одного коммита.
 *
 * Порядок «сначала влить чужое, потом отправить своё» обязателен: дерево
 * собирается из базы целиком, и отправка до слияния затёрла бы на сервере всё,
 * чего у нас ещё нет. Поэтому любая ошибка чтения обрывает проход до записи.
 *
 * Ядро про приложение не знает (Р-47 «Трапезы»): раскладка, версия схемы
 * и имя в сообщениях коммитов приходят конфигом, база — аргументом.
 */

import { isDateStr, nowIso } from './dates.ts'
import type { DateStr } from './dates.ts'
import type { Db, DirtyRef, StoreData } from './db.ts'
import { GitHubError, blobSha, createClient, parseRepo } from './github.ts'
import type { Client, RepoInfo } from './github.ts'
import { META_PATH, README_PATH, createLayout, parseFile } from './layout.ts'
import type { RepoFile } from './layout.ts'
import type { AppConfig, StoreMap, StoreOf } from './model.ts'

// ─── Настройки ─────────────────────────────────────────────────────────────

/**
 * Ключи в хранилище `settings`. Не синхронизируются никогда: здесь токен,
 * и «когда я в последний раз синхронизировался» у каждого устройства своё.
 */
const KEYS = {
  enabled: 'syncEnabled',
  repo: 'syncRepo',
  token: 'syncToken',
  branch: 'syncBranch',
  /** Когда истекает токен. Из заголовка ответа GitHub либо вписано руками. */
  tokenExpires: 'syncTokenExpires',
  lastAt: 'syncLastAt',
  lastCommit: 'syncLastCommit',
  /** Отпечатки файлов на момент последнего успешного прохода: путь → sha. */
  tree: 'syncTree',
} as const

const DEFAULT_BRANCH = 'main'

export type SyncConfig = {
  enabled: boolean
  /** `владелец/репозиторий`. Пусто — синхронизация не настроена. */
  repo: string
  token: string
  branch: string
  tokenExpires: string | null
}

/**
 * День, когда истекает токен.
 *
 * GitHub присылает `2027-09-09 12:00:00 +0300`, руками вписывается
 * `2027-09-09` — общее у них первые десять символов. Часовой пояс отброшен
 * намеренно: предупреждение выводится за месяц, и час здесь ничего не решает.
 *
 * null — срок неизвестен. Это не «бессрочный»: показывать надо разное.
 */
export function expiryDay(value: string | null): DateStr | null {
  if (!value) return null
  const day = value.slice(0, 10)
  return isDateStr(day) ? day : null
}

function configured(config: SyncConfig): boolean {
  return config.enabled && config.repo !== '' && config.token !== ''
}

// ─── Проверка доступа ──────────────────────────────────────────────────────

export type AccessCheck = RepoInfo & {
  /** Срок жизни токена, как его назвал GitHub. null — заголовок не пришёл. */
  tokenExpiry: string | null
}

/**
 * Кнопка «Проверить доступ» в настройках.
 *
 * Отвечает на три вопроса сразу: репозиторий найден, токен его видит, писать
 * разрешено. Читающий токен иначе вскрылся бы только при первой отправке —
 * то есть через несколько минут после настройки, уже без связи с причиной.
 */
export async function checkAccess(config: SyncConfig): Promise<AccessCheck> {
  const api = client(config)
  const info = await api.info()
  return { ...info, tokenExpiry: api.tokenExpiry() }
}

function client(config: SyncConfig, fetchImpl?: typeof globalThis.fetch): Client {
  const { owner, name } = parseRepo(config.repo)
  return createClient({
    repo: { owner, name, branch: config.branch || DEFAULT_BRANCH },
    token: config.token,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
}

// ─── Планирование прохода ──────────────────────────────────────────────────

export type ShaByPath = Record<string, string>

/** Что отправлять: файлы, чей отпечаток разошёлся с деревом на сервере. */
export async function planUpload(
  files: readonly RepoFile[],
  tree: ShaByPath,
): Promise<{ files: RepoFile[]; shas: ShaByPath }> {
  const changed: RepoFile[] = []
  const shas: ShaByPath = {}

  for (const file of files) {
    const sha = await blobSha(file.content)
    shas[file.path] = sha
    if (tree[file.path] !== sha) changed.push(file)
  }

  return { files: changed, shas }
}

// ─── Проход ────────────────────────────────────────────────────────────────

export type SyncResult = {
  /** Записей влито с сервера. */
  pulled: number
  /** Файлов отправлено. Ноль — коммита не было. */
  pushed: number
  commit: string | null
}

/**
 * Порт к хранилищу. Заведён ради тестов: IndexedDB в node нет, а проверять
 * проход целиком надо — это самый опасный код в приложении.
 */
export type Ports<R extends StoreMap = StoreMap> = {
  readAll: () => Promise<StoreData<R>>
  merge: (store: StoreOf<R>, records: readonly { id: string; updatedAt: string }[]) => Promise<number>
  listDirty: () => Promise<DirtyRef<R>[]>
  clearDirty: (refs: readonly DirtyRef<R>[]) => Promise<void>
  remembered: () => Promise<ShaByPath>
  remember: (shas: ShaByPath, commit: string | null) => Promise<void>
}

/** Сколько раз перечитываем и сливаемся заново, проиграв гонку (Р-62 «Дневников»). */
const ATTEMPTS = 3

/**
 * Пауза перед повтором: секунда, потом две (Р-62 «Дневников»). Сразу повторять
 * бесполезно: соседняя отправка ещё не закончилась, голова ветки у GitHub
 * обновляется не мгновенно, и повтор строится на том же устаревшем
 * родителе. Две попытки без паузы так и проигрывали обе за доли секунды.
 */
function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, attempt * 1000))
}

// ─── Состояние для экрана ──────────────────────────────────────────────────

export type SyncState = 'off' | 'idle' | 'syncing' | 'error'

export type SyncStatus = {
  state: SyncState
  /** Сколько записей ждёт отправки. */
  pending: number
  lastAt: string | null
  /** Пусто, когда всё в порядке. */
  error: string
  /** Ошибка именно в токене: он не принят или истёк. */
  badToken: boolean
  /** Проход проиграл гонку до конца и сам повторится через минуту (Р-62 «Дневников»). */
  deferred: boolean
}

/** Через сколько повторить проход, проигравший гонку до конца (Р-62 «Дневников»). Есть в справке. */
export const RETRY_MS = 60_000

// ─── Когда запускать ───────────────────────────────────────────────────────

/** Сколько ждать тишины после последней правки, прежде чем отправлять. Есть в справке. */
export const QUIET_MS = 5000

/**
 * Реже этого автоматический проход не запускается. Вкладка уходит в фон и
 * возвращается по десять раз за минуту, и каждый возврат — не повод лезть в сеть.
 * Правка пользователя этим порогом не ограничена: она идёт по тишине выше.
 */
const MIN_GAP_MS = 60_000

// ─── Синхронизация приложения ──────────────────────────────────────────────

/**
 * Синхронизация приложения поверх его базы. Зовётся один раз — из
 * `src/app/core.ts`: состояние прохода и таймеры живут в экземпляре.
 */
export function createSync<R extends StoreMap>(config: AppConfig<R>, db: Db<R>) {
  type S_ = StoreOf<R>
  const layout = createLayout(config)

  async function readConfig(): Promise<SyncConfig> {
    const [enabled, repo, token, branch, tokenExpires] = await Promise.all([
      db.settings.get<boolean>(KEYS.enabled),
      db.settings.get<string>(KEYS.repo),
      db.settings.get<string>(KEYS.token),
      db.settings.get<string>(KEYS.branch),
      db.settings.get<string>(KEYS.tokenExpires),
    ])

    return {
      // Выключено по умолчанию: посторонний, открывший приложение, получает
      // данные в браузере и никакой сети (01-Проект, «Распространение»).
      enabled: enabled === true,
      repo: repo ?? '',
      token: token ?? '',
      branch: branch || DEFAULT_BRANCH,
      tokenExpires: tokenExpires ?? null,
    }
  }

  async function saveConfig(patch: Partial<SyncConfig>): Promise<void> {
    const entries: [string, unknown][] = []
    if (patch.enabled !== undefined) entries.push([KEYS.enabled, patch.enabled])
    if (patch.repo !== undefined) entries.push([KEYS.repo, patch.repo.trim()])
    if (patch.token !== undefined) entries.push([KEYS.token, patch.token.trim()])
    if (patch.branch !== undefined) entries.push([KEYS.branch, patch.branch.trim() || DEFAULT_BRANCH])
    if (patch.tokenExpires !== undefined) entries.push([KEYS.tokenExpires, patch.tokenExpires])

    for (const [key, value] of entries) await db.settings.set(key, value)
  }

  /** Забыть токен. Отдельно от выключения: выключить можно, не стирая доступ. */
  async function forgetToken(): Promise<void> {
    await db.settings.remove(KEYS.token)
    await db.settings.remove(KEYS.tokenExpires)
  }

  /**
   * Что скачивать.
   *
   * Наш файл, чей отпечаток совпал с запомненным с прошлого раза, уже влит
   * в базу — читать его незачем. Чужие файлы в репозитории (README и прочее,
   * положенное руками) не наши и не трогаются вовсе.
   *
   * `merged` — все наши пути на сервере: и скачанные сейчас, и совпавшие.
   * Именно они, и только они, могут быть перезаписаны пустыми, если месяц
   * опустел (см. `buildFiles`).
   */
  function planDownload(tree: ShaByPath, remembered: ShaByPath): { download: string[]; merged: string[] } {
    const download: string[] = []
    const merged: string[] = []

    for (const [path, sha] of Object.entries(tree)) {
      if (path !== META_PATH && layout.storeOf(path) === null) continue
      if (path !== META_PATH) merged.push(path)
      if (remembered[path] !== sha) download.push(path)
    }

    return { download: download.sort(), merged: merged.sort() }
  }

  async function runSync(
    api: Client,
    ports: Ports<R>,
    options: { pause?: (attempt: number) => Promise<void> } = {},
  ): Promise<SyncResult> {
    const pause = options.pause ?? backoff
    // Снято до начала: правки, сделанные во время прохода, останутся грязными
    // и уедут следующим. Терять их нельзя — это худший вид потери данных.
    const dirtyAtStart = await ports.listDirty()

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await onePass(api, ports, dirtyAtStart)
      } catch (error) {
        const race = error instanceof GitHubError && error.conflict
        if (!race || attempt >= ATTEMPTS) throw error
        // Второе устройство отправило раньше. Читаем заново — его записи
        // войдут в слияние, и наши поверх них.
        await pause(attempt)
      }
    }
  }

  async function onePass(
    api: Client,
    ports: Ports<R>,
    dirtyAtStart: readonly DirtyRef<R>[],
  ): Promise<SyncResult> {
    // Пустой репозиторий Git Data API не обслуживает: ему нужен хотя бы один
    // коммит. Кладём первый файл другим путём — дальше всё обычно.
    const head = (await api.head()) ?? (await bootstrap(api))
    const entries = await api.tree(head)

    const tree: ShaByPath = {}
    for (const entry of entries) tree[entry.path] = entry.sha

    const remembered = await ports.remembered()
    const { download, merged } = planDownload(tree, remembered)

    // ── Чужое к себе ──
    // Версия схемы проверяется первой: файл более новой версии читать нельзя,
    // а испортить базу попыткой — можно.
    if (download.includes(META_PATH)) {
      const version = layout.parseMeta(await api.blob(tree[META_PATH] as string))
      checkRemoteVersion(version)
    }

    let pulled = 0
    for (const path of download) {
      if (path === META_PATH) continue
      const store = layout.storeOf(path)
      if (store === null) continue
      const records = parseFile(path, await api.blob(tree[path] as string))
      pulled += await ports.merge(store, records)
    }

    // ── Своё наружу ──
    const files = layout.buildFiles(await ports.readAll(), { merged })
    // README — только если его нет: есть — он человека (Р-69 «Делу Время»).
    if (tree[README_PATH] === undefined) files.push(layout.readmeFile())
    const upload = await planUpload(files, tree)

    if (upload.files.length === 0) {
      // Отправлять нечего: на сервере уже лежит ровно то же самое. Пометки
      // снимаются — их содержимое доехало, пусть и не этим проходом.
      await ports.remember({ ...tree, ...upload.shas }, head)
      await ports.clearDirty(dirtyAtStart)
      return { pulled, pushed: 0, commit: head }
    }

    const commit = await api.commit({
      parent: head,
      files: upload.files,
      message: message(upload.files),
    })
    await api.moveBranch(commit, { create: false })

    await ports.remember({ ...tree, ...upload.shas }, commit)
    await ports.clearDirty(dirtyAtStart)

    return { pulled, pushed: upload.files.length, commit }
  }

  /**
   * Заводит репозиторий, в котором ещё ничего нет.
   *
   * Кладётся `meta.json` — версия схемы. Она всё равно нужна, и содержательного
   * файла на эту роль лучше нет: пустышка осталась бы мусором навсегда. README
   * приезжает следующим, обычным коммитом того же прохода.
   */
  async function bootstrap(api: Client): Promise<string> {
    try {
      return await api.createFirst(layout.metaFile(), `${config.name}: заведение репозитория данных`)
    } catch (error) {
      const text = error instanceof Error ? error.message : 'Неизвестная ошибка'
      throw new Error(
        `Не вышло положить первый файл в пустой репозиторий: ${text}. ` +
          'Обходной путь — создать в нём любой файл через сайт GitHub, ' +
          'например README, и синхронизировать снова.',
      )
    }
  }

  /**
   * Совместимость схем.
   *
   * Репозиторий новее — не трогаем его вовсе: мы не знаем формы этих записей,
   * а отправка перезаписала бы файлы целиком. Репозиторий старее — те же
   * правила, что у файла-слепка (Р-24 «Дневников»): добавление модуля не мешает, изменение
   * формы записей мешает.
   */
  function checkRemoteVersion(version: number): void {
    if (version > config.schemaVersion) {
      throw new Error(
        `В репозитории данные схемы ${version}, здесь ${config.schemaVersion}. ` +
          'Обнови приложение на этом устройстве, иначе синхронизация затрёт то, ' +
          'чего не понимает.',
      )
    }
    db.checkSnapshotVersion(version)
  }

  function message(files: readonly RepoFile[]): string {
    const paths = files.map((file) => file.path).sort()
    const head = `${config.name}: ${paths.length === 1 ? paths[0] : `обновлено файлов ${paths.length}`}`
    return paths.length === 1 ? head : `${head}\n\n${paths.join('\n')}`
  }

  // ─── Порты поверх настоящей базы ─────────────────────────────────────────

  function realPorts(): Ports<R> {
    return {
      async readAll() {
        const data = {} as StoreData<R>
        for (const store of config.stores) {
          // Надгробия обязаны уехать: без них второе устройство воскресит
          // удалённое (Р-07 «Дневников»).
          Object.assign(data, { [store]: await db.getAll(store, { includeDeleted: true }) })
        }
        return data
      },

      // Тип записи здесь не проверить: файл пришёл с сервера, и всё, что о нём
      // известно, — `id` и `updatedAt`, на которых держится слияние. Тот же
      // уровень доверия, что у файла-слепка.
      merge: (store: S_, records) => db.merge(store, records as never, 'remote'),

      listDirty: () => db.listDirty(),
      clearDirty: (refs) => db.clearDirty(refs),

      remembered: async () => (await db.settings.get<ShaByPath>(KEYS.tree)) ?? {},

      async remember(shas, commit) {
        await db.settings.set(KEYS.tree, shas)
        await db.settings.set(KEYS.lastAt, nowIso())
        if (commit) await db.settings.set(KEYS.lastCommit, commit)
      },
    }
  }

  // ─── Состояние для экрана ────────────────────────────────────────────────

  let status: SyncStatus = {
    state: 'off',
    pending: 0,
    lastAt: null,
    error: '',
    badToken: false,
    deferred: false,
  }
  const listeners = new Set<(value: SyncStatus) => void>()

  function publish(patch: Partial<SyncStatus>): void {
    status = { ...status, ...patch }
    for (const listener of listeners) listener(status)
  }

  function getStatus(): SyncStatus {
    return status
  }

  function subscribe(listener: (value: SyncStatus) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  /** Пересчитывает видимое состояние, ничего не отправляя. */
  async function refreshStatus(): Promise<SyncStatus> {
    const current = await readConfig()
    const pending = (await db.listDirty()).length
    const lastAt = (await db.settings.get<string>(KEYS.lastAt)) ?? null

    if (!configured(current)) publish({ state: 'off', pending, lastAt, error: '', badToken: false })
    else if (status.state !== 'syncing') {
      publish({ state: status.error ? 'error' : 'idle', pending, lastAt })
    } else publish({ pending, lastAt })

    return status
  }

  /** Идущий проход. Второй вызов подхватывает первый, а не запускает второй. */
  let running: Promise<SyncResult | null> | null = null

  /**
   * Синхронизировать сейчас. null — синхронизация не настроена или выключена,
   * это не ошибка.
   *
   * Ошибки не пробрасываются, а оседают в состоянии: проход запускается сам
   * по таймеру и по возврату сети, и некому их ловить. Экран показывает
   * последнюю.
   */
  async function syncNow(): Promise<SyncResult | null> {
    if (running) return running

    running = (async () => {
      const current = await readConfig()
      if (!configured(current)) {
        await refreshStatus()
        // Отпустить проход и здесь: `finally` ниже эту ветку не накрывает.
        // Без этой строки первый вызов при выключенной синхронизации — а он
        // случается на старте — занимал `running` навсегда, и включённая
        // потом синхронизация отвечала «не заполнены» до перезапуска
        // приложения. Поймал прогон «Делу Время»; в «Дневниках» так же.
        running = null
        return null
      }

      publish({ state: 'syncing', error: '', badToken: false })
      try {
        const api = client(current)
        const result = await runSync(api, realPorts())

        // Срок жизни токена приезжает заголовком ответа. Не приехал — значит
        // браузеру его читать не разрешили; тогда дата остаётся той, что
        // вписана руками в настройках.
        const expiry = api.tokenExpiry()
        if (expiry) await saveConfig({ tokenExpires: expiry })

        publish({ state: 'idle', error: '', badToken: false, deferred: false })
        await refreshStatus()
        return result
      } catch (error) {
        // Проигранная до конца гонка — не поломка: очередь цела, соседняя
        // отправка только что прошла. Архитектура обещает «откладываем», а не
        // красную точку (Р-62 «Дневников»). Второй раз подряд — уже повод показать:
        // вечные молчаливые повторы спрятали бы настоящую поломку.
        const race = error instanceof GitHubError && error.conflict
        if (race && !status.deferred) {
          publish({ state: 'idle', error: '', badToken: false, deferred: true })
          await refreshStatus()
          later(RETRY_MS)
          return null
        }

        const text = error instanceof Error ? error.message : 'Неизвестная ошибка'
        publish({
          state: 'error',
          error: text,
          badToken: error instanceof GitHubError && error.badToken,
          deferred: false,
        })
        await refreshStatus()
        return null
      } finally {
        running = null
      }
    })()

    return running
  }

  // ─── Когда запускать ─────────────────────────────────────────────────────

  let timer: ReturnType<typeof setTimeout> | null = null
  let lastAuto = 0

  function later(delay: number): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      lastAuto = Date.now()
      void syncNow()
    }, delay)
  }

  /**
   * Подписывает синхронизацию на всё, после чего она может понадобиться:
   * правка в базе, возврат сети, возврат вкладки из фона, запуск приложения.
   *
   * Вызывается один раз на старте. Возвращает функцию отписки — она нужна
   * тестам и горячей перезагрузке, в жизни подписка живёт столько же, сколько
   * приложение.
   */
  function startAutoSync(): () => void {
    const unsubscribe = db.onChange((event) => {
      // Пришедшее с сервера отправлять обратно незачем — оно там и есть.
      if (event.origin === 'remote') return
      later(QUIET_MS)
    })

    function wake(): void {
      if (Date.now() - lastAuto < MIN_GAP_MS) return
      later(0)
    }

    function onVisible(): void {
      if (document.visibilityState === 'visible') wake()
    }

    window.addEventListener('online', wake)
    document.addEventListener('visibilitychange', onVisible)

    // Старт приложения: на другом устройстве могло накопиться за ночь.
    later(0)

    return () => {
      unsubscribe()
      window.removeEventListener('online', wake)
      document.removeEventListener('visibilitychange', onVisible)
      if (timer) clearTimeout(timer)
      timer = null
    }
  }

  return {
    readConfig,
    saveConfig,
    forgetToken,
    checkAccess,
    planDownload,
    runSync,
    getStatus,
    subscribe,
    refreshStatus,
    syncNow,
    startAutoSync,
  }
}

/**
 * Синхронизация — то, чем пользуется общий интерфейс (Я-03). Без таблицы
 * хранилищ: ни одна из этих функций от неё не зависит, и синхронизация любого
 * приложения сюда подходит.
 */
export type Sync = Pick<
  ReturnType<typeof createSync<StoreMap>>,
  'readConfig' | 'saveConfig' | 'forgetToken' | 'checkAccess' | 'getStatus' | 'subscribe' | 'refreshStatus' | 'syncNow'
>
