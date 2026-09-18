/**
 * Тонкий клиент GitHub API.
 *
 * Знает про HTTP и формат ответов, не знает ни про раскладку файлов, ни про
 * слияние, ни про базу. Всё, что выше уровнем, живёт в `sync.ts` — так другой
 * git-хостинг остаётся правкой одного этого файла. Хранилище без git — ещё
 * и прохода в `sync.ts`: он думает деревом, отпечатками и коммитами
 * (docs/02-Архитектура.md, «Правила»; Р-75).
 *
 * Почему Git Data API, а не простой Contents API (Р-32): Contents пишет по
 * одному файлу за запрос и делает на каждый отдельный коммит. Отметка, у
 * которой сменился год, дала бы два коммита; Архитектура требует один.
 * Здесь дерево собирается целиком и коммит получается один, а столкновение
 * двух устройств ловится на сдвиге ветки, а не на версии отдельного файла.
 *
 * Секретов в этом файле нет и быть не может: токен приходит параметром из
 * настроек, введённых руками на устройстве.
 */

const API = 'https://api.github.com'

/**
 * Заголовок, в котором GitHub сообщает, когда истекает токен.
 *
 * Читается на всякий ответ. Браузер отдаёт скрипту только те заголовки,
 * которые сервер разрешил через CORS, и попадёт ли этот в список — заранее
 * неизвестно. Не отдаст — вернём null, и дату придётся вписать руками
 * в настройках. Ради этого одного знания городить ничего не стоит,
 * но взять бесплатно — стоит.
 */
const EXPIRY_HEADER = 'github-authentication-token-expiration'

/** Файл в дереве. Обычный блоб, ничего исполняемого. */
const BLOB_MODE = '100644'

export type RepoRef = {
  owner: string
  name: string
  branch: string
}

export type RepoInfo = {
  fullName: string
  private: boolean
  /** Есть ли у токена право писать. Читающий токен виден сразу, а не при первой отправке. */
  canWrite: boolean
  defaultBranch: string
}

/** Запись дерева в том виде, в каком её отдаёт GitHub. */
export type TreeEntry = {
  path: string
  /** Отпечаток содержимого. Совпал — файл не менялся, скачивать незачем. */
  sha: string
  type: 'blob' | 'tree' | 'commit'
}

/** Файл на отправку. Содержимое — обычный текст, base64 не нужен. */
export type FileToWrite = {
  path: string
  content: string
}

/**
 * Ошибка обращения к GitHub с человеческим текстом.
 *
 * Текст пишется здесь, а не на экране: только тут известно, что именно
 * ответил сервер. Экран показывает `message` как есть.
 */
export class GitHubError extends Error {
  /** HTTP-код. 0 — до сервера не дошли вовсе. */
  readonly status: number
  /** Ветка ушла вперёд: кто-то отправил раньше нас. Повод перечитать и слить заново. */
  readonly conflict: boolean
  /** Токен не принят. Самая вероятная причина — вышел срок, выбранный при выпуске. */
  readonly badToken: boolean

  constructor(
    message: string,
    options: { status?: number; conflict?: boolean; badToken?: boolean } = {},
  ) {
    super(message)
    this.name = 'GitHubError'
    this.status = options.status ?? 0
    this.conflict = options.conflict ?? false
    this.badToken = options.badToken ?? false
  }
}

// ─── Разбор адреса репозитория ─────────────────────────────────────────────

/**
 * Принимает и `owner/name`, и ссылку из адресной строки браузера —
 * в настройки удобнее вставить то, что скопировалось, а не переписывать руками.
 */
export function parseRepo(input: string): { owner: string; name: string } {
  const trimmed = input.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  if (!trimmed) throw new GitHubError('Репозиторий не указан')

  const fromUrl = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)/i)
  const pair = fromUrl ? [fromUrl[1], fromUrl[2]] : trimmed.split('/')

  const [owner, name] = pair
  if (pair.length !== 2 || !owner || !name || /[^\w.-]/.test(owner) || /[^\w.-]/.test(name)) {
    throw new GitHubError(`Не разобрал «${input}». Ожидается «владелец/репозиторий»`)
  }
  return { owner, name }
}

// ─── Кодировки ─────────────────────────────────────────────────────────────

/**
 * Base64 из ответа GitHub → текст.
 *
 * Через `TextDecoder`, а не через `atob` напрямую: `atob` отдаёт байты,
 * разложенные по символам, и кириллица в заметках превратилась бы в мусор.
 * Переводы строк внутри base64 GitHub ставит сам, их надо убрать.
 */
function decodeBase64(value: string): string {
  const binary = atob(value.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new TextDecoder().decode(bytes)
}

/** Текст → base64. Нужен Contents API: он принимает содержимое только так. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

// ─── Клиент ────────────────────────────────────────────────────────────────

export type Client = ReturnType<typeof createClient>

export type ClientOptions = {
  repo: RepoRef
  token: string
  /** Подменяется в тестах. В приложении — обычный `fetch`. */
  fetch?: typeof globalThis.fetch
}

export function createClient({ repo, token, fetch = globalThis.fetch }: ClientOptions) {
  const base = `${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`
  let tokenExpiry: string | null = null

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${base}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...init.headers,
        },
      })
    } catch {
      // Сюда попадает только обрыв связи: HTTP-ошибка приходит обычным ответом.
      throw new GitHubError('Нет связи с GitHub. Отправка отложена до сети')
    }

    const expiry = response.headers.get(EXPIRY_HEADER)
    if (expiry) tokenExpiry = expiry

    if (!response.ok) throw await explain(response)

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }

  /** Ответ сервера → ошибка с текстом, по которому понятно, что делать. */
  async function explain(response: Response): Promise<GitHubError> {
    let detail = ''
    try {
      const body = (await response.json()) as { message?: string }
      detail = typeof body.message === 'string' ? body.message : ''
    } catch {
      detail = ''
    }

    const status = response.status

    if (status === 401) {
      return new GitHubError(
        // Не «выдают на год»: срок выбирается при выпуске — до года или
        // бессрочно (Р-67). Отказ бывает и у отозванного, и у вставленного
        // не целиком.
        'Токен не принят: истёк срок, токен отозвали или вставили не целиком. ' +
          'Перевыпусти токен в GitHub и вставь новый здесь.',
        { status, badToken: true },
      )
    }
    if (status === 403) {
      const limited = response.headers.get('x-ratelimit-remaining') === '0'
      return new GitHubError(
        limited
          ? 'GitHub временно отказывает: исчерпан лимит запросов. Попробую позже'
          : 'Токену не хватает прав. Нужен доступ «Contents: Read and write» ' +
            'к этому репозиторию.',
        { status, badToken: !limited },
      )
    }
    if (status === 404) {
      return new GitHubError(
        `Репозиторий ${repo.owner}/${repo.name} не найден. ` +
          'Либо в имени опечатка, либо токен выдан не на него.',
        { status },
      )
    }
    if (status === 409 || status === 422) {
      // «Git Repository is empty» тоже приходит как 409, но это не гонка,
      // а репозиторий без единого коммита. Повторять такое бессмысленно.
      const empty = detail.toLowerCase().includes('empty')
      return new GitHubError(
        // Текст GitHub («Update is not a fast forward») человеку ничего
        // не говорит — называем то, что случилось (Р-62).
        empty
          ? 'В репозитории данных нет ни одного коммита'
          : 'Другое устройство или окно отправляло в то же время',
        { status, conflict: !empty },
      )
    }
    return new GitHubError(
      `GitHub ответил ${status}${detail ? `: ${detail}` : ''}`,
      { status },
    )
  }

  return {
    /**
     * Дата истечения токена, как её назвал GitHub. null — заголовок не пришёл
     * или запросов ещё не было.
     */
    tokenExpiry: () => tokenExpiry,

    /** Проверка доступа: репозиторий существует, токен его видит, писать разрешено. */
    async info(): Promise<RepoInfo> {
      const raw = await call<{
        full_name: string
        private: boolean
        default_branch: string
        permissions?: { push?: boolean }
      }>('')
      return {
        fullName: raw.full_name,
        private: raw.private,
        canWrite: raw.permissions?.push === true,
        defaultBranch: raw.default_branch,
      }
    },

    /**
     * Голова ветки. null — ветки нет: репозиторий только что создан и пуст.
     * Это нормальный первый запуск, а не ошибка.
     *
     * Пустой репозиторий GitHub отвечает не одинаково: 404, когда нет самой
     * ветки, и 409 «Git Repository is empty», когда нет ни одного коммита
     * вообще. Второй случай — ровно то, что видит человек, который только что
     * создал репозиторий и ничего в него не положил, то есть самый обычный
     * первый запуск. Здесь оба означают одно.
     */
    async head(): Promise<string | null> {
      try {
        const raw = await call<{ object: { sha: string } }>(
          `/git/ref/heads/${encodeURIComponent(repo.branch)}`,
        )
        return raw.object.sha
      } catch (error) {
        if (!(error instanceof GitHubError)) throw error
        if (error.status === 404 || error.status === 409) return null
        throw error
      }
    },

    /** Всё дерево коммита одним запросом. Каталоги отброшены, нужны только файлы. */
    async tree(commitSha: string): Promise<TreeEntry[]> {
      const raw = await call<{ tree: TreeEntry[]; truncated?: boolean }>(
        `/git/trees/${commitSha}?recursive=1`,
      )
      if (raw.truncated) {
        throw new GitHubError(
          'Дерево репозитория не поместилось в один ответ. ' +
            'Такого объёма данных здесь быть не должно — разберись руками.',
        )
      }
      return raw.tree.filter((entry) => entry.type === 'blob')
    },

    /** Содержимое файла по отпечатку. */
    async blob(sha: string): Promise<string> {
      const raw = await call<{ content: string; encoding: string }>(`/git/blobs/${sha}`)
      if (raw.encoding !== 'base64') {
        throw new GitHubError(`Неизвестная кодировка файла: ${raw.encoding}`)
      }
      return decodeBase64(raw.content)
    },

    /**
     * Первый файл в репозитории, где нет ни одного коммита.
     *
     * Git Data API на пустом репозитории не работает вовсе: и чтение ветки,
     * и создание дерева отвечают 409 «Git Repository is empty». Ему нужен
     * хотя бы один существующий коммит. Обходной путь — тот, который называет
     * сама документация GitHub: положить первый файл через Contents API,
     * он же создаст и коммит, и ветку.
     *
     * Дальше репозиторий обычный, и всё идёт общим путём. Цена — лишний
     * коммит один раз за жизнь репозитория.
     */
    async createFirst(file: FileToWrite, message: string): Promise<string> {
      const raw = await call<{ commit: { sha: string } }>(
        `/contents/${file.path}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            message,
            content: toBase64(file.content),
            branch: repo.branch,
          }),
        },
      )
      return raw.commit.sha
    },

    /**
     * Один коммит на все файлы (Р-32).
     *
     * Содержимое кладётся прямо в дерево — отдельно загружать блобы не нужно.
     * `base_tree` оставляет нетронутым всё, чего нет в списке: файлы прошлых
     * лет не переписываются и в коммит не попадают.
     *
     * `parent` равен null только у пустого репозитория — первый коммит без
     * родителя, дальше обычная цепочка.
     */
    async commit(options: {
      parent: string | null
      files: readonly FileToWrite[]
      message: string
    }): Promise<string> {
      const tree = await call<{ sha: string }>('/git/trees', {
        method: 'POST',
        body: JSON.stringify({
          ...(options.parent ? { base_tree: options.parent } : {}),
          tree: options.files.map((file) => ({
            path: file.path,
            mode: BLOB_MODE,
            type: 'blob',
            content: file.content,
          })),
        }),
      })

      const created = await call<{ sha: string }>('/git/commits', {
        method: 'POST',
        body: JSON.stringify({
          message: options.message,
          tree: tree.sha,
          parents: options.parent ? [options.parent] : [],
        }),
      })

      return created.sha
    },

    /**
     * Двигает ветку на новый коммит.
     *
     * Без `force`: если второе устройство успело отправить раньше, GitHub
     * откажет, и это ровно то, что нужно — перечитать и слить заново.
     */
    async moveBranch(commitSha: string, options: { create: boolean }): Promise<void> {
      if (options.create) {
        await call('/git/refs', {
          method: 'POST',
          body: JSON.stringify({ ref: `refs/heads/${repo.branch}`, sha: commitSha }),
        })
        return
      }
      await call(`/git/refs/heads/${encodeURIComponent(repo.branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commitSha, force: false }),
      })
    },
  }
}

// ─── Отпечаток файла ───────────────────────────────────────────────────────

/**
 * Тот же отпечаток, которым git называет содержимое файла: sha1 от
 * `blob <длина в байтах>\0<содержимое>`.
 *
 * Нужен, чтобы не отправлять файлы, которые не изменились (Р-33): считаем
 * отпечаток у себя и сравниваем с деревом. Скачивать для сравнения нечего.
 *
 * Длина именно в байтах, а не в символах: в заметках кириллица, и на ней
 * эти два числа расходятся вдвое. Ошибка здесь тихая — отпечатки просто
 * никогда не совпадут, и каждая синхронизация переписывала бы весь репозиторий.
 */
export async function blobSha(content: string): Promise<string> {
  const body = new TextEncoder().encode(content)
  const header = new TextEncoder().encode(`blob ${body.length}\0`)

  const buffer = new Uint8Array(header.length + body.length)
  buffer.set(header)
  buffer.set(body, header.length)

  const digest = await crypto.subtle.digest('SHA-1', buffer)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
