/**
 * Text cleaning utilities for Friend VRM avatar.
 */

/**
 * Strip agent's inline thinking/reasoning from text output.
 */
export function stripThinking(text: string): string {
  const lines = text.split('\n');
  const TS_RE = /^\d{2}:\d{2}:\d{2}\s/;

  let lastTsIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (TS_RE.test(lines[i])) {
      lastTsIdx = i;
      break;
    }
  }
  if (lastTsIdx >= 0) {
    lines[lastTsIdx] = lines[lastTsIdx].replace(TS_RE, '');
    const result = lines.slice(lastTsIdx).join('\n').trim();
    if (result) return result;
  }

  const EMOTION_RE = /^(think|happy|sad|angry|surprised|awkward|question|curious|neutral)\s*$/i;
  const REASONING_RE = /^(I'll |I need to |I should |I want to |The user |Time is |Let me |My response|Responding )/i;
  const THINKING_HEADER_RE = /^(\*{0,2}Thinking( Process)?[:\*]|\*{0,2}思考)/i;

  let startIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { startIdx = i + 1; continue; }
    if (EMOTION_RE.test(line)) { startIdx = i + 1; continue; }
    if (THINKING_HEADER_RE.test(line)) { startIdx = i + 1; continue; }
    if (REASONING_RE.test(line)) { startIdx = i + 1; continue; }
    if (/^\d+[\.\)]\s/.test(line)) { startIdx = i + 1; continue; }
    break;
  }

  let result = lines.slice(startIdx).join('\n').trim();
  if (!result) result = text.trim();
  return result.replace(/\[\[\w+\]\]/g, '').trim();
}

/** Strip action/narration text wrapped in *..* or **..***/
export function stripActions(text: string): string {
  return text.replace(/\*{1,2}[^*]+\*{1,2}/g, '').replace(/\n{2,}/g, '\n').trim();
}

/** Strip markdown symbols */
export function stripMarkdown(text: string): string {
  return text.replace(/[*_~`#>]/g, '').trim();
}

/** Strip emoji characters */
export function stripEmoji(text: string): string {
  return text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '').trim();
}

/**
 * Strip text for TTS playback.
 */
export function stripForTts(text: string): string {
  return text
    .replace(/（[^）]*）/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/[_~`#>]/g, '')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .trim();
}

/**
 * Split text into sentences for incremental TTS.
 */
export function splitSentences(text: string): string[] {
  const ellipsisMap: string[] = [];
  const safeText = text.replace(/\.{2,}|…+/g, (match) => {
    const idx = ellipsisMap.length;
    ellipsisMap.push(match);
    return `\x00E${idx}\x00`;
  });

  const parts = safeText.split(/(?<=[。！？；\n.!?;~])\s*/);
  return parts
    .map((s) => {
      let restored = s;
      for (let i = 0; i < ellipsisMap.length; i++) {
        restored = restored.replace(`\x00E${i}\x00`, ellipsisMap[i]);
      }
      return restored.trim();
    })
    .filter((s) => s && !/^[。！？；.!?;~、，,\s]+$/.test(s));
}
