/**
 * Генератор иконок PWA из геометрии public/favicon.svg приложения.
 *
 * Растеризатор и PNG — общие; цвет и рисунок — приложения (Р-48 «Трапезы»).
 * Его `scripts/icons.mjs` описывает свои фигуры и зовёт `writeIcons`:
 *
 *   import { writeIcons, BACKGROUND, INK } from '../src/shared/scripts/icons.mjs'
 *   const ACCENT = [0x7c, 0xcf, 0x8a]
 *   writeIcons({ out: 'public', shapes: [{ x: 74, y: 116, w: 280, h: 280, r: 140, color: ACCENT, alpha: 1 }, …] })
 *
 * Запускается руками (`npm run icons`), результат коммитится. В сборку
 * не входит: иконка меняется раз в год, гонять растеризатор на каждом
 * деплое незачем.
 *
 * Почему свой, а не @vite-pwa/assets-generator: тот тянет sharp, sharp
 * тянет libvips, у которого на сегодня четыре CVE. Ради четырёх плоских
 * картинок из прямоугольников это несоразмерная цена. Здесь только zlib
 * из стандартной библиотеки.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Пространство рисования. Совпадает с viewBox в favicon.svg. */
const DESIGN = 512

/** Фон иконки — общий у всей семьи; акцент у каждого приложения свой. */
export const BACKGROUND = [0x1b, 0x1c, 0x1e]
const CORNER_RADIUS = 112

/** Цвет штрихов поверх фона. Акцент — у приложения: иконки на одном телефоне не должны путаться. */
export const INK = [0xec, 0xec, 0xee]

/**
 * Фигуры иконки — у приложения: те же, что в его favicon.svg, расходиться им
 * нельзя. Фигура — скруглённый прямоугольник `{ x, y, w, h, r, color, alpha }`
 * в пространстве 512×512. Круг — прямоугольник с радиусом в половину стороны,
 * кольцо — круг цвета фона поверх круга акцента. Всё внутри безопасной зоны
 * maskable: круга в 80% стороны, который система не обрежет никогда.
 */

/** Сглаживание перебором: 4×4 выборки на пиксель. */
const SUPERSAMPLE = 4

function insideRoundedRect(x, y, rect) {
  const cx = Math.min(Math.max(x, rect.x + rect.r), rect.x + rect.w - rect.r)
  const cy = Math.min(Math.max(y, rect.y + rect.r), rect.y + rect.h - rect.r)
  return Math.hypot(x - cx, y - cy) <= rect.r
}

/** Доля пикселя, покрытая фигурой: 0..1. */
function coverage(px, py, rect, scale) {
  let hits = 0
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const x = (px + (sx + 0.5) / SUPERSAMPLE) / scale
      const y = (py + (sy + 0.5) / SUPERSAMPLE) / scale
      if (insideRoundedRect(x, y, rect)) hits++
    }
  }
  return hits / (SUPERSAMPLE * SUPERSAMPLE)
}

function paint(pixels, size, rect, color, alpha, scale) {
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const a = coverage(px, py, rect, scale) * alpha
      if (a === 0) continue

      const i = (py * size + px) * 4
      for (let c = 0; c < 3; c++) {
        pixels[i + c] = Math.round(color[c] * a + pixels[i + c] * (1 - a))
      }
      pixels[i + 3] = Math.round(255 * a + pixels[i + 3] * (1 - a))
    }
  }
}

/**
 * @param size сторона в пикселях
 * @param rounded скруглять ли подложку. Для maskable — нет: систему
 *   интересует полное заполнение квадрата, обрезает она сама, и своё
 *   скругление внутри её маски даёт заметный тёмный ободок.
 */
function render(size, rounded, shapes, background) {
  const scale = size / DESIGN
  const pixels = new Uint8Array(size * size * 4)

  const backdrop = rounded
    ? { x: 0, y: 0, w: DESIGN, h: DESIGN, r: CORNER_RADIUS }
    : { x: 0, y: 0, w: DESIGN, h: DESIGN, r: 0 }

  paint(pixels, size, backdrop, background, 1, scale)
  for (const shape of shapes) {
    paint(pixels, size, shape, shape.color, shape.alpha, scale)
  }

  return pixels
}

// ─── Кодирование PNG ───────────────────────────────────────────────────────

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // бит на канал
  header[9] = 6 // RGBA
  // сжатие, фильтрация, чересстрочность — стандартные нули

  // Каждой строке предшествует байт фильтра. 0 — без фильтра:
  // картинка из сплошных заливок и так жмётся хорошо.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ─── Сборка ────────────────────────────────────────────────────────────────

const TARGETS = [
  { file: 'pwa-192x192.png', size: 192, rounded: true },
  { file: 'pwa-512x512.png', size: 512, rounded: true },
  { file: 'maskable-icon-512x512.png', size: 512, rounded: false },
  { file: 'apple-touch-icon-180x180.png', size: 180, rounded: false },
]

/**
 * Пишет четыре иконки приложения в папку `out` (обычно `public`).
 * `shapes` — фигуры приложения; `background` — фон, по умолчанию общий.
 */
export function writeIcons({ out, shapes, background = BACKGROUND }) {
  mkdirSync(out, { recursive: true })

  for (const target of TARGETS) {
    const png = encodePng(target.size, render(target.size, target.rounded, shapes, background))
    writeFileSync(join(out, target.file), png)
    console.log(`${target.file} — ${target.size}×${target.size}, ${png.length} байт`)
  }
}
