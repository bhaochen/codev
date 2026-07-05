/**
 * FriendEmotionTool — VRM avatar emotion control for Friend desktop pet.
 *
 * Allows the LLM to set the VRM avatar's facial expression and adjust
 * its own mood index. Native Codev tool.
 */
import { z } from 'zod';
import { buildTool, type ToolDef } from '../Tool.js';
import { broadcastToVrm } from '../friend/sse.js';
import { VALID_EMOTIONS } from '../friend/constants.js';
import { lazySchema } from '../utils/lazySchema.js';
import { getPrefs, setPrefs } from '../friend/prefs.js';

// Action names from motion-controller.ts actionPresets
const VALID_ACTIONS = [
  'akimbo', 'playFingers', 'scratchHead', 'stretch',
  'happy', 'angry', 'greeting', 'excited', 'shy',
  'point', 'salute', 'angryPump',
] as const;

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
    action: z
      .string()
      .optional()
      .describe(`A specific body gesture to perform (in addition to the facial expression). One of: ${VALID_ACTIONS.join(', ')}. Omit to let the emotion auto-map to a default action.`),
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
      `Set the avatar's facial expression and optionally trigger a specific body gesture. Call AFTER your text reply. ` +
      `Available emotions: ${VALID_EMOTIONS.join(', ')}. ` +
      `Available actions: ${VALID_ACTIONS.join(', ')}. ` +
      `Use the "action" parameter when you want a specific gesture (e.g. scratchHead for thinking, wave for greeting, point for emphasis). ` +
      `If omitted, the emotion will auto-map to a default action. ` +
      `You must also set mood_delta (-3 to +3, min ±1) to reflect how the conversation makes YOU feel as a character. ` +
      `Positive delta when you feel happy/flattered/excited, negative when you feel sad/annoyed/bored. ` +
      `Always include mood_delta — it represents YOUR emotional reaction.`
    );
  },
  async prompt() {
    return (
      `FriendEmotionTool: set avatar emotion + action. Parameters: emotion (one of: ${VALID_EMOTIONS.join(', ')}), intensity (0-1, default 1), action (optional, one of: ${VALID_ACTIONS.join(', ')}), mood_delta (int -3..3) — call AFTER your textual reply.`
    );
  },
  async call({ emotion, intensity, action, mood_delta }) {
    broadcastToVrm({ emotion, emotionIntensity: intensity, action });

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
      data: {
        ok: true,
        emotion,
        moodDelta,
        moodIndex,
      },
    };
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID: string) {
    // If the tool already returned a ToolResultBlockParam-like object, pass it through
    if (output && (output as any).content) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: (output as any).content,
      }
    }

    // Fallback: produce a simple text block summarizing the result
    const text =
      output && 'emotion' in output
        ? `Avatar emotion set to ${(output as any).emotion}.${
            (output as any).moodDelta !== undefined
              ? ` Your mood ${(output as any).moodDelta > 0 ? '+' : ''}${(output as any).moodDelta} → ${(output as any).moodIndex}%`
              : ''
          }`
        : JSON.stringify(output)

    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [{ type: 'text' as const, text }],
    }
  },
  // Consistent with other tools: set a reasonable persistence threshold
  maxResultSizeChars: 100_000,
  renderToolUseMessage(input: Partial<Input>) {
    const emotion = (input as any)?.emotion
    return emotion ? `Set avatar emotion to ${emotion}` : 'Set avatar emotion'
  },
  renderToolResultMessage(output: Output) {
    if (!output) return null
    const mood = output.moodDelta !== undefined ? ` Your mood ${output.moodDelta > 0 ? '+' : ''}${output.moodDelta} → ${output.moodIndex}%` : ''
    return `Avatar emotion set to ${output.emotion}.${mood}`
  },
  extractSearchText(output: Output) {
    if (!output) return ''
    return `Avatar emotion: ${output.emotion}${output.moodDelta !== undefined ? ` moodDelta:${output.moodDelta} moodIndex:${output.moodIndex}` : ''}`
  },
  isResultTruncated() {
    return false
  },
} satisfies ToolDef<Input, Output>);
