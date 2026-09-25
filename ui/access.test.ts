import { describe, expect, it } from 'vitest'
import type { RepoInfo } from '../core/github.ts'
import { accessWords } from './access.ts'

const info: RepoInfo = {
  fullName: 'goigolden88/polka-data',
  private: true,
  canWrite: true,
  defaultBranch: 'main',
}

// Я-28: `canWrite` — права аккаунта, не fine-grained токена. У владельца он
// всегда true, и токен Read-only прежде получал «запись разрешена».

describe('accessWords — «Проверить доступ» (Я-28)', () => {
  it('полное имя и приватность — первыми', () => {
    expect(accessWords(info, 'main').note).toMatch(/^Репозиторий goigolden88\/polka-data найден, приватный/)
  })

  it('право аккаунта не выдаётся за право токена', () => {
    const { note, error } = accessWords(info, 'main')
    expect(note).not.toContain('запись разрешена')
    expect(note).toMatch(/права токена GitHub не сообщает/i)
    expect(note).toContain('Contents: Read and write')
    expect(error).toBe('')
  })

  it('аккаунту писать нельзя — ошибка, и это правда', () => {
    const { note, error } = accessWords({ ...info, canWrite: false }, 'main')
    expect(note).not.toMatch(/права токена GitHub не сообщает/i)
    expect(error).toContain('писать в этот репозиторий нельзя')
  })

  it('публичный репозиторий — крупно', () => {
    expect(accessWords({ ...info, private: false }, 'main').note).toContain('ПУБЛИЧНЫЙ')
  })

  it('ветка по умолчанию названа, только если она не та', () => {
    expect(accessWords(info, 'main').note).not.toContain('ветка по умолчанию')
    expect(accessWords(info, 'data').note).toContain('ветка по умолчанию — main')
  })
})
