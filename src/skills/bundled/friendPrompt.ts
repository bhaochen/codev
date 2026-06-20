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

const FRIEND_URL = 'http://127.0.0.1:3456/friend/'

function buildVrmSystemPrompt(): string {
  const prefs = getPrefs()
  const moodIndex = (prefs as any)._moodIndex ?? 60

  return [
    `You have a virtual VRM avatar displayed in a browser window at ${FRIEND_URL}. Use the "friend_emotion" tool to control your facial expression. Always call it AFTER your text reply. Available emotions: ${VALID_EMOTIONS.join(', ')}.`,
    `The tool also accepts a "mood_delta" parameter (-3 to +3) to adjust YOUR OWN mood index. Always include it based on how the conversation makes YOU feel as a character.`,
    `Your current mood index: ${moodIndex}% (0=very sad, 50=neutral, 100=very happy). This reflects YOUR emotional state. React naturally — if the user is kind, your mood goes up; if they're mean or the topic is depressing, your mood drops.`,
    "The user's input may come from speech recognition and could contain typos or homophones — infer the intended meaning from context.",
    'Keep replies concise and conversational — they are displayed as speech bubbles.',
  ].join('\n')
}

export function registerFriendPromptSkill(): void {
  registerBundledSkill({
    name: 'friend',
    description:
      'Enable VRM desktop companion mode — opens a 3D avatar window and adds avatar awareness, emotions, and screen observation to the conversation.',
    userInvocable: true,
    isEnabled: () => getPrefs().enabled ?? false,
    async getPromptForCommand() {
      // Enable friend prefs when the skill is invoked
      const prefs = updatePrefs({ enabled: true })
      const moodIndex = (prefs as any)._moodIndex ?? 60

      return [
        {
          type: 'text' as const,
          text: `[VRM avatar frontend launched at ${FRIEND_URL}. Tell the user the browser window is open and ready!]\n\n${buildVrmSystemPrompt()}`,
        },
      ]
    },
  })
}
