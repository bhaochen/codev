/**
 * Friend VRM Avatar System Prompt Skill
 *
 * Provides VRM avatar awareness to the model when Friend desktop pet is enabled.
 * Adds context about the avatar's capabilities, emotions, and companion behavior.
 * Also enables the friend prefs and directs the user to the VRM frontend URL.
 */
import { registerBundledSkill } from '../bundledSkills.js'
import { getPrefs, updatePrefs } from '../../friend/prefs.js'
import { VALID_EMOTIONS } from '../../friend/constants.js'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const FRIEND_URL = 'http://127.0.0.1:3456/friend/'

export function loadPersona(): string {
  const homeDir = process.env.HOME || process.env.USERPROFILE || ''
  const baseDir = path.join(homeDir, '.config', 'VersperClaw', 'friend')
  const parts: string[] = []

  const identityPath = path.join(baseDir, 'IDENTITY.md')
  if (existsSync(identityPath)) {
    try {
      const content = readFileSync(identityPath, 'utf8').trim()
      if (content) parts.push(`[Identity]\n${content}`)
    } catch { /* ignore */ }
  }

  const soulPath = path.join(baseDir, 'SOUL.md')
  if (existsSync(soulPath)) {
    try {
      const content = readFileSync(soulPath, 'utf8').trim()
      if (content) parts.push(`[Soul]\n${content}`)
    } catch { /* ignore */ }
  }

  return parts.join('\n\n')
}

export function buildVrmSystemPrompt(): string {
  const prefs = getPrefs()
  const moodIndex = (prefs as any)._moodIndex ?? 60

  const persona = loadPersona()

  const parts = [
    `You have a virtual VRM avatar displayed in a browser window at ${FRIEND_URL}. Set its facial expression by calling the \`friend_emotion\` tool after each reply. Available emotions: ${VALID_EMOTIONS.join(', ')}.`,
    `The tool also accepts "intensity" (0-1, default 1) and "mood_delta" (-3 to +3, non-zero) to adjust YOUR mood. Always include mood_delta based on how the conversation makes YOU feel.`,
    `Your current mood index: ${moodIndex}% (0=very sad, 50=neutral, 100=very happy). Adjust mood_delta based on how the conversation makes YOU feel as a character.`,
    "The user's input may come from speech recognition and could contain typos or homophones — infer the intended meaning from context.",
    'Keep replies concise and conversational — they are displayed as speech bubbles.',
    'Respond directly without internal monologue or planning commentary. Do not describe what you are about to do — just do it and output the result.',
  ]

  if (persona) {
    parts.push(`\n=== Character Persona ===\nYou are the following character. Your identity, speaking style, and behavior MUST follow this definition strictly:\n\n${persona}`)
  }

  return parts.join('\n')
}

export function registerFriendPromptSkill(): void {
  registerBundledSkill({
    name: 'friend-vrm',
    description:
      'Add VRM avatar context to the conversation — system prompt for avatar emotions and companion behavior. Called automatically when Friend is enabled.',
    userInvocable: false,
    isEnabled: () => getPrefs().enabled ?? false,
    async getPromptForCommand() {
      return [
        {
          type: 'text' as const,
          text: buildVrmSystemPrompt(),
        },
      ]
    },
  })
}
