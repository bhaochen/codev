/**
 * Friend API — VRM avatar frontend HTTP routes for VersperClaw.
 *
 * Simplified to only voice + emotion/action features.
 */
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import {
  createSseResponse,
} from '../../friend/sse.js';
import { getPrefs, setPrefs, updatePrefs, type FriendPrefs } from '../../friend/prefs.js';
import { edgeTts, qwenTts, registerAudioFile, getAudioFile } from '../../friend/tts.js';
import { friendService } from '../../friend/FriendService.js';

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/opus',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders() });
}

function notFound(msg = 'Not found'): Response {
  return jsonResponse({ error: msg }, 404);
}

/**
 * Route handler for /plugins/friend/*
 */
export async function handleFriendApi(req: Request, url: URL): Promise<Response> {
  const pathname = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // ── SSE Events endpoint ──
  if (pathname === '/plugins/friend/events' && method === 'GET') {
    return createSseResponse();
  }

  // ── Audio serving ──
  if (pathname.startsWith('/plugins/friend/audio/') && method === 'GET') {
    const audioId = pathname.split('/plugins/friend/audio/')[1]?.split('?')[0];
    if (!audioId) return jsonResponse({ error: 'missing audio id' }, 400);

    const filePath = getAudioFile(audioId);
    if (!filePath || !existsSync(filePath)) return notFound('audio not found');

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    const data = readFileSync(filePath);
    return new Response(data, {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300', ...corsHeaders() },
    });
  }

  // ── Voice capture endpoints ──
  if (pathname === '/plugins/friend/voice/start' && method === 'POST') {
    try {
      await friendService.startVoiceCapture();
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  if (pathname === '/plugins/friend/voice/stop' && method === 'POST') {
    try {
      const text = await friendService.stopVoiceCapture();
      return jsonResponse({ ok: true, text });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  if (pathname === '/plugins/friend/voice/status' && method === 'POST') {
    return jsonResponse(friendService.getCaptureStatus());
  }

  // ── Voice settings ──
  if (pathname === '/plugins/friend/voice') {
    if (method === 'GET') {
      const prefs = getPrefs();
      return jsonResponse({
        voice: prefs.voice ?? 'zh-CN-XiaoxiaoNeural',
        provider: prefs.provider ?? 'edge',
        qwenKey: prefs.qwenKey ?? '',
        qwenModel: prefs.qwenModel ?? 'qwen3-tts-flash',
      });
    }
    if (method === 'POST') {
      const body = await req.json() as any;
      const patch: Partial<FriendPrefs> = {};
      if (body.voice !== undefined) patch.voice = body.voice || undefined;
      if (body.provider !== undefined) patch.provider = body.provider || undefined;
      if (body.qwenKey !== undefined) patch.qwenKey = body.qwenKey || undefined;
      if (body.qwenModel !== undefined) patch.qwenModel = body.qwenModel || undefined;
      setPrefs(updatePrefs(patch));
      return jsonResponse({ ok: true });
    }
    return new Response(null, { status: 405 });
  }

  // ── STT config ──
  if (pathname === '/plugins/friend/stt/config' && method === 'GET') {
    const prefs = getPrefs();
    return jsonResponse({
      sttProvider: prefs.sttProvider || 'browser',
      sttLanguage: prefs.sttLanguage || 'zh',
    });
  }

  // ── STT segment from browser VAD ──
  if (pathname === '/plugins/friend/voice/stt-segment' && method === 'POST') {
    try {
      let audioBuffer: Buffer;
      const contentType = req.headers.get('content-type') || '';
      if (contentType.includes('multipart/form-data') || contentType.includes('application/octet-stream')) {
        const blob = await req.blob();
        audioBuffer = Buffer.from(await blob.arrayBuffer());
      } else {
        audioBuffer = Buffer.from(await req.arrayBuffer());
      }
      if (audioBuffer.length < 100) {
        return jsonResponse({ error: 'audio too short' }, 400);
      }
      const transcript = await friendService.transcribeAudioSegment(audioBuffer);
      return jsonResponse({ ok: true, text: transcript });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── TTS Preview ──
  if (pathname === '/plugins/friend/preview' && method === 'POST') {
    const body = await req.json() as any;
    const voice = body.voice as string | undefined;
    const provider = body.provider as string | undefined;
    const text = '\u4f60\u597d\uff0c\u8fd9\u662f\u4e00\u6bb5\u8bed\u97f3\u8bd5\u542c\u3002Hello, this is a voice preview.';

    try {
      const prefs = getPrefs();
      let result: { success: boolean; audioPath?: string; error?: string };
      if (provider === 'qwen' && prefs.qwenKey) {
        result = await qwenTts({
          text,
          apiKey: prefs.qwenKey,
          voice,
          model: prefs.qwenModel,
          language: prefs.language,
        });
      } else {
        result = await edgeTts({ text, voice: voice || prefs.voice });
      }
      if (result.success && result.audioPath) {
        const audioId = registerAudioFile(result.audioPath);
        return jsonResponse({ audioUrl: `http://127.0.0.1:3456/plugins/friend/audio/${audioId}` });
      }
      return jsonResponse({ error: result.error || 'TTS failed' });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── General settings (simplified) ──
  if (pathname === '/plugins/friend/settings') {
    if (method === 'GET') {
      const prefs = getPrefs();
      return jsonResponse({
        modelPath: prefs.modelPath,
        ttsEnabled: prefs.ttsEnabled,
        showText: prefs.showText,
        hideUI: prefs.hideUI,
        tracking: prefs.tracking,
        volume: prefs.volume,
        uiAlign: prefs.uiAlign,
        sttProvider: prefs.sttProvider || 'browser',
        sttLanguage: prefs.sttLanguage || 'zh',
        language: prefs.language,
      });
    }
    if (method === 'POST') {
      const body = await req.json() as any;
      const patch: Partial<FriendPrefs> = {};
      if (body.modelPath !== undefined) patch.modelPath = body.modelPath;
      if (body.ttsEnabled !== undefined) patch.ttsEnabled = body.ttsEnabled;
      if (body.showText !== undefined) patch.showText = body.showText;
      if (body.hideUI !== undefined) patch.hideUI = body.hideUI;
      if (body.tracking !== undefined) patch.tracking = body.tracking;
      if (body.volume !== undefined) patch.volume = body.volume;
      if (body.uiAlign !== undefined) patch.uiAlign = body.uiAlign;
      if (body.sttProvider !== undefined) patch.sttProvider = body.sttProvider;
      if (body.sttLanguage !== undefined) patch.sttLanguage = body.sttLanguage;
      if (body.language !== undefined) patch.language = body.language;
      if (body.groqApiKey !== undefined) patch.groqApiKey = body.groqApiKey;
      setPrefs(updatePrefs(patch));
      return jsonResponse({ ok: true });
    }
    return new Response(null, { status: 405 });
  }

  // ── Persona (read-only) ──
  const workspaceRoot = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.config', 'VersperClaw', 'friend',
  );
  const identityPath = path.join(workspaceRoot, 'IDENTITY.md');
  const soulPath = path.join(workspaceRoot, 'SOUL.md');

  if (pathname === '/plugins/friend/persona') {
    if (method === 'GET') {
      let soul = '';
      let identity = '';
      try { if (existsSync(soulPath)) soul = readFileSync(soulPath, 'utf8'); } catch { /* */ }
      try { if (existsSync(identityPath)) identity = readFileSync(identityPath, 'utf8'); } catch { /* */ }
      return jsonResponse({ soul, identity, soulPath, identityPath });
    }
    if (method === 'POST') {
      const body = await req.json() as any;
      const { mkdirSync, writeFileSync } = await import('node:fs');
      if (body.soul !== undefined) {
        mkdirSync(path.dirname(soulPath), { recursive: true });
        writeFileSync(soulPath, body.soul, 'utf8');
      }
      if (body.identity !== undefined) {
        mkdirSync(path.dirname(identityPath), { recursive: true });
        writeFileSync(identityPath, body.identity, 'utf8');
      }
      return jsonResponse({ ok: true });
    }
    return new Response(null, { status: 405 });
  }

  // ── Window close (called by Tauri on close) ──
  if ((pathname === '/friend/api/window-close' || pathname === '/plugins/friend/api/window-close') && method === 'POST') {
    process.emit('friend:window-close' as any);
    return jsonResponse({ ok: true });
  }

  // ── Chat endpoint (for voice call text relay) ──
  if (pathname === '/plugins/friend/chat' && method === 'POST') {
    const body = await req.json() as any;
    const message = body?.message;
    if (!message) return jsonResponse({ error: 'message required' }, 400);
    try {
      await friendService.start();
      friendService.sendText(message);
    } catch (err) {
      console.error('[Friend] chat dispatch error:', err);
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Not Found' }, 404);
}
