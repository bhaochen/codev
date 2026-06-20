/**
 * TTS providers for Friend (Edge TTS + Qwen DashScope).
 */
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

export async function edgeTts(opts: { text: string; voice?: string }): Promise<{ success: boolean; audioPath?: string; error?: string }> {
  try {
    const { EdgeTTS } = await import('node-edge-tts');
    const tempDir = mkdtempSync(path.join(tmpdir(), 'friend-tts-'));
    const audioPath = path.join(tempDir, `voice-${Date.now()}.mp3`);
    const tts = new EdgeTTS({ voice: opts.voice || 'zh-CN-XiaoxiaoNeural' });
    await tts.ttsPromise(opts.text, audioPath);
    return { success: true, audioPath };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

const QWEN_TTS_URL_CN = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const QWEN_TTS_URL_INTL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

export async function qwenTts(params: {
  text: string;
  apiKey: string;
  voice?: string;
  model?: string;
  language?: 'zh' | 'en';
}): Promise<{ success: boolean; audioPath?: string; error?: string }> {
  const voice = params.voice || 'Cherry';
  const model = params.model || 'qwen3-tts-flash';
  const lang = params.language || 'zh';

  const endpoint = lang === 'zh' ? QWEN_TTS_URL_CN : QWEN_TTS_URL_INTL;
  const languageType = lang === 'zh' ? 'Chinese' : 'English';

  try {
    const abortCtrl = new AbortController();
    const timeout = setTimeout(() => abortCtrl.abort(), 30_000);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: {
          text: params.text,
          voice,
          language_type: languageType,
        },
      }),
      signal: abortCtrl.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { success: false, error: `[tts:${model}/${voice}] http ${resp.status}: ${errText}` };
    }

    const result = await resp.json() as { output?: { audio?: { url?: string } } };
    const audioUrl: string | undefined = result?.output?.audio?.url;
    if (!audioUrl) {
      return { success: false, error: `[tts:${model}/${voice}] no audio url in response` };
    }

    const audioResp = await fetch(audioUrl);
    if (!audioResp.ok) {
      return { success: false, error: `[tts:${model}/${voice}] download failed: ${audioResp.status}` };
    }
    const audioData = Buffer.from(await audioResp.arrayBuffer());

    const tmpDir = mkdtempSync(path.join(tmpdir(), 'qwen-tts-'));
    const destPath = path.join(tmpDir, `qwen-tts-${Date.now()}.wav`);
    writeFileSync(destPath, audioData);
    return { success: true, audioPath: destPath };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { success: false, error: `[tts:${model}/${voice}] timeout (30s)` };
    }
    return { success: false, error: `[tts:${model}/${voice}] ${err}` };
  }
}

// In-memory audio file registry
const audioFiles = new Map<string, string>();
let audioIdCounter = 0;

export function registerAudioFile(filePath: string): string {
  const id = `${Date.now()}-${++audioIdCounter}`;
  audioFiles.set(id, filePath);
  setTimeout(() => audioFiles.delete(id), 5 * 60 * 1000);
  return id;
}

export function getAudioFile(id: string): string | undefined {
  return audioFiles.get(id);
}
