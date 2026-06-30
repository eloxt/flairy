// Generates the tray icons in this directory. Run: `node generate-icons.mjs`
//
// We render them programmatically (no SVG rasterizer / image lib is installed,
// and we don't want to add a build dependency just for three tiny PNGs). A small
// self-contained PNG encoder + 8x supersampling gives clean edges. The mark is a
// blocky "F" in the brand squircle, matching build/icon.svg in spirit:
//   - iconTemplate.png / @2x  → macOS menu-bar template (black tile, F knocked
//                                out; setTemplateImage(true) adapts to light/dark)
//   - icon.png                → colored tray icon for Windows/Linux
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const OUT = path.dirname(new URL(import.meta.url).pathname)

// ---- minimal PNG (RGBA, 8-bit) encoder -------------------------------------
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- geometry (unit square, y down) ----------------------------------------
const R = 0.2237 // Apple continuous-corner ~22.37%
function insideTile(x, y) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false
  const dx = x < R ? R - x : x > 1 - R ? x - (1 - R) : 0
  const dy = y < R ? R - y : y > 1 - R ? y - (1 - R) : 0
  if (dx > 0 && dy > 0) return dx * dx + dy * dy <= R * R
  return true
}
const STEM_X0 = 0.345, STEM_X1 = 0.455, TOP = 0.265, BOT = 0.735
const TOP_ARM_X1 = 0.66, TOP_ARM_Y1 = 0.355
const MID_ARM_X1 = 0.6, MID_ARM_Y0 = 0.475, MID_ARM_Y1 = 0.555
function insideF(x, y) {
  if (x >= STEM_X0 && x <= STEM_X1 && y >= TOP && y <= BOT) return true
  if (x >= STEM_X0 && x <= TOP_ARM_X1 && y >= TOP && y <= TOP_ARM_Y1) return true
  if (x >= STEM_X0 && x <= MID_ARM_X1 && y >= MID_ARM_Y0 && y <= MID_ARM_Y1) return true
  return false
}

// ---- render with SxS supersampling -----------------------------------------
const S = 8
function render(size, kind) {
  const rgba = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px + (sx + 0.5) / S) / size
          const y = (py + (sy + 0.5) / S) / size
          const tile = insideTile(x, y)
          const f = tile && insideF(x, y)
          let sr = 0, sg = 0, sb = 0, sa = 0
          if (kind === 'template') {
            if (tile && !f) sa = 255 // black tile, F transparent
          } else if (f) {
            sr = 0xfd; sg = 0xfc; sb = 0xfb; sa = 255 // cream F
          } else if (tile) {
            sr = 0x19; sg = 0x17; sb = 0x14; sa = 255 // charcoal tile
          }
          r += sr; g += sg; b += sb; a += sa
        }
      }
      const n = S * S
      const i = (py * size + px) * 4
      rgba[i] = Math.round(r / n)
      rgba[i + 1] = Math.round(g / n)
      rgba[i + 2] = Math.round(b / n)
      rgba[i + 3] = Math.round(a / n)
    }
  }
  return encodePng(size, size, rgba)
}

writeFileSync(path.join(OUT, 'iconTemplate.png'), render(16, 'template'))
writeFileSync(path.join(OUT, 'iconTemplate@2x.png'), render(32, 'template'))
writeFileSync(path.join(OUT, 'icon.png'), render(32, 'color'))
console.log('wrote tray icons to', OUT)
