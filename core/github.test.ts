import { describe, expect, it } from 'vitest'
import { GitHubError, blobSha, createClient, parseRepo } from './github.ts'
import type { RepoRef } from './github.ts'

const REPO: RepoRef = { owner: 'goigolden88', name: 'polka-data', branch: 'main' }

type Reply = {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> }

/**
 * Подставной `fetch`: отвечает по совпадению куска адреса и записывает,
 * с чем его позвали. Настоящая сеть в тестах не нужна — здесь проверяется
 * разбор ответов и перевод ошибок, а не GitHub.
 */
function stub(replies: Record<string, Reply | Reply[]>) {
  const calls: Call[] = []
  const queues = new Map<string, Reply[]>(
    Object.entries(replies).map(([key, value]) => [key, Array.isArray(value) ? [...value] : [value]]),
  )

  const fetch = (async (url: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers,
    })

    const key = [...queues.keys()].find((pattern) => url.includes(pattern))
    if (key === undefined) throw new Error(`Тест не готовил ответа на ${url}`)

    const queue = queues.get(key) ?? []
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) as Reply
    const status = reply.status ?? 200

    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status,
      headers: { 'Content-Type': 'application/json', ...reply.headers },
    })
  }) as unknown as typeof globalThis.fetch

  return { fetch, calls }
}

/** Текст → base64 так, как его отдаёт GitHub. Без Buffer: типов node в проекте нет. */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function client(replies: Record<string, Reply | Reply[]>) {
  const { fetch, calls } = stub(replies)
  return { api: createClient({ repo: REPO, token: 'ghp_secret', fetch }), calls }
}

describe('parseRepo', () => {
  it('разбирает «владелец/репозиторий»', () => {
    expect(parseRepo('goigolden88/polka-data')).toEqual({
      owner: 'goigolden88',
      name: 'polka-data',
    })
  })

  it('принимает ссылку из адресной строки и .git на конце', () => {
    expect(parseRepo('https://github.com/goigolden88/polka-data')).toEqual({
      owner: 'goigolden88',
      name: 'polka-data',
    })
    expect(parseRepo('https://github.com/goigolden88/polka-data.git')).toEqual({
      owner: 'goigolden88',
      name: 'polka-data',
    })
    expect(parseRepo('  goigolden88/polka-data/  ')).toEqual({
      owner: 'goigolden88',
      name: 'polka-data',
    })
  })

  it('отвергает мусор', () => {
    expect(() => parseRepo('')).toThrow('не указан')
    expect(() => parseRepo('просто-слово')).toThrow('владелец/репозиторий')
    expect(() => parseRepo('a/b/c')).toThrow('владелец/репозиторий')
    expect(() => parseRepo('a b/c')).toThrow('владелец/репозиторий')
  })
})

describe('blobSha', () => {
  /**
   * Значения получены `git hash-object` — это ровно тот отпечаток, который
   * будет лежать в дереве репозитория. Совпадение здесь означает, что
   * сравнение «файл не менялся» работает, а не что мы согласны сами с собой.
   */
  it('совпадает с git hash-object', async () => {
    expect(await blobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    expect(await blobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  })

  it('считает длину в байтах, а не в символах', async () => {
    // «Щётка зубная» — 12 символов, 23 байта. Ошибись здесь — отпечатки
    // никогда не совпадут, и каждая синхронизация переписывала бы всё.
    expect(await blobSha('Щётка зубная')).toBe('3059fd2a19dc4c2e9a66cee95700881649bdc9b5')
  })
})

describe('info', () => {
  it('видит право аккаунта на запись и приватность', async () => {
    const { api, calls } = client({
      '/repos/': {
        body: {
          full_name: 'goigolden88/polka-data',
          private: true,
          default_branch: 'main',
          permissions: { push: true },
        },
      },
    })

    expect(await api.info()).toEqual({
      fullName: 'goigolden88/polka-data',
      private: true,
      canWrite: true,
      defaultBranch: 'main',
    })
    expect(calls[0]?.headers.Authorization).toBe('Bearer ghp_secret')
  })

  // Токен Read-only у владельца здесь не виден: права токена GitHub не сообщает (Я-28).
  it('аккаунт без права записи — canWrite false', async () => {
    const { api } = client({
      '/repos/': {
        body: {
          full_name: 'goigolden88/polka-data',
          private: true,
          default_branch: 'main',
          permissions: { push: false },
        },
      },
    })
    expect((await api.info()).canWrite).toBe(false)
  })
})

describe('ошибки', () => {
  it('401 говорит про срок жизни токена', async () => {
    const { api } = client({ '/repos/': { status: 401, body: { message: 'Bad credentials' } } })
    const error = await api.info().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(GitHubError)
    expect((error as GitHubError).badToken).toBe(true)
    expect((error as GitHubError).message).toMatch(/истёк срок/)
  })

  it('403 без прав отличается от 403 по лимиту', async () => {
    const noRights = client({ '/repos/': { status: 403, body: {} } })
    await expect(noRights.api.info()).rejects.toThrow(/Contents: Read and write/)

    const limited = client({
      '/repos/': { status: 403, body: {}, headers: { 'x-ratelimit-remaining': '0' } },
    })
    await expect(limited.api.info()).rejects.toThrow(/лимит запросов/)
  })

  it('404 объясняет обе причины: опечатку и чужой токен', async () => {
    const { api } = client({ '/repos/': { status: 404, body: { message: 'Not Found' } } })
    await expect(api.info()).rejects.toThrow(/опечатка.*токен выдан не на него/s)
  })

  it('409 помечается как гонка', async () => {
    const { api } = client({
      '/git/refs/heads/main': { status: 409, body: { message: 'is at abc but expected def' } },
    })
    const error = await api.moveBranch('deadbeef', { create: false }).catch((f: unknown) => f)
    expect((error as GitHubError).conflict).toBe(true)
  })

  it('обрыв связи не выглядит как ответ сервера', async () => {
    const fetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof globalThis.fetch
    const api = createClient({ repo: REPO, token: 't', fetch })
    const error = await api.info().catch((failure: unknown) => failure)
    expect((error as GitHubError).status).toBe(0)
    expect((error as GitHubError).message).toMatch(/Нет связи/)
  })
})

describe('срок жизни токена', () => {
  it('берётся из заголовка ответа', async () => {
    const { api } = client({
      '/repos/': {
        body: { full_name: 'a/b', private: true, default_branch: 'main', permissions: {} },
        headers: { 'github-authentication-token-expiration': '2027-09-09 12:00:00 +0300' },
      },
    })
    expect(api.tokenExpiry()).toBeNull()
    await api.info()
    expect(api.tokenExpiry()).toBe('2027-09-09 12:00:00 +0300')
  })

  it('без заголовка остаётся неизвестным, а не выдуманным', async () => {
    const { api } = client({
      '/repos/': { body: { full_name: 'a/b', private: true, default_branch: 'main', permissions: {} } },
    })
    await api.info()
    expect(api.tokenExpiry()).toBeNull()
  })
})

describe('чтение репозитория', () => {
  it('пустой репозиторий — не ошибка, а первый запуск', async () => {
    // 404 — нет такой ветки.
    const missing = client({ '/git/ref/heads/main': { status: 404, body: {} } })
    expect(await missing.api.head()).toBeNull()

    // 409 — нет ни одного коммита вообще. Ровно это отвечает GitHub на
    // репозиторий, который только что создали и ничего в него не положили,
    // то есть на самый обычный первый запуск.
    const fresh = client({
      '/git/ref/heads/main': { status: 409, body: { message: 'Git Repository is empty.' } },
    })
    expect(await fresh.api.head()).toBeNull()
  })

  it('голова ветки', async () => {
    const { api } = client({ '/git/ref/heads/main': { body: { object: { sha: 'c0ffee' } } } })
    expect(await api.head()).toBe('c0ffee')
  })

  it('дерево отдаётся без каталогов', async () => {
    const { api, calls } = client({
      '/git/trees/': {
        body: {
          tree: [
            { path: 'cycles', sha: 't1', type: 'tree' },
            { path: 'cycles/2026.json', sha: 'b1', type: 'blob' },
            { path: 'items.json', sha: 'b2', type: 'blob' },
          ],
        },
      },
    })
    const tree = await api.tree('c0ffee')
    expect(tree.map((entry) => entry.path)).toEqual(['cycles/2026.json', 'items.json'])
    expect(calls[0]?.url).toContain('recursive=1')
  })

  it('обрезанное дерево — отказ, а не половина данных', async () => {
    const { api } = client({ '/git/trees/': { body: { tree: [], truncated: true } } })
    await expect(api.tree('c0ffee')).rejects.toThrow(/не поместилось/)
  })

  it('кириллица в файле приезжает читаемой', async () => {
    const text = '{"name":"Щётка зубная"}'
    const base64 = toBase64(text)
    const { api } = client({ '/git/blobs/': { body: { content: base64, encoding: 'base64' } } })
    expect(await api.blob('b1')).toBe(text)
  })

  it('переводы строк внутри base64 не мешают', async () => {
    const text = 'Щётка'
    const wrapped = toBase64(text).split('').join('\n')
    const { api } = client({ '/git/blobs/': { body: { content: wrapped, encoding: 'base64' } } })
    expect(await api.blob('b1')).toBe(text)
  })
})

describe('отправка', () => {
  const replies = {
    '/git/trees': { body: { sha: 'tree1' } },
    '/git/commits': { body: { sha: 'commit1' } },
    '/git/refs': { status: 200, body: {} },
  }

  it('один коммит на все файлы, содержимое кладётся прямо в дерево', async () => {
    const { api, calls } = client(replies)
    const sha = await api.commit({
      parent: 'parent1',
      files: [
        { path: 'items.json', content: '[]' },
        { path: 'cycles/2026.json', content: '[1]' },
      ],
      message: 'Полка',
    })

    expect(sha).toBe('commit1')

    const tree = calls[0]?.body as { base_tree: string; tree: unknown[] }
    expect(tree.base_tree).toBe('parent1')
    expect(tree.tree).toHaveLength(2)
    expect(tree.tree[0]).toEqual({
      path: 'items.json',
      mode: '100644',
      type: 'blob',
      content: '[]',
    })

    const commit = calls[1]?.body as { parents: string[]; tree: string }
    expect(commit.parents).toEqual(['parent1'])
    expect(commit.tree).toBe('tree1')
    // Ровно два запроса: дерево и коммит. Блобы отдельно не загружаются.
    expect(calls).toHaveLength(2)
  })

  it('в пустом репозитории первый коммит идёт без родителя', async () => {
    const { api, calls } = client(replies)
    await api.commit({ parent: null, files: [{ path: 'items.json', content: '[]' }], message: 'Первый' })

    const tree = calls[0]?.body as Record<string, unknown>
    expect(tree.base_tree).toBeUndefined()
    expect((calls[1]?.body as { parents: string[] }).parents).toEqual([])
  })

  it('ветка двигается без force, чтобы чужая отправка не потерялась', async () => {
    const { api, calls } = client(replies)
    await api.moveBranch('commit1', { create: false })
    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.body).toEqual({ sha: 'commit1', force: false })
  })

  it('в пустом репозитории ветка создаётся, а не двигается', async () => {
    const { api, calls } = client(replies)
    await api.moveBranch('commit1', { create: true })
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({ ref: 'refs/heads/main', sha: 'commit1' })
  })
})
