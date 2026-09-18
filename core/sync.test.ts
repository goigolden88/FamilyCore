import { describe, expect, it } from 'vitest'
import { GitHubError, blobSha } from './github.ts'
import type { Client, FileToWrite } from './github.ts'
import { buildFiles, canonical, readmeFile } from './layout.ts'
import { SCHEMA_VERSION, SYNCED_STORES } from './model.ts'
import type { StoreRecord, SyncedStore } from './model.ts'
import { expiryDay, planDownload, planUpload, runSync } from './sync.ts'
import type { Ports, ShaByPath } from './sync.ts'

// ─── Подставной GitHub ─────────────────────────────────────────────────────

type Record_ = { id: string; updatedAt: string; [key: string]: unknown }

/**
 * Репозиторий в памяти: файлы, голова ветки, счётчик запросов.
 *
 * Настоящий GitHub здесь не нужен — проверяется порядок действий и работа
 * с конфликтами, а разбор ответов уже покрыт в github.test.ts.
 */
function fakeRepo(initial: Record<string, string> = {}) {
  let files: Record<string, string> = { ...initial }
  let head: string | null = Object.keys(initial).length > 0 ? 'commit0' : null
  let counter = 0
  let staged: { files: readonly FileToWrite[]; message: string } | null = null
  const messages: string[] = []

  const calls: string[] = []
  /** Что должен сделать чужой push перед тем, как мы двинем ветку. */
  let raceOnce: (() => void) | null = null

  const api: Client = {
    tokenExpiry: () => null,

    info: () =>
      Promise.resolve({
        fullName: 'a/b',
        private: true,
        canWrite: true,
        defaultBranch: 'main',
      }),

    head: () => {
      calls.push('head')
      return Promise.resolve(head)
    },

    tree: async () => {
      calls.push('tree')
      const entries = []
      for (const [path, content] of Object.entries(files)) {
        entries.push({ path, sha: await blobSha(content), type: 'blob' as const })
      }
      return entries
    },

    blob: async (sha) => {
      calls.push('blob')
      for (const content of Object.values(files)) {
        if ((await blobSha(content)) === sha) return content
      }
      throw new Error(`Нет блоба ${sha}`)
    },

    /**
     * Contents API: единственный путь в репозиторий без коммитов. Здесь он
     * кладёт файл сразу и двигает голову — как и настоящий.
     */
    createFirst: (file, message) => {
      calls.push('createFirst')
      messages.push(message)
      files[file.path] = file.content
      counter += 1
      head = `commit${counter}`
      return Promise.resolve(head)
    },

    commit: ({ files: toWrite, message }) => {
      calls.push('commit')
      staged = { files: toWrite, message }
      messages.push(message)
      counter += 1
      return Promise.resolve(`commit${counter}`)
    },

    moveBranch: (sha) => {
      calls.push('moveBranch')
      if (raceOnce) {
        // Второе устройство успело раньше: его коммит уже в ветке.
        raceOnce()
        raceOnce = null
        staged = null
        return Promise.reject(new GitHubError('is at abc but expected def', { conflict: true }))
      }
      if (staged) {
        for (const file of staged.files) files[file.path] = file.content
        staged = null
      }
      head = sha
      return Promise.resolve()
    },
  }

  return {
    api,
    calls,
    files: () => files,
    head: () => head,
    /** Кто-то отправил раньше нас: правит файлы и двигает голову. */
    raceNextPush(change: Record<string, string>) {
      raceOnce = () => {
        files = { ...files, ...change }
        head = 'other'
      }
    },
    messages: () => messages,
  }
}

// ─── Подставная база ───────────────────────────────────────────────────────

function fakeDb(seed: Partial<{ [S in SyncedStore]: Record_[] }> = {}) {
  const data = {} as { [S in SyncedStore]: Record_[] }
  for (const store of SYNCED_STORES) Object.assign(data, { [store]: [...(seed[store] ?? [])] })

  let remembered: ShaByPath = {}
  let commit: string | null = null
  const dirty: { store: SyncedStore; id: string; at: string }[] = []
  const cleared: { store: SyncedStore; id: string }[] = []

  for (const store of SYNCED_STORES) {
    for (const record of data[store]) dirty.push({ store, id: record.id, at: record.updatedAt })
  }

  const ports: Ports = {
    readAll: () => Promise.resolve(data as never),

    /** Правило Р-07 «Дневников»: по `id` побеждает поздний `updatedAt`. */
    merge: (store, incoming) => {
      let applied = 0
      for (const record of incoming) {
        const current = data[store].find((each) => each.id === record.id)
        if (current && current.updatedAt >= record.updatedAt) continue
        if (current) data[store][data[store].indexOf(current)] = record as Record_
        else data[store].push(record as Record_)
        applied += 1
      }
      return Promise.resolve(applied)
    },

    listDirty: () => Promise.resolve([...dirty]),
    clearDirty: (refs) => {
      cleared.push(...refs.map((ref) => ({ store: ref.store, id: ref.id })))
      return Promise.resolve()
    },

    remembered: () => Promise.resolve(remembered),
    remember: (shas, at) => {
      remembered = shas
      commit = at
      return Promise.resolve()
    },
  }

  return {
    ports,
    data,
    cleared,
    tree: () => remembered,
    commit: () => commit,
  }
}

function item(id: string, updatedAt: string, over: Partial<Record_> = {}): Record_ {
  return { id, updatedAt, name: `Категория ${id}`, order: 0, kind: 'neutral', ...over }
}

function mark(id: string, date: string, updatedAt: string): Record_ {
  return { id, updatedAt, categoryId: 'c1', minutes: 30, date }
}

/** Репозиторий, каким его оставила бы синхронизация с такими данными. */
function repoWith(seed: Partial<{ [S in SyncedStore]: Record_[] }>): Record<string, string> {
  const data = {} as { [S in SyncedStore]: StoreRecord[S][] }
  for (const store of SYNCED_STORES) {
    Object.assign(data, { [store]: (seed[store] ?? []) as never })
  }
  const files: Record<string, string> = {}
  for (const file of buildFiles(data)) files[file.path] = file.content
  return files
}

// ─── Планирование ──────────────────────────────────────────────────────────

describe('planDownload', () => {
  it('скачивает только разошедшиеся файлы', () => {
    const plan = planDownload(
      { 'categories.json': 'a', 'presets.json': 'b' },
      { 'categories.json': 'a', 'presets.json': 'старый' },
    )
    expect(plan.download).toEqual(['presets.json'])
  })

  it('незнакомый файл не скачивает и не считает своим', () => {
    const plan = planDownload({ 'README.md': 'x', 'categories.json': 'a' }, {})
    expect(plan.download).toEqual(['categories.json'])
    expect(plan.merged).toEqual(['categories.json'])
  })

  it('meta.json скачивается, но своим хранилищем не считается', () => {
    const plan = planDownload({ 'meta.json': 'm' }, {})
    expect(plan.download).toEqual(['meta.json'])
    expect(plan.merged).toEqual([])
  })
})

describe('planUpload', () => {
  it('отправляет только разошедшееся', async () => {
    const same = canonical([])
    const plan = await planUpload(
      [
        { path: 'categories.json', content: same },
        { path: 'presets.json', content: '[{"id":"a"}]\n' },
      ],
      { 'categories.json': await blobSha(same), 'presets.json': 'другое' },
    )
    expect(plan.files.map((file) => file.path)).toEqual(['presets.json'])
    // Отпечатки считаются для всех, включая неотправленные: их запоминаем.
    expect(Object.keys(plan.shas)).toEqual(['categories.json', 'presets.json'])
  })
})

// ─── Проход целиком ────────────────────────────────────────────────────────

describe('первый запуск', () => {
  it('в пустом репозитории создаёт ветку и кладёт всё', async () => {
    const repo = fakeRepo()
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] })

    const result = await runSync(repo.api, local.ports)

    expect(result.pushed).toBeGreaterThan(0)
    expect(result.pulled).toBe(0)
    // Два коммита, и только здесь: первый заводит репозиторий, второй кладёт
    // данные. Дальше «одна синхронизация — один коммит» держится.
    expect(repo.head()).toBe('commit2')
    expect(Object.keys(repo.files())).toContain('categories.json')
    expect(JSON.parse(repo.files()['categories.json'] ?? '[]')[0].id).toBe('i1')
    expect(JSON.parse(repo.files()['meta.json'] ?? '{}').schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('пустой репозиторий сначала заводится через Contents API', async () => {
    // Git Data API на репозитории без единого коммита отвечает 409 на всё,
    // включая создание дерева. Первый файл кладётся другим путём.
    const repo = fakeRepo()
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] })

    await runSync(repo.api, local.ports)

    expect(repo.calls.indexOf('createFirst')).toBeLessThan(repo.calls.indexOf('commit'))
    expect(repo.messages()[0]).toBe('Делу Время: заведение репозитория данных')
    expect(JSON.parse(repo.files()['meta.json'] ?? '{}').schemaVersion).toBe(SCHEMA_VERSION)
    expect(JSON.parse(repo.files()['categories.json'] ?? '[]')[0].id).toBe('i1')
  })

  it('заведение не повторяется на непустом репозитории', async () => {
    const repo = fakeRepo(repoWith({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] }))
    const local = fakeDb({ categories: [item('i2', '2026-09-02T10:00:00.000Z')] })

    await runSync(repo.api, local.ports)
    expect(repo.calls).not.toContain('createFirst')
  })

  it('снимает пометки об отправке', async () => {
    const repo = fakeRepo()
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] })
    await runSync(repo.api, local.ports)
    expect(local.cleared).toEqual([{ store: 'categories', id: 'i1' }])
  })
})

describe('тихий проход', () => {
  it('когда ничего не менялось — ни коммита, ни скачиваний', async () => {
    const seed = { categories: [item('i1', '2026-09-01T10:00:00.000Z')] }
    const repo = fakeRepo(repoWith(seed))
    const local = fakeDb(seed)

    // Первый проход запоминает отпечатки, второй должен пройти вхолостую.
    await runSync(repo.api, local.ports)
    repo.calls.length = 0
    const result = await runSync(repo.api, local.ports)

    expect(result.pushed).toBe(0)
    expect(result.pulled).toBe(0)
    expect(repo.calls).toEqual(['head', 'tree'])
  })
})

describe('чужие записи', () => {
  it('прилетают в базу', async () => {
    const repo = fakeRepo(repoWith({ categories: [item('i2', '2026-09-02T10:00:00.000Z')] }))
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] })

    const result = await runSync(repo.api, local.ports)

    expect(result.pulled).toBe(1)
    expect(local.data.categories.map((record) => record.id).sort()).toEqual(['i1', 'i2'])
    // И тут же уезжают обратно вместе с нашей — в файле теперь обе.
    expect(JSON.parse(repo.files()['categories.json'] ?? '[]')).toHaveLength(2)
  })

  it('поздняя правка побеждает раннюю, чья бы ни была', async () => {
    const repo = fakeRepo(
      repoWith({ categories: [item('i1', '2026-09-05T10:00:00.000Z', { name: 'С сервера' })] }),
    )
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z', { name: 'Местная' })] })

    await runSync(repo.api, local.ports)
    expect(local.data.categories[0]?.name).toBe('С сервера')
  })

  it('местная правка новее — уезжает на сервер', async () => {
    const repo = fakeRepo(
      repoWith({ categories: [item('i1', '2026-09-01T10:00:00.000Z', { name: 'С сервера' })] }),
    )
    const local = fakeDb({ categories: [item('i1', '2026-09-05T10:00:00.000Z', { name: 'Местная' })] })

    await runSync(repo.api, local.ports)
    expect(local.data.categories[0]?.name).toBe('Местная')
    expect(JSON.parse(repo.files()['categories.json'] ?? '[]')[0].name).toBe('Местная')
  })

  it('надгробия уезжают, иначе второе устройство воскресит удалённое', async () => {
    const repo = fakeRepo()
    const local = fakeDb({
      categories: [item('i1', '2026-09-01T10:00:00.000Z', { deleted: true })],
    })
    await runSync(repo.api, local.ports)
    expect(JSON.parse(repo.files()['categories.json'] ?? '[]')[0].deleted).toBe(true)
  })
})

describe('гонка двух устройств', () => {
  it('ветка ушла вперёд — перечитываем и сливаемся заново', async () => {
    const repo = fakeRepo(repoWith({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] }))
    const local = fakeDb({ categories: [item('i2', '2026-09-02T10:00:00.000Z')] })

    // Пока мы собирали коммит, второе устройство отправило свою позицию.
    repo.raceNextPush(
      repoWith({
        categories: [item('i1', '2026-09-01T10:00:00.000Z'), item('i3', '2026-09-03T10:00:00.000Z')],
      }),
    )

    const result = await runSync(repo.api, local.ports, { pause: () => Promise.resolve() })

    // Ни одна из трёх записей не потерялась.
    expect(JSON.parse(repo.files()['categories.json'] ?? '[]').map((r: Record_) => r.id).sort())
      .toEqual(['i1', 'i2', 'i3'])
    expect(local.data.categories.map((r) => r.id).sort()).toEqual(['i1', 'i2', 'i3'])
    expect(result.pushed).toBeGreaterThan(0)
  })

  it('проиграв трижды, откладывает, а не давит силой; между попытками пауза — Р-62 «Дневников»', async () => {
    const repo = fakeRepo(repoWith({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] }))
    const local = fakeDb({ categories: [item('i2', '2026-09-02T10:00:00.000Z')] })

    repo.raceNextPush({})
    const first = repo.api.moveBranch
    // Проигрывает каждый раз: подставляем гонку заново после первой.
    repo.api.moveBranch = (sha, options) => {
      repo.raceNextPush({})
      return first(sha, options)
    }

    // Сразу повторять бесполезно: соседняя отправка ещё не закончилась.
    const pauses: number[] = []
    const pause = (attempt: number) => {
      pauses.push(attempt)
      return Promise.resolve()
    }

    await expect(runSync(repo.api, local.ports, { pause })).rejects.toThrow(GitHubError)
    expect(pauses).toEqual([1, 2])
  })
})

describe('порядок «сначала чужое, потом своё»', () => {
  it('битый файл на сервере обрывает проход до отправки', async () => {
    const repo = fakeRepo({ ...repoWith({}), 'categories.json': 'не json' })
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] })

    await expect(runSync(repo.api, local.ports)).rejects.toThrow('не JSON')
    expect(repo.calls).not.toContain('commit')
    expect(repo.files()['categories.json']).toBe('не json')
  })

  it('репозиторий более новой схемы не трогается вовсе', async () => {
    const repo = fakeRepo({
      ...repoWith({}),
      'meta.json': `${JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }, null, 2)}\n`,
    })
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] })

    await expect(runSync(repo.api, local.ports)).rejects.toThrow('Обнови приложение')
    expect(repo.calls).not.toContain('commit')
  })

  it('пометки не снимаются, если проход не дошёл до конца', async () => {
    const repo = fakeRepo({ ...repoWith({}), 'categories.json': 'не json' })
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] })

    await runSync(repo.api, local.ports).catch(() => undefined)
    expect(local.cleared).toEqual([])
  })
})

describe('переезд записи между месяцами', () => {
  it('старый файл перезаписывается пустым, копии не остаётся', async () => {
    const seed = { time: [mark('e1', '2026-01-31', '2026-02-01T10:00:00.000Z')] }
    const repo = fakeRepo(repoWith(seed))
    const local = fakeDb(seed)
    await runSync(repo.api, local.ports)

    // Дату поправили: блок был не 31 января, а 1 февраля.
    local.data.time[0] = mark('e1', '2026-02-01', '2026-02-02T10:00:00.000Z')
    await runSync(repo.api, local.ports)

    expect(JSON.parse(repo.files()['time/2026-01.json'] ?? 'null')).toEqual([])
    expect(JSON.parse(repo.files()['time/2026-02.json'] ?? '[]')).toHaveLength(1)
  })
})

describe('чужое в репозитории', () => {
  it('README и прочее руками положенное не трогается', async () => {
    const repo = fakeRepo({ ...repoWith({}), 'README.md': '# Данные «Делу Время»\n' })
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] })

    await runSync(repo.api, local.ports)
    expect(repo.files()['README.md']).toBe('# Данные «Делу Время»\n')
  })
})

describe('сообщение коммита', () => {
  it('называет файл, когда он один, и считает, когда их много', async () => {
    const seed = { categories: [item('i1', '2026-09-01T10:00:00.000Z')] }
    const repo = fakeRepo(repoWith(seed))
    const local = fakeDb(seed)
    await runSync(repo.api, local.ports)

    // Поменялась одна позиция — в коммите один файл, и он назван.
    local.data.categories[0] = item('i1', '2026-09-02T10:00:00.000Z', { name: 'Другое' })
    await runSync(repo.api, local.ports)
    expect(repo.messages().at(-1)).toBe('Делу Время: categories.json')
  })

  it('первый коммит перечисляет файлы в теле', async () => {
    const repo = fakeRepo()
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] })
    await runSync(repo.api, local.ports)

    const message = repo.messages().at(-1) ?? ''
    expect(message).toMatch(/^Делу Время: обновлено файлов \d+/)
    expect(message).toContain('categories.json')
  })
})

describe('срок жизни токена', () => {
  it('читает и формат GitHub, и вписанную руками дату', () => {
    expect(expiryDay('2027-09-09 12:00:00 +0300')).toBe('2027-09-09')
    expect(expiryDay('2027-09-09')).toBe('2027-09-09')
    expect(expiryDay('2027-09-09T12:00:00.000Z')).toBe('2027-09-09')
  })

  it('неизвестный срок не выдумывается', () => {
    expect(expiryDay(null)).toBeNull()
    expect(expiryDay('')).toBeNull()
    expect(expiryDay('никогда')).toBeNull()
    expect(expiryDay('2027-13-40')).toBeNull()
  })
})

describe('README репозитория данных (Р-69 «Делу Время»)', () => {
  it('кладётся, если его нет, — и в заведённом репозитории тоже', async () => {
    const seed = { categories: [item('i1', '2026-09-01T10:00:00.000Z')] }
    const repo = fakeRepo(repoWith(seed))
    const local = fakeDb(seed)

    await runSync(repo.api, local.ports)
    expect(repo.files()['README.md']).toBe(readmeFile().content)

    // Положен — следующий проход его не трогает и коммита не делает.
    repo.calls.length = 0
    const result = await runSync(repo.api, local.ports)
    expect(result.pushed).toBe(0)
  })

  it('удалённый человеком — кладётся снова', async () => {
    const repo = fakeRepo()
    const local = fakeDb({ categories: [item('i1', '2026-09-01T10:00:00.000Z')] })
    await runSync(repo.api, local.ports)
    delete repo.files()['README.md']

    await runSync(repo.api, local.ports)
    expect(repo.files()['README.md']).toBe(readmeFile().content)
  })
})
