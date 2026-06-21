/**
 * Friend HTTP server — lightweight Bun.serve for VRM frontend.
 *
 * Runs in the main CLI process alongside the Ink TUI.
 * Serves the friend frontend static files, API routes, and SSE.
 *
 * Architecture:
 *   - No WebSocket (frontend uses SSE for server→client, HTTP for client→server)
 *   - No separate CLI SDK session (uses FriendService → enqueue() → main CLI)
 *   - No arecord/parecord subprocess (uses cpal in-process)
 */

import { createSseResponse } from './sse.js';
import { handleFriendStaticRequest } from '../server/staticFriend.js';
import { handleFriendApi } from '../server/api/friend.js';

let server: ReturnType<typeof Bun.serve> | null = null;
let serverPort = 3456;

export function getServerPort(): number {
  return serverPort;
}

/**
 * Try to kill any existing process listening on the given port.
 * Returns true if the port became free.
 */
function freePort(port: number): boolean {
  try {
    // Find PID on the port
    const ss = Bun.spawnSync(['ss', '-tlnp', 'sport', `= :${port}`]);
    const out = ss.stdout.toString();
    const pidMatch = out.match(/pid=(\d+)/);
    if (!pidMatch) return true; // port already free

    const pid = parseInt(pidMatch[1]!, 10);
    if (pid === process.pid) return true; // we own it

    // Only kill bun/VersperClaw processes — don't touch unknown services
    const proc = Bun.spawnSync(['ps', '-p', String(pid), '-o', 'comm=']);
    const comm = proc.stdout.toString().trim();
    if (!comm) return false; // process doesn't exist
    const baseName = comm.split('/').pop() || comm;
    if (baseName !== 'bun' && baseName !== 'VersperClaw' && !baseName.startsWith('claude-') && !baseName.includes('node')) {
      console.warn(`[FriendServer] Port ${port} is occupied by non-VersperClaw process: ${comm}`);
      return false;
    }

    // Send SIGTERM politely
    process.kill(pid, 'SIGTERM');
    // Wait up to 3s for it to die
    for (let i = 0; i < 30; i++) {
      Bun.sleepSync(100);
      try { process.kill(pid, 0); } catch { return true; } // dead
    }
    // Force kill
    try { process.kill(pid, 'SIGKILL'); } catch { /* */ }
    Bun.sleepSync(200);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the friend HTTP server in-process.
 * Safe to call multiple times — no-op if already running.
 * If the port is already in use, attempts to free it first.
 */
export function startFriendServer(port = 3456, host = '127.0.0.1'): ReturnType<typeof Bun.serve> {
  if (server) return server;

  serverPort = port;

  // If port is in use, try to free it
  const check = Bun.spawnSync(['ss', '-tlnp', 'sport', `= :${port}`]);
  if (check.stdout.toString().includes('LISTEN')) {
    console.log(`[FriendServer] Port ${port} is in use, attempting to free it...`);
    if (!freePort(port)) {
      console.warn(`[FriendServer] Could not free port ${port}. Please stop the existing server manually.`);
      throw new Error(`Port ${port} is already in use`);
    }
    console.log(`[FriendServer] Port ${port} freed successfully.`);
  }

  server = Bun.serve<undefined>({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }

      // SSE events (GET /plugins/friend/events)
      if (url.pathname === '/plugins/friend/events' && req.method === 'GET') {
        return createSseResponse();
      }

      // Friend API routes (/plugins/friend/*)
      if (url.pathname.startsWith('/plugins/friend/')) {
        return handleFriendApi(req, url);
      }

      // WebSocket upgrade — not needed for friend (uses SSE + HTTP)
      // but handle gracefully
      if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        return new Response('WebSocket not supported via friend server', { status: 426 });
      }

      // Static files (/friend/*)
      if (url.pathname.startsWith('/friend/') || url.pathname === '/friend') {
        const staticResponse = await handleFriendStaticRequest(req, url);
        if (staticResponse) return staticResponse;
      }

      return new Response('Not Found', { status: 404 });
    },
    error(err) {
      console.error('[FriendServer] Error:', err);
      return new Response('Internal Server Error', { status: 500 });
    },
  });

  console.log(`[FriendServer] Listening on http://${host}:${port}`);
  return server;
}

/**
 * Stop the friend HTTP server.
 */
export function stopFriendServer(): void {
  if (server) {
    try {
      server.stop();
      server = null;
      console.log('[FriendServer] Stopped');
    } catch (err) {
      console.error('[FriendServer] Error stopping:', err);
    }
  }
}
