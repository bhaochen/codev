/**
 * Shared constants for Friend — VersperClaw native plugin.
 */

export const GATEWAY_URL = 'http://127.0.0.1:3456';

export const FRIEND_SESSION_KEY = 'agent:main:main';

export const CHANNEL_ID = 'friend';

export const VALID_EMOTIONS = [
  'happy', 'sad', 'angry', 'surprised', 'think', 'awkward', 'question', 'curious', 'neutral',
  'love', 'flirty', 'greeting', 'relaxed',
] as const;
