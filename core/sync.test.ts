import { describe, expect, it } from 'vitest'
import { GitHubError, blobSha } from './github.ts'
import type { Client, FileToWrite } from './github.ts'
import { shelf, shelfConfig, shelfSummary, type ShelfStores } from '../testing/shelf.ts'
import { createDb, type StoreData } from './db.ts'
import { canonical, createLayout } from './layout.ts'
import type { StoreOf } from './model.ts'
import { SUMMARY_PATH, parseSummary } from './summary.ts'
import { createSync, expiryDay, planUpload } from './sync.ts'
import type { Ports, ShaByPath } from './sync.ts'

// Подставная «Полка» (`testing/shelf.ts`) вместо настоящего приложения
// (Р-47 «Трапезы»). База здесь не открывается: проход ходит в неё через
// порты, а от `db` ему нужна только проверка версии схемы.
const { planDownload, runSync } = createSync(shelf, createDb(shelf))
const { buildFiles, readmeFile } = createLayout(shelf)
const SCHEMA_VERSION = shelf.schemaVersion
const SYNCED_STORES = shelf.stores
type SyncedStore = StoreOf<ShelfStores>

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

  const ports: Ports<ShelfStores> = {
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
  return { id, updatedAt, name: `Полка ${id}`, order: 0, ...over }
}

function mark(id: string, date: string, updatedAt: string): Record_ {
  return { id, updatedAt, bookId: 'b1', minutes: 30, date }
}

/** Репозиторий, каким его оставила бы синхронизация с такими данными. */
function repoWith(seed: Partial<{ [S in SyncedStore]: Record_[] }>): Record<string, string> {
  const data = {} as StoreData<ShelfStores>
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
      { 'shelves.json': 'a', 'quotes.json': 'b' },
      { 'shelves.json': 'a', 'quotes.json': 'старый' },
    )
    expect(plan.download).toEqual(['quotes.json'])
  })

  it('незнакомый файл не скачивает и не считает своим', () => {
    const plan = planDownload({ 'README.md': 'x', 'shelves.json': 'a' }, {})
    expect(plan.download).toEqual(['shelves.json'])
    expect(plan.merged).toEqual(['shelves.json'])
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
        { path: 'shelves.json', content: same },
        { path: 'quotes.json', content: '[{"id":"a"}]\n' },
      ],
      { 'shelves.json': await blobSha(same), 'quotes.json': 'другое' },
    )
    expect(plan.files.map((file) => file.path)).toEqual(['quotes.json'])
    // Отпечатки считаются для всех, включая неотправленные: их запоминаем.
    expect(Object.keys(plan.shas)).toEqual(['shelves.json', 'quotes.json'])
  })
})

// ─── Проход целиком ────────────────────────────────────────────────────────

describe('первый запуск', () => {
  it('в пустом репозитории создаёт ветку и кладёт всё', async () => {
    const repo = fakeRepo()
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })

    const result = await runSync(repo.api, local.ports)

    expect(result.pushed).toBeGreaterThan(0)
    expect(result.pulled).toBe(0)
    // Два коммита, и только здесь: первый заводит репозиторий, второй кладёт
    // данные. Дальше «одна синхронизация — один коммит» держится.
    expect(repo.head()).toBe('commit2')
    expect(Object.keys(repo.files())).toContain('shelves.json')
    expect(JSON.parse(repo.files()['shelves.json'] ?? '[]')[0].id).toBe('i1')
    expect(JSON.parse(repo.files()['meta.json'] ?? '{}').schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('пустой репозиторий сначала заводится через Contents API', async () => {
    // Git Data API на репозитории без единого коммита отвечает 409 на всё,
    // включая создание дерева. Первый файл кладётся другим путём.
    const repo = fakeRepo()
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })

    await runSync(repo.api, local.ports)

    expect(repo.calls.indexOf('createFirst')).toBeLessThan(repo.calls.indexOf('commit'))
    expect(repo.messages()[0]).toBe('Полка: заведение репозитория данных')
    expect(JSON.parse(repo.files()['meta.json'] ?? '{}').schemaVersion).toBe(SCHEMA_VERSION)
    expect(JSON.parse(repo.files()['shelves.json'] ?? '[]')[0].id).toBe('i1')
  })

  it('заведение не повторяется на непустом репозитории', async () => {
    const repo = fakeRepo(repoWith({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] }))
    const local = fakeDb({ shelves: [item('i2', '2026-09-02T10:00:00.000Z')] })

    await runSync(repo.api, local.ports)
    expect(repo.calls).not.toContain('createFirst')
  })

  it('снимает пометки об отправке', async () => {
    const repo = fakeRepo()
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })
    await runSync(repo.api, local.ports)
    expect(local.cleared).toEqual([{ store: 'shelves', id: 'i1' }])
  })
})

describe('тихий проход', () => {
  it('когда ничего не менялось — ни коммита, ни скачиваний', async () => {
    const seed = { shelves: [item('i1', '2026-09-01T10:00:00.000Z')] }
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
    const repo = fakeRepo(repoWith({ shelves: [item('i2', '2026-09-02T10:00:00.000Z')] }))
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })

    const result = await runSync(repo.api, local.ports)

    expect(result.pulled).toBe(1)
    expect(local.data.shelves.map((record) => record.id).sort()).toEqual(['i1', 'i2'])
    // И тут же уезжают обратно вместе с нашей — в файле теперь обе.
    expect(JSON.parse(repo.files()['shelves.json'] ?? '[]')).toHaveLength(2)
  })

  it('поздняя правка побеждает раннюю, чья бы ни была', async () => {
    const repo = fakeRepo(
      repoWith({ shelves: [item('i1', '2026-09-05T10:00:00.000Z', { name: 'С сервера' })] }),
    )
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z', { name: 'Местная' })] })

    await runSync(repo.api, local.ports)
    expect(local.data.shelves[0]?.name).toBe('С сервера')
  })

  it('местная правка новее — уезжает на сервер', async () => {
    const repo = fakeRepo(
      repoWith({ shelves: [item('i1', '2026-09-01T10:00:00.000Z', { name: 'С сервера' })] }),
    )
    const local = fakeDb({ shelves: [item('i1', '2026-09-05T10:00:00.000Z', { name: 'Местная' })] })

    await runSync(repo.api, local.ports)
    expect(local.data.shelves[0]?.name).toBe('Местная')
    expect(JSON.parse(repo.files()['shelves.json'] ?? '[]')[0].name).toBe('Местная')
  })

  it('надгробия уезжают, иначе второе устройство воскресит удалённое', async () => {
    const repo = fakeRepo()
    const local = fakeDb({
      shelves: [item('i1', '2026-09-01T10:00:00.000Z', { deleted: true })],
    })
    await runSync(repo.api, local.ports)
    expect(JSON.parse(repo.files()['shelves.json'] ?? '[]')[0].deleted).toBe(true)
  })
})

describe('гонка двух устройств', () => {
  it('ветка ушла вперёд — перечитываем и сливаемся заново', async () => {
    const repo = fakeRepo(repoWith({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] }))
    const local = fakeDb({ shelves: [item('i2', '2026-09-02T10:00:00.000Z')] })

    // Пока мы собирали коммит, второе устройство отправило свою позицию.
    repo.raceNextPush(
      repoWith({
        shelves: [item('i1', '2026-09-01T10:00:00.000Z'), item('i3', '2026-09-03T10:00:00.000Z')],
      }),
    )

    const result = await runSync(repo.api, local.ports, { pause: () => Promise.resolve() })

    // Ни одна из трёх записей не потерялась.
    expect(JSON.parse(repo.files()['shelves.json'] ?? '[]').map((r: Record_) => r.id).sort())
      .toEqual(['i1', 'i2', 'i3'])
    expect(local.data.shelves.map((r) => r.id).sort()).toEqual(['i1', 'i2', 'i3'])
    expect(result.pushed).toBeGreaterThan(0)
  })

  it('проиграв трижды, откладывает, а не давит силой; между попытками пауза — Р-62 «Дневников»', async () => {
    const repo = fakeRepo(repoWith({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] }))
    const local = fakeDb({ shelves: [item('i2', '2026-09-02T10:00:00.000Z')] })

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
    const repo = fakeRepo({ ...repoWith({}), 'shelves.json': 'не json' })
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })

    await expect(runSync(repo.api, local.ports)).rejects.toThrow('не JSON')
    expect(repo.calls).not.toContain('commit')
    expect(repo.files()['shelves.json']).toBe('не json')
  })

  it('репозиторий более новой схемы не трогается вовсе', async () => {
    const repo = fakeRepo({
      ...repoWith({}),
      'meta.json': `${JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }, null, 2)}\n`,
    })
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })

    await expect(runSync(repo.api, local.ports)).rejects.toThrow('Обнови приложение')
    expect(repo.calls).not.toContain('commit')
  })

  it('репозиторий другого приложения семьи не трогается вовсе — Я-24', async () => {
    const theirs = repoWith({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })
    const repo = fakeRepo({
      ...theirs,
      'meta.json': `${JSON.stringify({ app: 'sosed', schemaVersion: SCHEMA_VERSION }, null, 2)}\n`,
    })
    const local = fakeDb({ shelves: [item('i2', '2026-09-02T10:00:00.000Z')] })

    await expect(runSync(repo.api, local.ports)).rejects.toThrow('другого приложения семьи (sosed)')
    expect(repo.calls).not.toContain('commit')
    // Совпавшее по имени хранилище соседа не влито как своё.
    expect(local.data.shelves.map((record) => record.id)).toEqual(['i2'])
    expect(repo.files()['shelves.json']).toBe(theirs['shelves.json'])
  })

  it('чужой meta.json проверяется, даже если его отпечаток запомнен — Я-24', async () => {
    // Запомненное дерево при смене имени репозитория не сбрасывается, а давний
    // meta.json одной версии у двух приложений побайтно одинаков.
    const foreign = `${JSON.stringify({ app: 'sosed', schemaVersion: SCHEMA_VERSION }, null, 2)}\n`
    const repo = fakeRepo({ ...repoWith({}), 'meta.json': foreign })
    const local = fakeDb()
    await local.ports.remember({ 'meta.json': await blobSha(foreign) }, 'commit0')

    await expect(runSync(repo.api, local.ports)).rejects.toThrow('другого приложения')
    expect(repo.calls).not.toContain('commit')
  })

  it('давний meta.json без имени принимается, имя дописывается тем же проходом — Я-24', async () => {
    const repo = fakeRepo({
      ...repoWith({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] }),
      'meta.json': `${JSON.stringify({ schemaVersion: SCHEMA_VERSION }, null, 2)}\n`,
    })
    const local = fakeDb()

    const result = await runSync(repo.api, local.ports)

    expect(result.pulled).toBe(1)
    expect(JSON.parse(repo.files()['meta.json'] ?? '{}')).toEqual({ app: 'polka', schemaVersion: SCHEMA_VERSION })
  })

  it('свой meta.json не скачивается: отпечаток совпал с тем, что положили бы мы', async () => {
    const own = repoWith({})
    const repo = fakeRepo({ 'meta.json': own['meta.json'] ?? '' })
    const local = fakeDb()

    await runSync(repo.api, local.ports)

    expect(repo.calls).not.toContain('blob')
  })

  it('пометки не снимаются, если проход не дошёл до конца', async () => {
    const repo = fakeRepo({ ...repoWith({}), 'shelves.json': 'не json' })
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })

    await runSync(repo.api, local.ports).catch(() => undefined)
    expect(local.cleared).toEqual([])
  })
})

describe('переезд записи между месяцами', () => {
  it('старый файл перезаписывается пустым, копии не остаётся', async () => {
    const seed = { sessions: [mark('e1', '2026-01-31', '2026-02-01T10:00:00.000Z')] }
    const repo = fakeRepo(repoWith(seed))
    const local = fakeDb(seed)
    await runSync(repo.api, local.ports)

    // Дату поправили: сеанс был не 31 января, а 1 февраля.
    local.data.sessions[0] = mark('e1', '2026-02-01', '2026-02-02T10:00:00.000Z')
    await runSync(repo.api, local.ports)

    expect(JSON.parse(repo.files()['sessions/2026-01.json'] ?? 'null')).toEqual([])
    expect(JSON.parse(repo.files()['sessions/2026-02.json'] ?? '[]')).toHaveLength(1)
  })
})

describe('годовая нарезка — Я-09', () => {
  function review(id: string, writtenOn: string | null, updatedAt: string): Record_ {
    return { id, updatedAt, bookId: 'b1', writtenOn, text: 'Отзыв' }
  }

  it('годовой файл с сервера прилетает в базу — и день, и месяц, и без даты', async () => {
    const repo = fakeRepo({
      'meta.json': `${JSON.stringify({ schemaVersion: SCHEMA_VERSION }, null, 2)}\n`,
      'reviews/2025.json': canonical([
        review('r1', '2025-03-14', '2026-09-01T10:00:00.000Z'),
        review('r2', '2025-07', '2026-09-01T10:00:00.000Z'),
      ] as never),
      'reviews/undated.json': canonical([review('r3', null, '2026-09-01T10:00:00.000Z')] as never),
    })
    const local = fakeDb()

    const result = await runSync(repo.api, local.ports)

    expect(result.pulled).toBe(3)
    expect(local.data.reviews.map((record) => record.id).sort()).toEqual(['r1', 'r2', 'r3'])
  })

  it('своё уезжает в файл года, а не месяца', async () => {
    const repo = fakeRepo()
    const local = fakeDb({ reviews: [review('r1', '2026-03', '2026-09-01T10:00:00.000Z')] })

    await runSync(repo.api, local.ports)

    expect(Object.keys(repo.files()).filter((path) => path.startsWith('reviews/'))).toEqual(['reviews/2026.json'])
  })

  it('переезд между годами: старый файл перезаписывается пустым, копии не остаётся', async () => {
    const seed = { reviews: [review('r1', '2025-12-31', '2026-01-01T10:00:00.000Z')] }
    const repo = fakeRepo(repoWith(seed))
    const local = fakeDb(seed)
    await runSync(repo.api, local.ports)
    expect(repo.files()['reviews/2025.json']).toBeDefined()

    // Дату поправили: отзыв написан уже в новом году.
    local.data.reviews[0] = review('r1', '2026-01-02', '2026-01-02T10:00:00.000Z')
    await runSync(repo.api, local.ports)

    expect(JSON.parse(repo.files()['reviews/2025.json'] ?? 'null')).toEqual([])
    expect(JSON.parse(repo.files()['reviews/2026.json'] ?? '[]')).toHaveLength(1)
  })
})

describe('чужое в репозитории', () => {
  it('README и прочее руками положенное не трогается', async () => {
    const repo = fakeRepo({ ...repoWith({}), 'README.md': '# Мои записи о книгах\n' })
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })

    await runSync(repo.api, local.ports)
    expect(repo.files()['README.md']).toBe('# Мои записи о книгах\n')
  })
})

describe('сообщение коммита', () => {
  it('называет файл, когда он один, и считает, когда их много', async () => {
    const seed = { shelves: [item('i1', '2026-09-01T10:00:00.000Z')] }
    const repo = fakeRepo(repoWith(seed))
    const local = fakeDb(seed)
    await runSync(repo.api, local.ports)

    // Поменялась одна позиция — в коммите один файл, и он назван.
    local.data.shelves[0] = item('i1', '2026-09-02T10:00:00.000Z', { name: 'Другое' })
    await runSync(repo.api, local.ports)
    expect(repo.messages().at(-1)).toBe('Полка: shelves.json')
  })

  it('первый коммит перечисляет файлы в теле', async () => {
    const repo = fakeRepo()
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })
    await runSync(repo.api, local.ports)

    const message = repo.messages().at(-1) ?? ''
    expect(message).toMatch(/^Полка: обновлено файлов \d+/)
    expect(message).toContain('shelves.json')
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
    const seed = { shelves: [item('i1', '2026-09-01T10:00:00.000Z')] }
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
    const local = fakeDb({ shelves: [item('i1', '2026-09-01T10:00:00.000Z')] })
    await runSync(repo.api, local.ports)
    delete repo.files()['README.md']

    await runSync(repo.api, local.ports)
    expect(repo.files()['README.md']).toBe(readmeFile().content)
  })
})

describe('срез итогов — Я-16', () => {
  const DAY = '2026-09-24'
  const withSummary = shelfConfig({ summary: shelfSummary })
  const summarySync = createSync(withSummary, createDb(withSummary))
  const seed = {
    sessions: [mark('s1', '2026-09-22', '2026-09-22T10:00:00.000Z')],
    books: [{ id: 'b1', updatedAt: '2026-09-01T10:00:00.000Z', title: 'Книга', addedOn: null }],
  }

  it('кладётся тем же коммитом, что и данные: день расчёта и «по записям по» ставит ядро', async () => {
    const repo = fakeRepo(repoWith({}))
    const local = fakeDb(seed)

    const result = await summarySync.runSync(repo.api, local.ports, { day: DAY })

    expect(result.summaryError).toBeNull()
    const summary = parseSummary(repo.files()[SUMMARY_PATH] ?? '')
    expect(summary.computedOn).toBe(DAY)
    expect(summary.lastEdit).toBe('2026-09-22')
    expect(summary.periods[1]?.metrics).toEqual([
      { key: 'reading', label: 'Чтение', value: { n: 30, unit: 'minutes' }, basis: 'по 1 сеансам' },
    ])
    expect(repo.files()['sessions/2026-09.json']).toBeDefined()
  })

  it('функции среза даются живые записи; надгробие двигает только «по записям по»', async () => {
    const repo = fakeRepo(repoWith({}))
    const local = fakeDb({
      sessions: [
        mark('s1', '2026-09-22', '2026-09-22T10:00:00.000Z'),
        { ...mark('s2', '2026-09-23', '2026-09-23T10:00:00.000Z'), deleted: true },
      ],
    })

    await summarySync.runSync(repo.api, local.ports, { day: DAY })

    const summary = parseSummary(repo.files()[SUMMARY_PATH] ?? '')
    expect(summary.periods[1]?.metrics).toMatchObject([{ value: { n: 30 } }])
    expect(summary.lastEdit).toBe('2026-09-23')
  })

  it('в тот же день тихий проход не коммитит; на следующий — один коммит, и только срез', async () => {
    const repo = fakeRepo(repoWith({}))
    const local = fakeDb(seed)
    await summarySync.runSync(repo.api, local.ports, { day: DAY })

    repo.calls.length = 0
    const same = await summarySync.runSync(repo.api, local.ports, { day: DAY })
    expect(same.pushed).toBe(0)
    expect(repo.calls).toEqual(['head', 'tree'])

    const next = await summarySync.runSync(repo.api, local.ports, { day: '2026-09-25' })
    expect(next.pushed).toBe(1)
    expect(repo.messages().at(-1)).toBe(`Полка: ${SUMMARY_PATH}`)
  })

  it('срез на сервере приложение не скачивает и не вливает', () => {
    const plan = summarySync.planDownload({ [SUMMARY_PATH]: 'x', 'shelves.json': 'a' }, {})
    expect(plan.download).toEqual(['shelves.json'])
  })

  it('упавшая функция среза не мешает данным: они уехали, среза нет, причина названа', async () => {
    const failing = shelfConfig({
      summary: () => {
        throw new Error('сломалось')
      },
    })
    const repo = fakeRepo(repoWith({}))
    const local = fakeDb(seed)

    const result = await createSync(failing, createDb(failing)).runSync(repo.api, local.ports, { day: DAY })

    expect(result.summaryError).toBe('сломалось')
    expect(repo.files()[SUMMARY_PATH]).toBeUndefined()
    expect(repo.files()['sessions/2026-09.json']).toBeDefined()
    expect(local.cleared.length).toBeGreaterThan(0)
  })

  it('кривая форма — то же: среза нет, данные уехали, расхождение названо', async () => {
    const crooked = shelfConfig({ summary: (data, day) => ({ ...shelfSummary(data, day), periods: [] }) })
    const repo = fakeRepo(repoWith({}))
    const local = fakeDb(seed)

    const result = await createSync(crooked, createDb(crooked)).runSync(repo.api, local.ports, { day: DAY })

    expect(result.summaryError).toContain('отрезков должно быть 4')
    expect(repo.files()[SUMMARY_PATH]).toBeUndefined()
    expect(repo.files()['sessions/2026-09.json']).toBeDefined()
  })

  it('без функции среза файла нет', async () => {
    const repo = fakeRepo(repoWith({}))
    const result = await runSync(repo.api, fakeDb(seed).ports, { day: DAY })
    expect(result.summaryError).toBeNull()
    expect(repo.files()[SUMMARY_PATH]).toBeUndefined()
  })
})
