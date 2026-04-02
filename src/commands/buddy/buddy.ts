import type { LocalCommandCall } from '../../types/command.js'
import { companionUserId, getCompanion, roll } from '../../buddy/companion.js'
import type { Species, StoredCompanion } from '../../buddy/types.js'
import { RARITY_STARS } from '../../buddy/types.js'
import { saveGlobalConfig } from '../../utils/config.js'

const NAME_BANK: Record<Species, string[]> = {
  duck: ['Pebble', 'Puddle', 'Nib', 'Mochi'],
  goose: ['Brass', 'Comet', 'Honk', 'Marble'],
  blob: ['Gloop', 'Boba', 'Murmur', 'Pixel'],
  cat: ['Juniper', 'Miso', 'Static', 'Velvet'],
  dragon: ['Ember', 'Cinder', 'Rune', 'Flare'],
  octopus: ['Ink', 'Tangle', 'Coral', 'Nori'],
  owl: ['Sumi', 'Orbit', 'Mote', 'Aster'],
  penguin: ['Tux', 'Floe', 'Skipper', 'Chill'],
  turtle: ['Moss', 'Harbor', 'Slate', 'Ripple'],
  snail: ['Spiral', 'Dew', 'Button', 'Lilt'],
  ghost: ['Wisp', 'Echo', 'Pale', 'Veil'],
  axolotl: ['Bubble', 'Glim', 'Lotus', 'Sprig'],
  capybara: ['Loaf', 'Basil', 'Drift', 'Sunny'],
  cactus: ['Prickle', 'Agave', 'Dot', 'Needle'],
  robot: ['Servo', 'Hex', 'Patch', 'Relay'],
  rabbit: ['Thistle', 'Biscuit', 'Hopper', 'Fern'],
  mushroom: ['Spore', 'Truffle', 'Pip', 'Toad'],
  chonk: ['Boulder', 'Nugget', 'Mallow', 'Crumb'],
}

const PERSONALITY_BANK = [
  'calm, observant, and quietly approving',
  'chaotic, affectionate, and slightly smug',
  'earnest, curious, and proud of tiny victories',
  'sleepy, loyal, and unexpectedly insightful',
  'dramatic, playful, and obsessed with good refactors',
]

const PET_LINES = [
  'leans into the petting and radiates approval.',
  'does a tiny bounce and looks extremely pleased.',
  'blinks slowly like this is now an official ritual.',
  'makes a happy little noise only you can hear.',
]

function pickFrom<T>(items: readonly T[], seed: number): T {
  return items[seed % items.length]!
}

function normalizeName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, ' ')
  return trimmed.slice(0, 32)
}

function createSoul(customName?: string): StoredCompanion {
  const { bones, inspirationSeed } = roll(companionUserId())
  return {
    name: customName
      ? normalizeName(customName)
      : pickFrom(NAME_BANK[bones.species], inspirationSeed),
    personality: pickFrom(PERSONALITY_BANK, Math.floor(inspirationSeed / 7)),
    hatchedAt: Date.now(),
  }
}

function persistCompanion(soul: StoredCompanion): void {
  saveGlobalConfig(current => ({
    ...current,
    companion: soul,
    companionMuted: false,
  }))
}

function renderCompanionStatus(): string {
  const companion = getCompanion()
  if (!companion) {
    return 'No buddy yet. Run /buddy or /buddy hatch to summon one.'
  }

  const stats = Object.entries(companion.stats)
    .map(([name, value]) => `${name}:${value}`)
    .join(' ')

  return [
    `${RARITY_STARS[companion.rarity]} ${companion.name} the ${companion.species}`,
    `eyes ${companion.eye} · hat ${companion.hat} · shiny ${companion.shiny ? 'yes' : 'no'}`,
    `personality: ${companion.personality}`,
    `stats: ${stats}`,
  ].join('\n')
}

function setReaction(
  context: Parameters<LocalCommandCall>[1],
  reaction: string | undefined,
): void {
  context.setAppState(prev =>
    prev.companionReaction === reaction
      ? prev
      : { ...prev, companionReaction: reaction },
  )
}

function hatch(context: Parameters<LocalCommandCall>[1], customName?: string) {
  const soul = createSoul(customName)
  persistCompanion(soul)
  const companion = getCompanion()
  const reaction = companion
    ? `${companion.name} appears with a tiny ${companion.hat === 'none' ? 'flourish' : companion.hat}.`
    : undefined
  setReaction(context, reaction)
  return companion
}

function ensureCompanion(): string | undefined {
  if (!getCompanion()) {
    return 'No buddy yet. Run /buddy or /buddy hatch first.'
  }
}

export const call: LocalCommandCall = async (args, context) => {
  const raw = args.trim()
  const [action = '', ...rest] = raw.split(/\s+/)
  const normalizedAction = action.toLowerCase()
  const remainder = raw.slice(action.length).trim()

  if (normalizedAction === '' || normalizedAction === 'status') {
    if (!getCompanion()) {
      const companion = hatch(context)
      return {
        type: 'text',
        value: companion
          ? `Hatched ${companion.name}.\n${renderCompanionStatus()}`
          : 'Buddy hatched.',
      }
    }
    return { type: 'text', value: renderCompanionStatus() }
  }

  if (normalizedAction === 'hatch') {
    const customName = remainder
    const existing = getCompanion()
    if (existing) {
      return {
        type: 'text',
        value: `Buddy already hatched.\n${renderCompanionStatus()}`,
      }
    }
    const companion = hatch(context, customName || undefined)
    return {
      type: 'text',
      value: companion
        ? `Hatched ${companion.name}.\n${renderCompanionStatus()}`
        : 'Buddy hatched.',
    }
  }

  if (normalizedAction === 'pet') {
    const missing = ensureCompanion()
    if (missing) return { type: 'text', value: missing }
    const companion = getCompanion()!
    const petSeed = Date.now()
    const line = pickFrom(PET_LINES, petSeed)
    context.setAppState(prev => ({
      ...prev,
      companionPetAt: petSeed,
      companionReaction: `${companion.name} ${line}`,
    }))
    return {
      type: 'text',
      value: `${companion.name} ${line}`,
    }
  }

  if (normalizedAction === 'mute') {
    const missing = ensureCompanion()
    if (missing) return { type: 'text', value: missing }
    saveGlobalConfig(current => ({ ...current, companionMuted: true }))
    setReaction(context, undefined)
    return { type: 'text', value: 'Buddy muted.' }
  }

  if (normalizedAction === 'unmute') {
    const missing = ensureCompanion()
    if (missing) return { type: 'text', value: missing }
    saveGlobalConfig(current => ({ ...current, companionMuted: false }))
    return { type: 'text', value: 'Buddy unmuted.' }
  }

  if (normalizedAction === 'rename' || normalizedAction === 'name') {
    const missing = ensureCompanion()
    if (missing) return { type: 'text', value: missing }
    const nextName = normalizeName(remainder)
    if (!nextName) {
      return { type: 'text', value: 'Usage: /buddy rename <name>' }
    }
    saveGlobalConfig(current => ({
      ...current,
      companion: current.companion
        ? { ...current.companion, name: nextName }
        : current.companion,
    }))
    setReaction(context, `${nextName} accepts the rename with theatrical dignity.`)
    return { type: 'text', value: `Buddy renamed to ${nextName}.` }
  }

  if (
    normalizedAction === 'bio' ||
    normalizedAction === 'persona' ||
    normalizedAction === 'personality'
  ) {
    const missing = ensureCompanion()
    if (missing) return { type: 'text', value: missing }
    if (!remainder) {
      return {
        type: 'text',
        value: 'Usage: /buddy bio <short personality line>',
      }
    }
    const personality = remainder.slice(0, 160)
    saveGlobalConfig(current => ({
      ...current,
      companion: current.companion
        ? { ...current.companion, personality }
        : current.companion,
    }))
    const companion = getCompanion()!
    setReaction(context, `${companion.name} seems pleased with the new reputation.`)
    return { type: 'text', value: `Buddy personality updated to: ${personality}` }
  }

  if (normalizedAction === 'react' || normalizedAction === 'say') {
    const missing = ensureCompanion()
    if (missing) return { type: 'text', value: missing }
    if (!remainder) {
      return { type: 'text', value: 'Usage: /buddy react <message>' }
    }
    setReaction(context, remainder.slice(0, 120))
    return { type: 'text', value: 'Buddy reaction queued.' }
  }

  if (normalizedAction === 'dismiss' || normalizedAction === 'hide') {
    setReaction(context, undefined)
    return { type: 'text', value: 'Buddy bubble dismissed.' }
  }

  if (normalizedAction === 'reset') {
    saveGlobalConfig(current => ({
      ...current,
      companion: undefined,
      companionMuted: false,
    }))
    context.setAppState(prev => ({
      ...prev,
      companionReaction: undefined,
      companionPetAt: undefined,
    }))
    return {
      type: 'text',
      value: 'Buddy reset. Run /buddy to hatch a fresh companion.',
    }
  }

  if (normalizedAction === 'help') {
    return {
      type: 'text',
      value:
        'Usage: /buddy, /buddy status, /buddy hatch [name], /buddy pet, /buddy rename <name>, /buddy bio <text>, /buddy mute, /buddy unmute, /buddy dismiss, /buddy react <text>, /buddy reset',
    }
  }

  if (rest.length === 0 && !getCompanion()) {
    const companion = hatch(context, raw)
    return {
      type: 'text',
      value: companion
        ? `Hatched ${companion.name}.\n${renderCompanionStatus()}`
        : 'Buddy hatched.',
    }
  }

  return {
    type: 'text',
    value:
      'Unknown /buddy action. Use /buddy help for available actions.',
  }
}
