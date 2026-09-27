import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { shelf, shelfConfig } from '../testing/shelf.ts'
import { createDb, family } from './db.ts'
import { createSync } from './sync.ts'

/**
 * Общая база `family` (Я-35, Я-37, Я-40…Я-42): токен раз на устройство.
 *
 * Два выдуманных приложения одного origin — «Полка» и «Лавка»: у каждого
 * своя база и своя синхронизация, `indexedDB` у них один, как у приложений
 * семьи на `goigolden88.github.io`. Третье — метаприложение без `createSync`
 * (Я-29): ему токен нужен только для чтения срезов.
 *
 * Приложение «на старом ядре» — его база с ключами `sync*` в `settings`,
 * записанными напрямую: так их оставило прежнее ядро.
 */

const lavkaConfig = shelfConfig({ name: 'Лавка', dbName: 'lavka' })
const metaConfig = shelfConfig({ name: 'Итоги', dbName: 'itogi' })

const polka = createDb(shelf)
const lavka = createDb(lavkaConfig)
const itogi = createDb(metaConfig)

/** Синхронизация создаётся заново в каждом тесте: переезд — один раз на экземпляр. */
function syncs() {
  return { polkaSync: createSync(shelf, polka), lavkaSync: createSync(lavkaConfig, lavka) }
}

beforeEach(async () => {
  for (const db of [polka, lavka, itogi]) await db.close().catch(() => {})
  globalThis.indexedDB = new IDBFactory()
})

afterEach(async () => {
  for (const db of [polka, lavka, itogi]) await db.close().catch(() => {})
})

describe('токен раз на устройство', () => {
  it('вписан в одном приложении — его видит второе', async () => {
    const { polkaSync, lavkaSync } = syncs()
    await polkaSync.saveConfig({ enabled: true, repo: 'me/polka-data', token: ' github_pat_family ' })

    const seen = await lavkaSync.readConfig()
    expect(seen.token).toBe('github_pat_family')
    // Имя репозитория у каждого своё: «Лавке» «Полкино» не досталось.
    expect(seen.repo).toBe('')
    expect(seen.enabled).toBe(false)
  })

  it('имя репозитория приложение пишет под своим dbName', async () => {
    const { polkaSync, lavkaSync } = syncs()
    await polkaSync.saveConfig({ repo: 'me/polka-data' })
    await lavkaSync.saveConfig({ repo: 'me/lavka-data' })

    expect((await polkaSync.readConfig()).repo).toBe('me/polka-data')
    expect((await lavkaSync.readConfig()).repo).toBe('me/lavka-data')
    expect((await family.read()).repos).toEqual({ polka: 'me/polka-data', lavka: 'me/lavka-data' })
  })

  it('два приложения пишут свои имена одновременно — оба на месте', async () => {
    await Promise.all([family.setRepo('polka', 'me/polka-data'), family.setRepo('lavka', 'me/lavka-data')])
    expect((await family.read()).repos).toEqual({ polka: 'me/polka-data', lavka: 'me/lavka-data' })
  })

  it('стёртое имя удаляется из общей базы', async () => {
    const { polkaSync } = syncs()
    await polkaSync.saveConfig({ repo: 'me/polka-data' })
    await polkaSync.saveConfig({ repo: '  ' })
    expect((await family.read()).repos).toEqual({})
  })

  it('ветка и «включено» остаются своими у каждого приложения', async () => {
    const { polkaSync, lavkaSync } = syncs()
    await polkaSync.saveConfig({ token: 'github_pat_family', repo: 'me/polka-data', branch: 'data', enabled: false })
    await lavkaSync.saveConfig({ repo: 'me/lavka-data' })

    expect(await polka.settings.get('syncBranch')).toBe('data')
    expect((await lavkaSync.readConfig()).branch).toBe('main')
    expect((await polkaSync.readConfig()).enabled).toBe(false)
    expect((await lavkaSync.readConfig()).enabled).toBe(true)
  })
})

describe('срок токена (Я-42)', () => {
  it('срок лежит в общей базе: записан одним приложением — виден другому', async () => {
    const { polkaSync, lavkaSync } = syncs()
    await polkaSync.saveConfig({ token: 'github_pat_family' })
    await polkaSync.saveConfig({ tokenExpires: '2027-09-27 12:00:00 +0300' })

    expect((await lavkaSync.readConfig()).tokenExpires).toBe('2027-09-27 12:00:00 +0300')
    expect(await polka.settings.get('syncTokenExpires')).toBeUndefined()
  })

  it('новый токен стирает срок прежнего', async () => {
    const { polkaSync, lavkaSync } = syncs()
    await polkaSync.saveConfig({ token: 'github_pat_old' })
    await polkaSync.saveConfig({ tokenExpires: '2026-10-01' })
    await lavkaSync.saveConfig({ token: 'github_pat_new' })

    const seen = await polkaSync.readConfig()
    expect(seen.token).toBe('github_pat_new')
    expect(seen.tokenExpires).toBeNull()
  })
})

describe('«Забыть токен» (Я-41)', () => {
  it('забывает во всех приложениях устройства', async () => {
    const { polkaSync, lavkaSync } = syncs()
    await polkaSync.saveConfig({ token: 'github_pat_family', repo: 'me/polka-data' })
    await polkaSync.saveConfig({ tokenExpires: '2027-09-27' })
    await lavkaSync.saveConfig({ repo: 'me/lavka-data' })

    await lavkaSync.forgetToken()

    const seen = await polkaSync.readConfig()
    expect(seen.token).toBe('')
    expect(seen.tokenExpires).toBeNull()
    // Имена остаются: забывается доступ, а не то, куда синхронизироваться.
    expect(seen.repo).toBe('me/polka-data')
    expect(seen.enabled).toBe(false)
  })

  it('забытый токен не переезжает обратно из своих полей следующим запуском', async () => {
    await polka.settings.set('syncToken', 'github_pat_old')
    await polka.settings.set('syncRepo', 'me/polka-data')
    await syncs().polkaSync.readConfig()

    await syncs().polkaSync.forgetToken()

    // Новый запуск — новый экземпляр синхронизации, переезд снова проверяется.
    expect((await syncs().polkaSync.readConfig()).token).toBe('')
  })
})

describe('переезд давнего токена (Я-35, Я-41)', () => {
  it('в общей пусто — туда переезжает своё, свои поля удаляются', async () => {
    await polka.settings.set('syncEnabled', true)
    await polka.settings.set('syncToken', 'github_pat_old')
    await polka.settings.set('syncTokenExpires', '2026-12-01')
    await polka.settings.set('syncRepo', 'me/polka-data')
    await polka.settings.set('syncBranch', 'main')

    const seen = await syncs().polkaSync.readConfig()
    expect(seen).toEqual({
      enabled: true,
      repo: 'me/polka-data',
      token: 'github_pat_old',
      branch: 'main',
      tokenExpires: '2026-12-01',
    })

    expect(await family.read()).toEqual({
      token: 'github_pat_old',
      expires: '2026-12-01',
      repos: { polka: 'me/polka-data' },
    })
    expect(await polka.settings.get('syncToken')).toBeUndefined()
    expect(await polka.settings.get('syncTokenExpires')).toBeUndefined()
    expect(await polka.settings.get('syncRepo')).toBeUndefined()
    // Своё остаётся своим.
    expect(await polka.settings.get('syncEnabled')).toBe(true)
    expect(await polka.settings.get('syncBranch')).toBe('main')
  })

  it('в общей занято — общая побеждает, свои поля всё равно удаляются', async () => {
    await family.setToken('github_pat_family')
    await family.setExpires('2027-09-27')
    await family.setRepo('polka', 'me/polka-data')

    await polka.settings.set('syncToken', 'github_pat_old')
    await polka.settings.set('syncTokenExpires', '2026-10-01')
    await polka.settings.set('syncRepo', 'me/polka-old')

    const seen = await syncs().polkaSync.readConfig()
    expect(seen.token).toBe('github_pat_family')
    expect(seen.tokenExpires).toBe('2027-09-27')
    expect(seen.repo).toBe('me/polka-data')
    expect(await polka.settings.get('syncToken')).toBeUndefined()
    expect(await polka.settings.get('syncRepo')).toBeUndefined()
  })

  it('токен занят, а своего имени в общей нет — переезжает только имя', async () => {
    await family.setToken('github_pat_family')
    await polka.settings.set('syncToken', 'github_pat_old')
    await polka.settings.set('syncTokenExpires', '2026-10-01')
    await polka.settings.set('syncRepo', 'me/polka-data')

    await syncs().polkaSync.readConfig()
    // Срок прежнего токена к общему не приклеивается.
    expect(await family.read()).toEqual({ token: 'github_pat_family', expires: null, repos: { polka: 'me/polka-data' } })
  })

  it('два приложения переезжают разом — токен один, имена оба', async () => {
    await polka.settings.set('syncToken', 'github_pat_polka')
    await polka.settings.set('syncRepo', 'me/polka-data')
    await lavka.settings.set('syncToken', 'github_pat_lavka')
    await lavka.settings.set('syncRepo', 'me/lavka-data')

    const { polkaSync, lavkaSync } = syncs()
    const [a, b] = await Promise.all([polkaSync.readConfig(), lavkaSync.readConfig()])

    expect(a.token).toBe(b.token)
    expect(['github_pat_polka', 'github_pat_lavka']).toContain(a.token)
    expect((await family.read()).repos).toEqual({ polka: 'me/polka-data', lavka: 'me/lavka-data' })
  })
})

describe('«включено» (Я-37, Я-42)', () => {
  it('токен и своё имя есть, своего «включено» нет — включена', async () => {
    await family.setToken('github_pat_family')
    await family.setRepo('lavka', 'me/lavka-data')

    const { lavkaSync } = syncs()
    expect((await lavkaSync.readConfig()).enabled).toBe(true)
    // Вычислено, а не записано.
    expect(await lavka.settings.get('syncEnabled')).toBeUndefined()
  })

  it('выключил человек — остаётся выключенной', async () => {
    await family.setToken('github_pat_family')
    await family.setRepo('lavka', 'me/lavka-data')
    const { lavkaSync } = syncs()
    await lavkaSync.saveConfig({ enabled: false })

    expect((await lavkaSync.readConfig()).enabled).toBe(false)
  })

  it('без своего имени — выключена, хоть токен и есть', async () => {
    await family.setToken('github_pat_family')
    await family.setRepo('polka', 'me/polka-data')
    expect((await syncs().lavkaSync.readConfig()).enabled).toBe(false)
  })

  it('имя стёрли — снова выключена', async () => {
    await family.setToken('github_pat_family')
    await family.setRepo('lavka', 'me/lavka-data')
    const { lavkaSync } = syncs()
    expect((await lavkaSync.readConfig()).enabled).toBe(true)

    await family.setRepo('lavka', '')
    expect((await lavkaSync.readConfig()).enabled).toBe(false)
  })
})

describe('метаприложение без синхронизации (Я-29, Я-37)', () => {
  it('читает токен из общей базы помощником ядра', async () => {
    const { polkaSync } = syncs()
    await polkaSync.saveConfig({ token: 'github_pat_family' })
    await itogi.ready()

    expect((await family.read()).token).toBe('github_pat_family')
  })

  it('имена пишет только в пустые места и говорит, какие записал', async () => {
    await family.setRepo('polka', 'me/polka-mine')

    const written = await family.fillRepos({ polka: 'me/polka-data', lavka: ' me/lavka-data ', dacha: '' })

    expect(written).toEqual(['lavka'])
    expect((await family.read()).repos).toEqual({ polka: 'me/polka-mine', lavka: 'me/lavka-data' })
  })

  it('занятое место — только явным действием', async () => {
    await family.setRepo('polka', 'me/polka-mine')
    await family.setRepo('polka', 'me/polka-data')
    expect((await family.read()).repos.polka).toBe('me/polka-data')
  })

  it('пустая общая база читается как пустая, а не падает', async () => {
    expect(await family.read()).toEqual({ token: null, expires: null, repos: {} })
  })
})

describe('соседи (Я-40)', () => {
  it('приложение на старом ядре рядом не ломается: его поля не тронуты, база открывается', async () => {
    // «Лавка» ещё на старом ядре: токен — своим полем.
    await lavka.settings.set('syncEnabled', true)
    await lavka.settings.set('syncToken', 'github_pat_lavka')
    await lavka.settings.set('syncRepo', 'me/lavka-data')
    await lavka.close()

    // «Полка» на новом — переезжает и пишет в общую.
    await polka.settings.set('syncToken', 'github_pat_polka')
    await syncs().polkaSync.readConfig()

    expect(await lavka.settings.get('syncToken')).toBe('github_pat_lavka')
    expect(await lavka.settings.get('syncRepo')).toBe('me/lavka-data')
    expect(await lavka.settings.get('syncEnabled')).toBe(true)
  })

  it('база, поднятая будущим ядром до версии 2, открывается и читается', async () => {
    await family.setToken('github_pat_family')

    // Будущее ядро добавило хранилище — так Я-40 разрешает её менять.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('family', 2)
      request.onupgradeneeded = () => request.result.createObjectStore('later', { keyPath: 'key' })
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })

    expect((await family.read()).token).toBe('github_pat_family')
    await family.setRepo('polka', 'me/polka-data')
    expect((await family.read()).repos).toEqual({ polka: 'me/polka-data' })
  })

  it('общая база не держит соединение: сосед поднимает её версию без ожидания', async () => {
    await family.setToken('github_pat_family')
    const blocked = await new Promise<boolean>((resolve, reject) => {
      let wasBlocked = false
      const request = indexedDB.open('family', 2)
      request.onblocked = () => {
        wasBlocked = true
      }
      request.onsuccess = () => {
        request.result.close()
        resolve(wasBlocked)
      }
      request.onerror = () => reject(request.error)
    })
    expect(blocked).toBe(false)
  })
})
