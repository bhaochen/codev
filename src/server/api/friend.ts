/**
 * Friend API — VRM avatar frontend HTTP routes for VersperClaw.
 *
 * Handles all /plugins/friend/* routes that the Tauri desktop app
 * communicates with. Replaces the OpenClaw gateway routing.
 */
import path from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, appendFileSync, unlinkSync } from 'node:fs';
import {
  createSseResponse,
  broadcastToVrm,
} from '../../friend/sse.js';
import { getPrefs, setPrefs, updatePrefs, type FriendPrefs } from '../../friend/prefs.js';
import { edgeTts, qwenTts, registerAudioFile, getAudioFile } from '../../friend/tts.js';
import { stripForTts } from '../../friend/text-utils.js';
import { friendService } from '../../friend/FriendService.js';
import { transcribeAudioFile } from '../../friend/stt-service.js';

const GATEWAY_URL = `http://127.0.0.1:3456`;

/** Resolved at startup from the Bun.serve config. Updated by the server. */
let serverHost = '127.0.0.1';
let serverPort = 3456;

export function setFriendServerInfo(host: string, port: number): void {
  serverHost = host;
  serverPort = port;
}

const MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/opus',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

// Workspace paths
const homeDir = process.env.HOME || process.env.USERPROFILE || '';
// Session tracking for dance import (MP3 follows VMD in user flow)
let lastImportedDanceId: string | null = null;
const workspaceRoot = path.join(homeDir, '.config', 'VersperClaw', 'friend');

// Persona files
const identityPath = path.join(workspaceRoot, 'IDENTITY.md');
const soulPath = path.join(workspaceRoot, 'SOUL.md');

// Models & dances
const customModelsDir = path.join(workspaceRoot, 'models');
const customDancesDir = path.join(workspaceRoot, 'dances');

// Media file registry
const mediaFileRegistry = new Map<string, string>();

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

function readJsonBody(req: Request): Promise<unknown> {
  return req.json();
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

  // ── SSE Events endpoint (GET /plugins/friend/events) ──
  if (pathname === '/plugins/friend/events' && method === 'GET') {
    return createSseResponse();
  }

  // ── Audio serving (GET /plugins/friend/audio/:id) ──
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

  // ── Media serving (GET /plugins/friend/media/:id) ──
  if (pathname.startsWith('/plugins/friend/media/') && method === 'GET') {
    const mediaId = pathname.split('/plugins/friend/media/')[1]?.split('?')[0];
    if (!mediaId) return jsonResponse({ error: 'missing media id' }, 400);

    const filePath = mediaFileRegistry.get(mediaId);
    if (!filePath || !existsSync(filePath)) return notFound('media not found');

    const ext = path.extname(filePath).toLowerCase();
    const contentType = IMAGE_MIME[ext] ?? 'application/octet-stream';
    const data = readFileSync(filePath);
    return new Response(data, {
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300', ...corsHeaders() },
    });
  }

  // ── Chat endpoint (POST /plugins/friend/chat) ──
  if (pathname === '/plugins/friend/chat' && method === 'POST') {
    const body = await readJsonBody(req) as any;
    const message = body?.message;
    if (!message) return jsonResponse({ error: 'message required' }, 400);

    // Enqueue the message into the main CLI conversation via FriendService.
    // The AI response is tracked by useFriendBridge in the REPL and
    // broadcast back to the VRM display via SSE automatically.
    try {
      await friendService.start();
      friendService.sendText(message);
    } catch (err) {
      console.error('[Friend] chat dispatch error:', err);
      broadcastToVrm({
        text: `Connection error: ${err instanceof Error ? err.message : String(err)}`,
      });
      broadcastToVrm({ replyDone: true });
    }

    return jsonResponse({ ok: true });
  }

  // ── STT segment from browser VAD (POST /plugins/friend/voice/stt-segment) ──
  if (pathname === '/plugins/friend/voice/stt-segment' && method === 'POST') {
    try {
      const contentType = req.headers.get('content-type') || '';
      let audioBuffer: Buffer;

      if (contentType.includes('multipart/form-data') || contentType.includes('application/octet-stream')) {
        const blob = await req.blob();
        audioBuffer = Buffer.from(await blob.arrayBuffer());
      } else {
        // Accept raw PCM or WAV as binary body
        audioBuffer = Buffer.from(await req.arrayBuffer());
      }

      if (audioBuffer.length < 100) {
        return jsonResponse({ error: 'audio too short' }, 400);
      }

      const transcript = await friendService.transcribeAudioSegment(audioBuffer);
      return jsonResponse({ ok: true, text: transcript });
    } catch (err) {
      console.error('[Friend] STT segment error:', err);
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── Voice capture (POST /plugins/friend/voice/start, /start-vad, /stop, /status) ──
  if (pathname === '/plugins/friend/voice/start' && method === 'POST') {
    try {
      await friendService.startVoiceCapture();
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  if (pathname === '/plugins/friend/voice/start-vad' && method === 'POST') {
    try {
      await friendService.startVadVoiceCapture();
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

  // ── Touch endpoint (POST /plugins/friend/touch) ──
  if (pathname === '/plugins/friend/touch' && method === 'POST') {
    const body = await readJsonBody(req) as any;
    const region = body?.region;
    const prompt = body?.prompt;
    if (!region || !prompt) return jsonResponse({ error: 'region and prompt required' }, 400);

    setImmediate(() => {
      broadcastToVrm({ text: `[Touch: ${region}] ${prompt}` });
    });

    return jsonResponse({ ok: true });
  }

  // ── Voice settings (GET/POST /plugins/friend/voice) ──
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
      const body = await readJsonBody(req) as any;
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

  // ── STT config (GET /plugins/friend/stt/config) ──
  if (pathname === '/plugins/friend/stt/config' && method === 'GET') {
    const prefs = getPrefs();
    return jsonResponse({
      sttProvider: prefs.sttProvider || 'browser',
      sttLanguage: prefs.sttLanguage || 'zh',
    });
  }

  // ── STT file transcription (POST /plugins/friend/stt/file) ──
  if (pathname === '/plugins/friend/stt/file' && method === 'POST') {
    try {
      const formData = await req.formData();
      const audioFile = formData.get('audio') as File | null;
      if (!audioFile) return jsonResponse({ error: 'audio file required' }, 400);

      const buffer = Buffer.from(await audioFile.arrayBuffer());
      const prefs = getPrefs();
      const result = await transcribeAudioFile(buffer, prefs);
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── TTS Preview (POST /plugins/friend/preview) ──
  if (pathname === '/plugins/friend/preview' && method === 'POST') {
    const body = await readJsonBody(req) as any;
    const voice = body.voice as string | undefined;
    const provider = body.provider as string | undefined;
    const text = '你好，这是一段语音试听。Hello, this is a voice preview.';

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
        return jsonResponse({ audioUrl: `${GATEWAY_URL}/plugins/friend/audio/${audioId}` });
      }
      return jsonResponse({ error: result.error || 'TTS failed' });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── General settings (GET/POST /plugins/friend/settings) ──
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
        screenObserve: prefs.screenObserve,
        screenObserveInterval: prefs.screenObserveInterval,
        currentDance: prefs.currentDance,
        language: prefs.language,
        hideMood: prefs.hideMood,
        sttProvider: prefs.sttProvider || 'browser',
        sttLanguage: prefs.sttLanguage || 'zh',
      });
    }

    if (method === 'POST') {
      const body = await readJsonBody(req) as any;
      const patch: Partial<FriendPrefs> = {};
      if (body.modelPath !== undefined) patch.modelPath = body.modelPath;
      if (body.ttsEnabled !== undefined) patch.ttsEnabled = body.ttsEnabled;
      if (body.showText !== undefined) patch.showText = body.showText;
      if (body.hideUI !== undefined) patch.hideUI = body.hideUI;
      if (body.tracking !== undefined) patch.tracking = body.tracking;
      if (body.volume !== undefined) patch.volume = body.volume;
      if (body.uiAlign !== undefined) patch.uiAlign = body.uiAlign;
      if (body.screenObserve !== undefined) patch.screenObserve = body.screenObserve;
      if (body.screenObserveInterval !== undefined) patch.screenObserveInterval = body.screenObserveInterval;
      if (body.currentDance !== undefined) patch.currentDance = body.currentDance;
      if (body.language !== undefined) patch.language = body.language;
      if (body.hideMood !== undefined) patch.hideMood = body.hideMood;
      if (body.sttProvider !== undefined) patch.sttProvider = body.sttProvider;
      if (body.sttLanguage !== undefined) patch.sttLanguage = body.sttLanguage;
      if (body.groqApiKey !== undefined) patch.groqApiKey = body.groqApiKey;
      setPrefs(updatePrefs(patch));
      return jsonResponse({ ok: true });
    }

    return new Response(null, { status: 405 });
  }

  // ── Persona (GET/POST /plugins/friend/persona) ──
  if (pathname === '/plugins/friend/persona') {
    if (method === 'GET') {
      let soul = '';
      let identity = '';
      try { if (existsSync(soulPath)) soul = readFileSync(soulPath, 'utf8'); } catch { /* */ }
      try { if (existsSync(identityPath)) identity = readFileSync(identityPath, 'utf8'); } catch { /* */ }
      return jsonResponse({ soul, identity, soulPath, identityPath });
    }

    if (method === 'POST') {
      const body = await readJsonBody(req) as any;
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

  // ── Model list (GET /plugins/friend/model/list) ──
  if (pathname === '/plugins/friend/model/list' && method === 'GET') {
    try {
      let custom: string[] = [];
      if (existsSync(customModelsDir)) {
        custom = readdirSync(customModelsDir)
          .filter((f: string) => f.toLowerCase().endsWith('.vrm'))
          .map((f: string) => `${GATEWAY_URL}/plugins/friend/model/serve/${f}`);
      }
      return jsonResponse({ models: custom });
    } catch {
      return jsonResponse({ models: [] });
    }
  }

  // ── Model serve (GET /plugins/friend/model/serve/:file) ──
  if (pathname.startsWith('/plugins/friend/model/serve/') && method === 'GET') {
    const fileName = decodeURIComponent(pathname.split('/plugins/friend/model/serve/')[1]?.split('?')[0] ?? '');
    if (!fileName || fileName.includes('..') || fileName.includes('/')) {
      return jsonResponse({ error: 'invalid file name' }, 400);
    }
    const filePath = path.join(customModelsDir, fileName);
    if (!existsSync(filePath)) return notFound('model not found');

    const data = readFileSync(filePath);
    return new Response(data, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(data.length),
        'Cache-Control': 'public, max-age=3600',
        ...corsHeaders(),
      },
    });
  }

  // ── History (GET /plugins/friend/history) ──
  if (pathname === '/plugins/friend/history' && method === 'GET') {
    try {
      const stateDir = path.join(homeDir, '.local', 'share', 'VersperClaw');
      const sessionsDir = path.join(stateDir, 'sessions');

      let messages: any[] = [];
      if (existsSync(sessionsDir)) {
        const files = readdirSync(sessionsDir)
          .filter((f: string) => f.endsWith('.jsonl'))
          .map((f: string) => ({
            name: f,
            mtime: statSync(path.join(sessionsDir, f)).mtimeMs,
          }))
          .sort((a: any, b: any) => b.mtime - a.mtime);

        if (files.length > 0) {
          const jsonlPath = path.join(sessionsDir, files[0].name);
          const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter((l: string) => l.trim());
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (obj.message) messages.push(obj.message);
            } catch { /* skip malformed */ }
          }
        }
      }

      let agentName = '';
      try {
        if (existsSync(identityPath)) {
          const identity = readFileSync(identityPath, 'utf8');
          const nameMatch = identity.match(/\*\*Name:\*\*\s*(.+)/i) || identity.match(/^#\s+(.+)/m);
          if (nameMatch) agentName = nameMatch[1].trim();
        }
      } catch { /* */ }

      const formatted = messages
        .map((msg: any) => ({
          role: msg.role === 'model' ? 'assistant' : msg.role,
          content: typeof msg.content === 'string' ? msg.content : '',
          timestamp: msg.timestamp,
        }))
        .filter((m: any) => (m.role === 'user' || m.role === 'assistant') && m.content)
        .slice(-100);

      return jsonResponse({ messages: formatted, agentName: agentName || undefined });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── Clear context (POST /plugins/friend/context/clear) ──
  if (pathname === '/plugins/friend/context/clear' && method === 'POST') {
    broadcastToVrm({ clearText: true });
    friendService.sendText('/new');
    return jsonResponse({ ok: true });
  }

  // ── Mood adjust (POST /plugins/friend/mood/adjust) ──
  if (pathname === '/plugins/friend/mood/adjust' && method === 'POST') {
    const body = await readJsonBody(req) as any;
    const delta = Math.round(Number(body.delta) || 0);
    if (delta === 0) return jsonResponse({ ok: true });

    const prefs = getPrefs();
    const currentMood = (prefs as any)._moodIndex ?? 60;
    const cap = body.max != null ? Math.round(Number(body.max)) : 100;
    const newMood = Math.max(0, Math.min(cap, currentMood + delta));
    (prefs as any)._moodIndex = newMood;
    setPrefs(prefs);

    broadcastToVrm({ moodDelta: delta, moodIndex: newMood });
    return jsonResponse({ ok: true, moodIndex: newMood });
  }

  // ── Session memo (POST /plugins/friend/session/memo) ──
  if (pathname === '/plugins/friend/session/memo' && method === 'POST') {
    const body = await readJsonBody(req) as any;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return jsonResponse({ error: 'text required' }, 400);

    try {
      const stateDir = path.join(homeDir, '.local', 'share', 'VersperClaw');
      const sessionLog = path.join(stateDir, 'friend-memo.jsonl');
      mkdirSync(path.dirname(sessionLog), { recursive: true });
      appendFileSync(sessionLog, JSON.stringify({ role: 'user', content: text }) + '\n', 'utf8');
      return jsonResponse({ ok: true, written: true });
    } catch {
      return jsonResponse({ ok: true, written: false });
    }
  }

  // ── Model import (POST /plugins/friend/model/import) ──
  if (pathname === '/plugins/friend/model/import' && method === 'POST') {
    try {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      if (!file) return jsonResponse({ error: 'file required' }, 400);

      mkdirSync(customModelsDir, { recursive: true });
      const ext = path.extname(file.name) || '.vrm';
      const fileName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const filePath = path.join(customModelsDir, fileName);

      await Bun.write(filePath, file.stream());
      const serveUrl = `${GATEWAY_URL}/plugins/friend/model/serve/${encodeURIComponent(fileName)}`;
      return jsonResponse({ ok: true, url: serveUrl });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── Dance list (GET /plugins/friend/dance/list) ──
  if (pathname === '/plugins/friend/dance/list' && method === 'GET') {
    try {
      const manifestPath = path.join(customDancesDir, 'index.json');
      const dances: Array<{ id: string; label: string; vmdUrl: string; bgmUrl?: string }> = [];
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Array<{
          id: string; label: string; vmdFile: string; bgmFile?: string;
        }>;
        for (const entry of manifest) {
          dances.push({
            id: entry.id,
            label: entry.label,
            vmdUrl: `${GATEWAY_URL}/plugins/friend/dance/serve/${encodeURIComponent(entry.vmdFile)}`,
            ...(entry.bgmFile ? { bgmUrl: `${GATEWAY_URL}/plugins/friend/dance/serve/${encodeURIComponent(entry.bgmFile)}` } : {}),
          });
        }
      }
      return jsonResponse({ dances });
    } catch (err) {
      return jsonResponse({ dances: [] });
    }
  }

  // ── Dance import (POST /plugins/friend/dance/import) ──
  if (pathname === '/plugins/friend/dance/import' && method === 'POST') {
    try {
      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      if (!file) return jsonResponse({ error: 'file required' }, 400);

      mkdirSync(customDancesDir, { recursive: true });
      const ext = path.extname(file.name).toLowerCase();
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');

      // Read manifest
      const manifestPath = path.join(customDancesDir, 'index.json');
      let manifest: Array<{ id: string; label: string; vmdFile: string; bgmFile?: string }> = [];
      if (existsSync(manifestPath)) {
        try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = []; }
      }

      if (ext === '.vmd') {
        const id = `dance_${Date.now()}`;
        const vmdFile = `${id}.vmd`;
        await Bun.write(path.join(customDancesDir, vmdFile), file.stream());
        const label = path.basename(file.name, '.vmd');
        manifest.push({ id, label, vmdFile });
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        lastImportedDanceId = id;
        return jsonResponse({ ok: true });
      } else if (ext === '.mp3') {
        // Associate with last imported VMD (user flow: VMD → optional MP3)
        const targetId = lastImportedDanceId;
        if (!targetId) return jsonResponse({ error: 'no pending VMD import to associate with' }, 400);

        const bgmFile = `${targetId}.mp3`;
        await Bun.write(path.join(customDancesDir, bgmFile), file.stream());

        // Update manifest
        const entry = manifest.find((e) => e.id === targetId);
        if (entry) entry.bgmFile = bgmFile;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        lastImportedDanceId = null;
        return jsonResponse({ ok: true });
      } else {
        return jsonResponse({ error: 'unsupported file type' }, 400);
      }
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── Dance delete (POST /plugins/friend/dance/delete) ──
  if (pathname === '/plugins/friend/dance/delete' && method === 'POST') {
    try {
      const body = await readJsonBody(req) as any;
      const id = body?.id as string | undefined;
      if (!id) return jsonResponse({ error: 'id required' }, 400);

      const manifestPath = path.join(customDancesDir, 'index.json');
      if (!existsSync(manifestPath)) return jsonResponse({ error: 'no dances' }, 404);

      let manifest: Array<{ id: string; label: string; vmdFile: string; bgmFile?: string }> = [];
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { manifest = []; }

      const idx = manifest.findIndex((e) => e.id === id);
      if (idx === -1) return jsonResponse({ error: 'dance not found' }, 404);

      const entry = manifest[idx];
      // Delete files
      const vmdPath = path.join(customDancesDir, entry.vmdFile);
      if (existsSync(vmdPath)) unlinkSync(vmdPath);
      if (entry.bgmFile) {
        const bgmPath = path.join(customDancesDir, entry.bgmFile);
        if (existsSync(bgmPath)) unlinkSync(bgmPath);
      }

      manifest.splice(idx, 1);
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── Dance serve (GET /plugins/friend/dance/serve/:file) ──
  if (pathname.startsWith('/plugins/friend/dance/serve/') && method === 'GET') {
    const fileName = decodeURIComponent(pathname.split('/plugins/friend/dance/serve/')[1]?.split('?')[0] ?? '');
    if (!fileName || fileName.includes('..') || fileName.includes('/')) {
      return jsonResponse({ error: 'invalid file name' }, 400);
    }
    const filePath = path.join(customDancesDir, fileName);
    if (!existsSync(filePath)) return notFound('dance file not found');

    const data = readFileSync(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const contentType = ext === '.mp3' ? 'audio/mpeg' : 'application/octet-stream';
    return new Response(data, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(data.length),
        'Cache-Control': 'public, max-age=3600',
        ...corsHeaders(),
      },
    });
  }

  // ── Persona screenshot (POST /plugins/friend/persona/screenshot) ──
  if (pathname === '/plugins/friend/persona/screenshot' && method === 'POST') {
    try {
      const body = await readJsonBody(req) as any;
      const image = body?.image as string | undefined;
      if (!image) return jsonResponse({ error: 'image required' }, 400);

      const screenshotDir = path.join(workspaceRoot, 'screenshots');
      mkdirSync(screenshotDir, { recursive: true });

      // data:image/png;base64,... → save as PNG
      const b64 = image.replace(/^data:image\/\w+;base64,/, '');
      const buf = Buffer.from(b64, 'base64');
      const screenshotPath = path.join(screenshotDir, 'vrm-screenshot.png');
      writeFileSync(screenshotPath, buf);

      return jsonResponse({ ok: true, path: screenshotPath });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── Persona generate (POST /plugins/friend/persona/generate) ──
  if (pathname === '/plugins/friend/persona/generate' && method === 'POST') {
    try {
      const screenshotDir = path.join(workspaceRoot, 'screenshots');
      const screenshotPath = path.join(screenshotDir, 'vrm-screenshot.png');

      if (!existsSync(screenshotPath)) {
        return jsonResponse({ error: 'no screenshot found' }, 400);
      }

      // Read the screenshot and forward to LLM for persona generation
      const imageData = readFileSync(screenshotPath);
      const b64 = imageData.toString('base64');
      const dataUrl = `data:image/png;base64,${b64}`;

      // Use the LLM to generate persona from the screenshot
      const genResponse = await generatePersonaFromScreenshot(dataUrl);
      return jsonResponse(genResponse);
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── Screen observe (POST /plugins/friend/screen/observe) ──
  if (pathname === '/plugins/friend/screen/observe' && method === 'POST') {
    try {
      // In web mode, desktop screen capture requires browser API support.
      // The frontend sends the capture via a separate mechanism.
      // This endpoint just triggers the LLM observation cycle.
      broadcastToVrm({ screenObserve: true });
      return jsonResponse({ ok: true });
    } catch (err) {
      return jsonResponse({ error: String(err) }, 500);
    }
  }

  // ── Window close (POST /friend/api/window-close) — called by Tauri on close ──
  if ((pathname === '/friend/api/window-close' || pathname === '/plugins/friend/api/window-close') && method === 'POST') {
    // Emit a global event that tauri-launcher.ts can listen to
    process.emit('friend:window-close' as any);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: 'Not Found' }, 404);
}

// ── Persona generation helper ────────────────────────────────────────────────

interface PersonaGenResult {
  soul?: string;
  identity?: string;
  error?: string;
}

async function generatePersonaFromScreenshot(dataUrl: string): Promise<PersonaGenResult> {
  try {
    // Use OpenAI-compatible API to generate persona
    // The LLM will describe the VRM model's appearance and create IDENTITY.md / SOUL.md
    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';
    const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';

    if (!apiKey) {
      return {
        soul: '你是一个活泼可爱的虚拟伙伴，喜欢和用户聊天、玩耍。你性格开朗，充满好奇心，总是用积极的态度回应每一个互动。',
        identity: '**Name:** 小薇\n**Race:** 虚拟AI伙伴\n**Personality:** 活泼、开朗、好奇\n**Appearance:** 根据你的3D模型形象而定\n',
      };
    }

    const prompt = `You are a character designer. Based on this VRM character image, create two files:

1. IDENTITY.md — Character identity sheet with:
   - Name
   - Race (e.g., catgirl, elf, human, android)
   - Personality traits (3-5 words)
   - Physical appearance description
   - A representative emoji

2. SOUL.md — Character soul definition with:
   - Speaking style (tone, formality, quirks)
   - Behavioral rules
   - Backstory (2-3 sentences)
   - What makes them unique

Keep both files concise. Use markdown formatting. Only respond with the raw file contents separated by "===SEPARATOR===".`;

    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: dataUrl.split(',')[1] || dataUrl } },
          ],
        }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn('[Friend] Persona generation API error:', errText);
      return { error: `API error: ${response.status}` };
    }

    const json = await response.json();
    const content = json.content?.[0]?.text || '';
    const parts = content.split('===SEPARATOR===');
    return {
      identity: parts[0]?.trim() || '',
      soul: parts[1]?.trim() || '',
    };
  } catch (err) {
    console.warn('[Friend] Persona generation failed:', err);
    return { error: String(err) };
  }
}
