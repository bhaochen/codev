import { Buffer } from 'buffer'
import { PNG } from 'pngjs'
import { renderGraphicsOverlay, setCellPixelSize } from './terminalGraphics.js'
import { renderInlineImage } from './terminalImage.js'

const width = 128
const height = 64
const pixels = Buffer.alloc(width * height * 4)
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4
    pixels[offset] = Math.round((x / (width - 1)) * 255)
    pixels[offset + 1] = Math.round((y / (height - 1)) * 255)
    pixels[offset + 2] = 180
    pixels[offset + 3] = 255
  }
}

const rendered = await renderInlineImage(
  PNG.sync.write({ width, height, data: pixels }),
  {
    maxColumns: 16,
    maxRows: 4,
    depth: 'truecolor',
  },
)

if (
  rendered === null ||
  rendered.columns !== 16 ||
  rendered.rows !== 4 ||
  !rendered.lines.some(line => line.includes('\x1b['))
) {
  throw new Error('Compiled terminal image rendering did not produce a PNG preview')
}

console.log('Compiled PNG preview rendered as 16 columns x 4 rows')

setCellPixelSize({ width: 8, height: 16 })
const overlay = await renderGraphicsOverlay(
  PNG.sync.write({ width, height, data: pixels }),
  16,
  4,
  'kitty',
  1234,
)
if (
  overlay === null ||
  overlay.protocol !== 'kitty' ||
  !overlay.sequence.startsWith('\x1b_Ga=T,f=100')
) {
  throw new Error('Compiled Kitty graphics overlay was not encoded')
}

console.log('Compiled PNG emitted as a Kitty pixel-graphics overlay')
