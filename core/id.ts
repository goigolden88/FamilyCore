/**
 * ULID — идентификатор записи.
 *
 * 26 символов: 10 символов времени в миллисекундах + 16 случайных.
 * Кодировка — Crockford base32 (без I, L, O, U, чтобы не путались с 1 и 0).
 *
 * Смысл выбора: лексикографическая сортировка совпадает с хронологической.
 * Список записей упорядочен по id без отдельного поля времени создания.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16
const RANDOM_BYTES = 10 // 80 бит случайности

export const ULID_LEN = TIME_LEN + RANDOM_LEN

/**
 * Монотонность в пределах одной миллисекунды.
 *
 * Без неё записи, созданные в одну миллисекунду, сортируются случайно —
 * а именно так выглядит импорт данных из Obsidian, где сотня событий
 * создаётся в цикле. Внутри той же миллисекунды случайная часть
 * не генерируется заново, а увеличивается на единицу.
 */
let lastTime = -1
let lastRandom = new Uint8Array(RANDOM_BYTES)

function randomBytes(): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(RANDOM_BYTES)
  crypto.getRandomValues(bytes)
  return bytes
}

/** Увеличивает 80-битное число на единицу. false — переполнение. */
function increment(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const byte = bytes[i] ?? 0
    if (byte < 0xff) {
      bytes[i] = byte + 1
      return true
    }
    bytes[i] = 0
  }
  return false
}

function encodeTime(ms: number): string {
  let out = ''
  let rest = ms
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING.charAt(rest % 32) + out
    rest = Math.floor(rest / 32)
  }
  return out
}

function encodeRandom(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i++) {
    // Пятибитная группа может лежать на границе двух байт,
    // поэтому читаем окно в 16 бит и вырезаем из него нужные пять.
    const bit = i * 5
    const index = bit >> 3
    const offset = bit & 7
    const hi = bytes[index] ?? 0
    const lo = bytes[index + 1] ?? 0
    out += ENCODING.charAt((((hi << 8) | lo) >> (11 - offset)) & 31)
  }
  return out
}

/** Новый идентификатор. */
export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    if (!increment(lastRandom)) {
      // Переполнение 80 бит внутри одной миллисекунды практически
      // невозможно, но молча ломать порядок нельзя — берём новые байты.
      lastRandom = randomBytes()
    }
  } else {
    lastTime = now
    lastRandom = randomBytes()
  }
  return encodeTime(now) + encodeRandom(lastRandom)
}

/** Время создания, зашитое в идентификатор. null — строка не ULID. */
export function ulidTime(id: string): number | null {
  if (!isUlid(id)) return null
  let ms = 0
  for (let i = 0; i < TIME_LEN; i++) {
    ms = ms * 32 + ENCODING.indexOf(id.charAt(i))
  }
  return ms
}

export function isUlid(value: string): boolean {
  if (value.length !== ULID_LEN) return false
  for (const char of value) {
    if (!ENCODING.includes(char)) return false
  }
  return true
}
