/**
 * Установка иконкой (Р-69): что сказать человеку и что предложить.
 *
 * Совет выбирается чистой функцией из четырёх фактов — открыто ли
 * установленным, установили ли только что, iPhone ли это, предлагает ли
 * браузер установку сам, — и проверяется тестами. Остальное здесь —
 * чтение этих фактов из браузера.
 *
 * Событие `beforeinstallprompt` Chrome присылает один раз и рано, до первого
 * экрана. Поэтому `listenInstall` зовётся из `main.tsx`, до React: подпишись
 * компонент — событие прошло бы мимо.
 */

import { useSyncExternalStore } from 'react'

export type InstallAdvice =
  /** Уже стоит иконкой. */
  | 'installed'
  /** Браузер отдал событие — кнопка «Установить» сработает. */
  | 'prompt'
  /** iPhone или iPad во вкладке: только руками, через «Поделиться». */
  | 'ios'
  /** Браузер установку сам не предлагает — через его меню. */
  | 'manual'

export type InstallFacts = {
  /** Открыто установленным — иконкой, без адресной строки. */
  standalone: boolean
  /** Установили из этой вкладки только что. */
  justInstalled: boolean
  ios: boolean
  canPrompt: boolean
}

export function installAdvice(facts: InstallFacts): InstallAdvice {
  if (facts.standalone || facts.justInstalled) return 'installed'
  // На iPhone кнопки не бывает: Safari события не присылает вовсе.
  if (facts.ios) return 'ios'
  if (facts.canPrompt) return 'prompt'
  return 'manual'
}

/** iPhone или iPad. Новый iPad называет себя Маком — выдаёт его сенсорный экран. */
export function isIos(userAgent: string, platform: string, touchPoints: number): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (platform === 'MacIntel' && touchPoints > 1)
}

// ─── Браузер ───────────────────────────────────────────────────────────────

/** Событие Chrome, которого нет в типах DOM. */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferred: InstallPromptEvent | null = null
let justInstalled = false
let facts: InstallFacts = { standalone: false, justInstalled: false, ios: false, canPrompt: false }
const listeners = new Set<() => void>()

function refresh(): void {
  const legacy = navigator as Navigator & { standalone?: boolean }
  facts = {
    // `standalone` у навигатора — только Safari, у остальных — режим экрана.
    standalone: window.matchMedia('(display-mode: standalone)').matches || legacy.standalone === true,
    justInstalled,
    ios: isIos(navigator.userAgent, navigator.platform, navigator.maxTouchPoints),
    canPrompt: deferred !== null,
  }
  for (const listener of listeners) listener()
}

/** Зовётся один раз из `main.tsx`, до первого экрана. */
export function listenInstall(): void {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Иначе Chrome показывает свою плашку, когда сочтёт нужным; предлагаем
    // мы — в приветствии и в «О приложении».
    event.preventDefault()
    deferred = event as InstallPromptEvent
    refresh()
  })
  window.addEventListener('appinstalled', () => {
    deferred = null
    justInstalled = true
    refresh()
  })
  refresh()
}

async function install(): Promise<void> {
  const event = deferred
  if (!event) return
  // Событие одноразовое: второй `prompt` на нём браузер отвергнет.
  deferred = null
  try {
    await event.prompt()
    await event.userChoice
  } finally {
    refresh()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function snapshot(): InstallFacts {
  return facts
}

export function useInstall(): { advice: InstallAdvice; install: () => Promise<void> } {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot)
  return { advice: installAdvice(current), install }
}
