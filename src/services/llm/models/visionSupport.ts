/**
 * Whether a (provider, model) may receive image blocks.
 *
 * Three states, and only a positive answer unlocks pixels:
 *   true      a catalog positively said the model takes image input
 *   false     a catalog positively said it does not
 *   undefined nothing was said
 *
 * `false` and `undefined` fall back to text, which every provider accepts, so
 * a wrong guess can never break a request — at worst it weakens the answer.
 * Evidence comes from the provider catalogs (visionCapability) and the
 * models.dev registry, both filled by the same fetches the /models picker
 * already performs.
 */
import { modelAcceptsImages } from '../../../utils/model/visionCapability.js'
import { getModel } from './registry.js'

export function providerModelSupportsImages(
  provider: string,
  model: string,
): boolean {
  const known = modelAcceptsImages(provider, model)
  if (known !== undefined) return known
  return getModel(model)?.capabilities.vision === true
}
