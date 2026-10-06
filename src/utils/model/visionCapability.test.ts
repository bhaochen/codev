import { beforeEach, describe, expect, test } from 'bun:test'
import {
  _resetVisionCapabilityForTest,
  modelAcceptsImages,
  recordModelVision,
  visionFromModelsDevEntry,
} from './visionCapability.js'

beforeEach(() => {
  _resetVisionCapabilityForTest()
})

describe('vision capability evidence', () => {
  test('three states: only a positive answer unlocks images', () => {
    expect(modelAcceptsImages('opencode', 'unknown-model')).toBeUndefined()
    recordModelVision('opencode', 'text-model', false)
    recordModelVision('opencode', 'vision-model', true)
    expect(modelAcceptsImages('opencode', 'text-model')).toBe(false)
    expect(modelAcceptsImages('opencode', 'vision-model')).toBe(true)
  })

  test('suffixes describe routing, not modality', () => {
    recordModelVision('openrouter', 'acme/vision', true)
    expect(modelAcceptsImages('openrouter', 'acme/vision:free')).toBe(true)
    expect(modelAcceptsImages('openrouter', 'acme/vision:nitro')).toBe(true)
  })

  test('the same weights under another provider keep their answer', () => {
    recordModelVision('openrouter', 'acme/vision', true)
    expect(modelAcceptsImages('nvidia', 'acme/vision')).toBe(true)
  })

  test('models.dev-shaped entries yield tri-state evidence', () => {
    expect(visionFromModelsDevEntry({ attachment: true, modalities: { input: ['text', 'image'] } })).toBe(true)
    expect(visionFromModelsDevEntry({ attachment: true, modalities: { input: ['text'] } })).toBe(false)
    expect(visionFromModelsDevEntry({ attachment: false, modalities: { input: ['image'] } })).toBe(false)
    expect(visionFromModelsDevEntry({})).toBeUndefined()
  })
})
