import { maxRowsForViewport } from './imageLayout.js'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

assert(
  maxRowsForViewport(80, {}) > maxRowsForViewport(40, {}),
  'a taller viewport should allow a taller image',
)
assert(maxRowsForViewport(40, {}) >= 16, 'short viewports should retain a floor')
assert(maxRowsForViewport(400, {}) <= 72, 'image rows should be capped')
assert(maxRowsForViewport(0, {}) > 0, 'invalid viewport sizes should fall back')
assert(
  maxRowsForViewport(Number.NaN, {}) > 0,
  'non-finite viewport sizes should fall back',
)
assert(
  maxRowsForViewport(40, { CODEV_INLINE_IMAGE_ROWS: '60' }) === 60,
  'the explicit row budget should be honored',
)
assert(
  maxRowsForViewport(40, { CODEV_INLINE_IMAGE_ROWS: '9999' }) === 72,
  'the explicit row budget should respect the maximum',
)
assert(
  maxRowsForViewport(40, { CODEV_INLINE_IMAGE_ROWS: 'nonsense' }) ===
    maxRowsForViewport(40, {}),
  'invalid overrides should use the viewport-derived budget',
)

console.log('image layout budget tests passed')
