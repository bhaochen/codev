/**
 * STT file transcription for Friend.
 *
 * Provides file-based transcription using /voice STT providers
 * (Anthropic Voice Stream, Local Whisper, Doubao).
 *
 * Streaming/in-process capture is handled by FriendService.ts
 * (which uses cpal for native in-process audio capture).
 */

import type { FriendPrefs } from './prefs.js';
import {
  connectVoiceStream,
  isVoiceStreamAvailable,
} from '../services/voiceStreamSTT.js';
import {
  connectLocalWhisperStream,
  preloadWhisperModel,
} from '../services/voice/whisperSTT.js';

// ── Types ──────────────────────────────────────────────────────────────

type SttProvider = 'browser' | 'anthropic' | 'local' | 'doubao';

// ── STT connection factory ─────────────────────────────────────────────

async function startSttConnection(
  provider: SttProvider,
  language: string | undefined,
  callbacks: {
    onTranscript(text: string, isFinal: boolean): void;
    onError(error: string, opts?: { fatal?: boolean }): void;
    onClose(): void;
    onReady(conn: any): void;
  },
) {
  switch (provider) {
    case 'anthropic': {
      if (!isVoiceStreamAvailable()) {
        callbacks.onError('Anthropic Voice Stream not available (not logged in?)');
        return null;
      }
      const conn = await connectVoiceStream(callbacks, {
        language: language || 'en',
        keyterms: ['code', 'codev'],
      });
      return conn;
    }

    case 'local': {
      await preloadWhisperModel({ language: language || 'en' });
      const conn = await connectLocalWhisperStream(callbacks, {
        language: language || 'en',
      });
      return conn;
    }

    case 'doubao': {
      try {
        const { connectDoubaoStream } = await import(
          '../services/doubaoSTT.js'
        );
        const conn = await connectDoubaoStream(callbacks, {
          language: language || 'zh',
        });
        return conn;
      } catch (err: any) {
        callbacks.onError(`Doubao STT import failed: ${err?.message}`);
        return null;
      }
    }

    default:
      callbacks.onError(`Unknown STT provider: ${provider}`);
      return null;
  }
}

// ── File-based transcription (REST) ────────────────────────────────────

export async function transcribeAudioFile(
  wavBuffer: Buffer,
  prefs: FriendPrefs,
): Promise<{ text: string }> {
  const provider = (prefs.sttProvider || 'browser') as SttProvider;
  const language = prefs.sttLanguage;

  switch (provider) {
    case 'local': {
      const { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } = await import(
        'node:fs'
      );
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tmpDir = mkdtempSync(join(tmpdir(), 'friend-stt-'));
      const wavPath = join(tmpDir, 'input.wav');
      writeFileSync(wavPath, wavBuffer);

      try {
        await preloadWhisperModel({ language: language || 'en' });
        const { connectLocalWhisperStream } = await import(
          '../services/voice/whisperSTT.js'
        );
        const result = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          connectLocalWhisperStream(
            {
              onTranscript(text, _isFinal) {
                chunks.push(Buffer.from(text, 'utf8'));
              },
              onError(error) {
                reject(new Error(error));
              },
              onClose() {
                resolve(Buffer.concat(chunks).toString('utf8'));
              },
              onReady(conn) {
                conn.send(wavBuffer);
                conn.finalize();
              },
            },
            { language: language || 'en' },
          );
        });
        return { text: result };
      } finally {
        try { unlinkSync(wavPath) } catch {}
        try { rmdirSync(tmpDir) } catch {}
      }
    }

    case 'doubao': {
      const { connectDoubaoStream } = await import(
        '../services/doubaoSTT.js'
      );
      const chunks: string[] = [];
      const conn = await connectDoubaoStream(
        {
          onTranscript(text: string, _isFinal: boolean) {
            chunks.push(text);
          },
          onError(_error: string) {},
          onClose() {},
          onReady(c: any) {
            c.send(wavBuffer);
            c.finalize();
          },
        },
        { language: language || 'zh' },
      );
      if (!conn) throw new Error('Doubao STT unavailable');
      await new Promise((r) => setTimeout(r, 1000));
      return { text: chunks.join('') };
    }

    case 'anthropic': {
      // Fall back to local Whisper for file transcription
      return transcribeAudioFile(wavBuffer, { ...prefs, sttProvider: 'local' });
    }

    default:
      throw new Error(`Unsupported STT provider for file transcription: ${provider}`);
  }
}
