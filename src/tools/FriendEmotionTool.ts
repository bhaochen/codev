/**
 * FriendEmotionTool — VRM avatar emotion control for Friend desktop pet.
 *
 * Allows the LLM to set the VRM avatar's facial expression and adjust
 * its own mood index. Native VersperClaw tool.
 */
import { z } from 'zod';
import { buildTool, type ToolDef } from '../Tool.js';
import { broadcastToVrm } from '../friend/sse.js';
import { VALID_EMOTIONS } from '../friend/constants.js';
import { lazySchema } from '../utils/lazySchema.js';
import { getPrefs, setPrefs } from '../friend/prefs.js';

export const FRIEND_EMOTION_TOOL_NAME = 'friend_emotion';

const inputSchema = lazySchema(() =>
  z.strictObject({
    emotion: z
      .string()
      .describe(`The emotion to express on the avatar. One of: ${VALID_EMOTIONS.join(', ')}`),
    intensity: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(1)
      .describe('Emotion intensity from 0 to 1. Default: 1'),
    mood_delta: z
      .number()
      .int()
      .min(-3)
      .max(3)
      .optional()
      .describe(
        'Adjust YOUR OWN mood index as a character. Range: -3 to +3 (minimum absolute value 1). ' +
        'Positive = you feel happier, negative = you feel sadder.',
      ),
  }),
);
type Input = z.infer<ReturnType<typeof inputSchema>>;

type Output = {
  ok: boolean;
  emotion: string;
  moodDelta?: number;
  moodIndex?: number;
};

const MOOD_BASELINE = 60;

export const FriendEmotionTool = buildTool({
  name: FRIEND_EMOTION_TOOL_NAME,
  searchHint: 'control VRM avatar emotion and mood',
  userFacingName: () => 'Friend Emotion',
  get inputSchema() {
    return inputSchema();
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return true;
  },
  async description() {
    return (
      `Set the avatar's facial expression and adjust your own mood index. Call AFTER your text reply. ` +
      `Available emotions: ${VALID_EMOTIONS.join(', ')}. ` +
      `You must also set mood_delta (-3 to +3, min ±1) to reflect how the conversation makes YOU feel as a character. ` +
      `Positive delta when you feel happy/flattered/excited, negative when you feel sad/annoyed/bored. ` +
      `Always include mood_delta — it represents YOUR emotional reaction.`
    );
  },
  async call({ emotion, intensity, mood_delta }) {
    broadcastToVrm({ emotion, emotionIntensity: intensity });

    let moodDelta: number | undefined;
    let moodIndex: number | undefined;

    if (mood_delta !== undefined) {
      let d = Math.round(mood_delta);
      if (d > 0) d = Math.max(1, Math.min(3, d));
      else if (d < 0) d = Math.min(-1, Math.max(-3, d));
      else d = 1;
      moodDelta = d;

      const prefs = getPrefs();
      const currentMood = (prefs as any)._moodIndex ?? MOOD_BASELINE;
      const newMood = Math.max(0, Math.min(100, currentMood + d));
      (prefs as any)._moodIndex = newMood;
      moodIndex = newMood;
      setPrefs(prefs);

      broadcastToVrm({ moodDelta: d, moodIndex: newMood });
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Avatar emotion set to ${emotion}.${
          moodDelta !== undefined
            ? ` Your mood ${moodDelta > 0 ? '+' : ''}${moodDelta} → ${moodIndex}%`
            : ''
        }`,
      }],
    };
  },
} satisfies ToolDef<Input, Output>);
