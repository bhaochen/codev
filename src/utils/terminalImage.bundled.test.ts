import { Buffer } from 'buffer'
import { Writable } from 'stream'
import { PNG } from 'pngjs'
import {
  renderGraphicsOverlay,
  resolveGraphicsProtocol,
  setCellPixelSize,
} from './terminalGraphics.js'
import { renderInlineImage } from './terminalImage.js'
import type { DOMElement } from '../ink/dom.js'
import {
  buildGraphicsSequence,
  setGraphicsPlacement,
} from '../ink/graphicsPlacement.js'
import { nodeCache } from '../ink/node-cache.js'
import {
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
} from '../ink/screen.js'
import { writeDiffToTerminal } from '../ink/terminal.js'

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
const protocol = resolveGraphicsProtocol({ TERM: 'xterm-kitty' }, null, true)
if (protocol !== 'kitty') {
  throw new Error(`Kitty terminal was not detected (resolved ${protocol})`)
}
const overlay = await renderGraphicsOverlay(
  PNG.sync.write({ width, height, data: pixels }),
  16,
  4,
  protocol,
  1234,
)
if (
  overlay === null ||
  overlay.protocol !== protocol ||
  !overlay.sequence.startsWith('\x1b_Ga=T,f=100')
) {
  throw new Error('Compiled Kitty graphics overlay was not encoded')
}

const node = {} as DOMElement
nodeCache.set(node, {
  x: 2,
  y: 3,
  width: overlay.columns,
  height: overlay.rows,
})
setGraphicsPlacement('compiled-smoke-image', {
  node,
  sequence: overlay.sequence,
  eraseSequence: overlay.eraseSequence,
  columns: overlay.columns,
  rows: overlay.rows,
  cellWidth: overlay.cellWidth,
  cellHeight: overlay.cellHeight,
})

const stylePool = new StylePool()
const screen = createScreen(
  80,
  24,
  stylePool,
  new CharPool(),
  new HyperlinkPool(),
)
for (let y = 0; y < screen.height; y++) {
  for (let x = 0; x < screen.width; x++) {
    setCellAt(screen, x, y, {
      char: ' ',
      styleId: stylePool.none,
      width: CellWidth.Narrow,
      hyperlink: undefined,
    })
  }
}

const graphics = buildGraphicsSequence({
  cursor: { x: 0, y: 12 },
  viewportTop: 0,
  viewportRows: 24,
  viewportColumns: 80,
  damage: undefined,
  cell: { width: 8, height: 16 },
  scrollback: false,
  screen,
  stylePool,
})
if (!graphics.includes(overlay.sequence)) {
  throw new Error('Compiled graphics placement did not emit the Kitty payload')
}

const writes: Buffer[] = []
const stdout = new Writable({
  write(chunk, _encoding, callback) {
    writes.push(Buffer.from(chunk))
    callback()
  },
})
const stderr = new Writable({
  write(_chunk, _encoding, callback) {
    callback()
  },
})
writeDiffToTerminal(
  { stdout, stderr },
  [{ type: 'stdout', content: graphics }],
  true,
)
const terminalOutput = Buffer.concat(writes).toString()
if (!terminalOutput.includes(overlay.sequence)) {
  throw new Error('Ink terminal writer did not forward the Kitty payload')
}
setGraphicsPlacement('compiled-smoke-image', null)

console.log('Compiled PNG passed protocol detection, placement, and terminal write')
