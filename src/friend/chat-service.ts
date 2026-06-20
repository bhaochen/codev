/**
 * FriendChatService — LLM conversation dispatch for Friend VRM desktop pet.
 *
 * Manages a dedicated VersperClaw CLI subprocess session (via ConversationService),
 * captures streaming SDK output, and broadcasts text/TTS through SSE to the
 * VRM frontend using the StreamingTtsTracker pattern.
 */
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { conversationService } from '../server/services/conversationService.js';
import { broadcastToVrm, type VrmBroadcastPayload } from './sse.js';
import { edgeTts, qwenTts, registerAudioFile } from './tts.js';
import { stripForTts, splitSentences } from './text-utils.js';
import { getPrefs } from './prefs.js';

const SESSION_ID = 'friend';

// ── StreamingTtsTracker ──────────────────────────────────────────────────────
//
// Adapted from friend/src/channel.ts (OpenClaw version). Receives accumulated
// text, detects sentence boundaries, generates TTS for completed sentences, and
// broadcasts via the VRM SSE pipeline in the correct order.

class StreamingTtsTracker {
  private sentencesSent = 0;
  private audioDispatched = 0;
  private accumulatedText = '';
  private resolveFirstSent!: () => void;
  private firstSentPromise = new Promise<void>((r) => { this.resolveFirstSent = r; });
  private finalized = false;

  private static readonly FIRST_TTS_TIMEOUT_MS = 5000;
  private static readonly SENTENCE_END_RE = /[。！？；!?;~]$/;

  constructor(
    private onSendFirstTts: (text: string, audioUrl: string | undefined) => void,
    private onAppendSentence: (text: string, audioUrl: string | undefined, index: number) => void,
    private onReplyDone: () => void,
  ) {}

  /** Feed accumulated streaming text. May be called many times as text arrives. */
  processPartial(partialText: string): void {
    if (this.finalized) return;
    this.accumulatedText = partialText;
    if (this.audioDispatched > 0) return;

    const sentences = splitSentences(partialText);
    if (sentences.length === 0) return;

    // Consider the first N-1 sentences as complete if the last sentence is
    // still incomplete (no sentence-ending punctuation).
    const lastComplete =
      sentences.length > 1
        ? sentences.length - 1
        : StreamingTtsTracker.SENTENCE_END_RE.test(sentences[0])
          ? 1
          : 0;

    if (lastComplete === 0) return;

    const first = sentences[0];
    const cleaned = stripForTts(first);
    if (!cleaned) return;

    this.audioDispatched++;
    this.dispatchFirstTts(cleaned);
  }

  /** Signal that the full text is available (streaming ended). */
  processFinal(): void {
    if (this.finalized) return;
    this.finalized = true;

    const sentences = splitSentences(this.accumulatedText);
    const newSentences = sentences.slice(this.sentencesSent);
    this.sentencesSent = sentences.length;

    const ttsSentences = newSentences.filter((s) => stripForTts(s).length > 0);

    // Edge case: no sentences were dispatched during streaming
    if (this.audioDispatched === 0) {
      if (ttsSentences.length === 0) {
        // No TTS-worthy content — still show the raw text
        this.onSendFirstTts(this.accumulatedText || '', undefined);
        this.resolveFirstSent();
        this.firstSentPromise.then(() => this.onReplyDone());
        return;
      }
      this.audioDispatched++;
      this.dispatchFirstTts(ttsSentences[0]);
      ttsSentences.shift();
    }

    if (ttsSentences.length === 0) {
      this.firstSentPromise.then(() => this.onReplyDone());
      return;
    }

    // Generate TTS for all remaining sentences concurrently,
    // but deliver them sequentially (ordered via promise chain).
    const ttsPromises = ttsSentences.map((s) => this.generateTtsUrl(s));
    let chain = this.firstSentPromise;
    for (let i = 0; i < ttsSentences.length; i++) {
      const sentence = ttsSentences[i];
      const idx = this.sentencesSent - ttsSentences.length + i;
      const p = ttsPromises[i];
      chain = chain.then(() => p).then((audioUrl) => {
        this.onAppendSentence(sentence, audioUrl, idx);
      });
    }
    chain.then(() => this.onReplyDone());
  }

  private async dispatchFirstTts(sentence: string): Promise<void> {
    const ttsPromise = this.generateTtsUrl(sentence);
    const audioUrl = await Promise.race([
      ttsPromise,
      new Promise<undefined>((r) =>
        setTimeout(r, StreamingTtsTracker.FIRST_TTS_TIMEOUT_MS),
      ),
    ]);
    this.onSendFirstTts(sentence, audioUrl);
    this.resolveFirstSent();
  }

  private async generateTtsUrl(text: string): Promise<string | undefined> {
    try {
      const prefs = getPrefs();
      if (!prefs.ttsEnabled) return undefined;

      const cleanText = stripForTts(text);
      if (!cleanText) return undefined;

      let result: { success: boolean; audioPath?: string; error?: string };
      if (prefs.provider === 'qwen' && prefs.qwenKey) {
        result = await qwenTts({
          text: cleanText,
          apiKey: prefs.qwenKey,
          voice: prefs.voice,
          model: prefs.qwenModel,
          language: prefs.language,
        });
      } else {
        result = await edgeTts({ text: cleanText, voice: prefs.voice });
      }

      if (result.success && result.audioPath) {
        return registerAudioFile(result.audioPath);
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}

// ── FriendChatService ────────────────────────────────────────────────────────

export class FriendChatService {
  private sessionStarted = false;
  private outputRegistered = false;

  /** Accumulated text for the current conversational turn. */
  private accumulatedText = '';
  /** Non-null between sendMessage() and the conclusion of that turn. */
  private currentTracker: StreamingTtsTracker | null = null;
  /** True while the current user message is being processed by the CLI. */
  private turnActive = false;
  /** True if at least one text_delta was received this turn. */
  private hasTextContent = false;

  private replyDoneTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly REPLY_DONE_DELAY_MS = 1500;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Ensure a ConversationService session exists for Friend.
   * Safe to call multiple times — only starts once.
   */
  async ensureSession(serverHost: string, serverPort: number): Promise<void> {
    if (this.sessionStarted) return;

    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const workDir = path.join(homeDir, '.config', 'VersperClaw', 'friend');
    mkdirSync(workDir, { recursive: true });

    const sdkUrl =
      `ws://${serverHost}:${serverPort}/sdk/${SESSION_ID}` +
      `?token=${crypto.randomUUID()}`;

    if (!conversationService.hasSession(SESSION_ID)) {
      try {
        await conversationService.startSession(SESSION_ID, workDir, sdkUrl);
      } catch (err) {
        console.warn(`[FriendChat] session start failed: ${err}`);
        throw err;
      }
    }

    this.sessionStarted = true;
    this.registerOutputCallback();
  }

  /** Tear down the Friend session. */
  stop(): void {
    if (this.replyDoneTimer) clearTimeout(this.replyDoneTimer);
    conversationService.stopSession(SESSION_ID);
    this.sessionStarted = false;
    this.turnActive = false;
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  /**
   * Send a chat message through the CLI subprocess. Returns immediately;
   * the response is streamed asynchronously via SSE.
   */
  sendMessage(text: string): void {
    // Reset per-turn state
    this.accumulatedText = '';
    this.hasTextContent = false;
    this.turnActive = true;

    // Show thinking emotion immediately
    broadcastToVrm({ emotion: 'think', emotionIntensity: 0.7 });

    // Create a fresh tracker for this turn
    this.currentTracker = new StreamingTtsTracker(
      (t, audioUrl) => {
        const payload: VrmBroadcastPayload = { text: t, sendFirstTts: true };
        if (audioUrl) {
          payload.audioUrl = audioUrl;
          payload.audioIndex = 0;
        }
        broadcastToVrm(payload);
      },
      (t, audioUrl, index) => {
        const payload: VrmBroadcastPayload = { text: t, appendText: true, audioIndex: index };
        if (audioUrl) payload.audioUrl = audioUrl;
        broadcastToVrm(payload);
      },
      () => {
        broadcastToVrm({ replyDone: true });
        this.turnActive = false;
      },
    );

    const sent = conversationService.sendMessage(SESSION_ID, text);
    if (!sent) {
      console.warn('[FriendChat] CLI session not running, cannot send message');
      broadcastToVrm({ text: 'The companion is not available right now.' });
      broadcastToVrm({ replyDone: true });
      this.turnActive = false;
    }
  }

  /** Send a /new command to clear conversation context. */
  clearContext(): void {
    this.accumulatedText = '';
    this.hasTextContent = false;
    conversationService.sendMessage(SESSION_ID, '/new');
  }

  /** Send a memo message (user note appended without LLM reply). */
  sendMemo(text: string): void {
    // Append as a user message without expecting a reply.
    // Use the conversation message format.
    conversationService.sendMessage(SESSION_ID, text);
  }

  // ── SDK output handling ──────────────────────────────────────────────────

  private registerOutputCallback(): void {
    if (this.outputRegistered) return;
    this.outputRegistered = true;

    // Clear any stale callbacks first — prevents accumulation on restart.
    conversationService.clearOutputCallbacks(SESSION_ID);
    conversationService.onOutput(SESSION_ID, (msg: any) => {
      this.handleSdkMessage(msg);
    });
  }

  private handleSdkMessage(msg: any): void {
    // ── Auto-grant all tool permissions for Friend ──────────────────────
    if (msg?.type === 'control_request' && msg.request?.subtype === 'can_use_tool') {
      conversationService.respondToPermission(msg.request_id, true, 'always');
      return;
    }

    // ── Streaming text ──────────────────────────────────────────────────
    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (!event) return;

      // Accumulate text deltas and feed to the tracker
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        this.accumulatedText += event.delta.text;
        this.hasTextContent = true;
        this.currentTracker?.processPartial(this.accumulatedText);
        this.debounceReplyDone();
        return;
      }

      // An assistant message section ended — if we have accumulated text,
      // signal the tracker to process remaining sentences.
      if (event.type === 'message_stop' && this.hasTextContent) {
        this.currentTracker?.processFinal();
        return;
      }

      return;
    }

    // ── Complete assistant message (fallback when no streaming) ─────────
    if (msg.type === 'assistant' && msg.message?.content && !this.hasTextContent) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          this.accumulatedText = block.text;
          this.hasTextContent = true;
          this.currentTracker?.processFinal();
          break;
        }
      }
      return;
    }

    // ── result / error handling ─────────────────────────────────────────
    if (msg.type === 'result' && msg.is_error) {
      console.warn(`[FriendChat] SDK error: ${msg.result ?? 'unknown error'}`);
      if (this.turnActive) {
        broadcastToVrm({
          text: `Error: ${msg.result ?? 'Something went wrong'}`,
          appendText: true,
          audioIndex: 99,
        });
        broadcastToVrm({ replyDone: true });
        this.turnActive = false;
      }
    }
  }

  /**
   * Debounce `replyDone` broadcast. Each new text delta resets the timer.
   * This prevents premature turn completion when the CLI is generating
   * tool-related follow-up text.
   */
  private debounceReplyDone(): void {
    if (this.replyDoneTimer) clearTimeout(this.replyDoneTimer);
    this.replyDoneTimer = setTimeout(() => {
      if (this.currentTracker && this.hasTextContent) {
        this.currentTracker.processFinal();
      }
    }, this.REPLY_DONE_DELAY_MS);
  }
}

// Singleton
export const friendChatService = new FriendChatService();
