/**
 * Что сказать человеку после «Проверить доступ» (`SyncSettings`).
 *
 * Права fine-grained токена GitHub не сообщает (Я-28): `canWrite` — это
 * права аккаунта на репозиторий, у владельца всегда true. Поэтому «можно»
 * здесь не обещается: токен Read-only поймает первая отправка своим 403.
 * «Нельзя» — правда: аккаунт без записи не пишет ни с каким токеном.
 */

import type { RepoInfo } from '../core/github.ts'

export function accessWords(access: RepoInfo, branch: string): { note: string; error: string } {
  const parts = [
    `Репозиторий ${access.fullName} найден`,
    access.private ? 'приватный' : 'ПУБЛИЧНЫЙ — данные увидят все',
  ]
  if (access.defaultBranch !== branch) {
    parts.push(`ветка по умолчанию — ${access.defaultBranch}`)
  }
  const found = `${parts.join(', ')}.`

  if (!access.canWrite) {
    return {
      note: found,
      error:
        'У аккаунта, выпустившего токен, писать в этот репозиторий нельзя. ' +
        'Нужен токен владельца репозитория с «Contents: Read and write».',
    }
  }
  return {
    note:
      `${found} Права токена GitHub не сообщает: «Contents: Read and write» ` +
      'выбирается при выпуске, а если его нет — скажет первая отправка.',
    error: '',
  }
}
