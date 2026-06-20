/**
 * Tauri desktop app process management for Friend (VersperClaw native).
 *
 * Builds and launches the VRM desktop pet as a native Tauri window
 * (transparent, always-on-top) instead of a browser tab.
 */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';

let tauriProcess: ReturnType<typeof spawn> | null = null;

export function launchTauri(appDir: string, log: { info: (msg: string) => void; warn: (msg: string) => void }) {
  const tauriDir = path.join(appDir, 'src-tauri');
  const tauriConfPath = path.join(tauriDir, 'tauri.conf.json');

  // Verify the Tauri project exists
  if (!existsSync(tauriConfPath)) {
    log.warn(`Friend: Tauri project not found at ${tauriDir}. Falling back to browser mode.`);
    return;
  }

  log.info(`Starting Friend Tauri desktop window from ${appDir}`);

  // Run `npx tauri dev` — Bun's npx equivalent auto-fetches the CLI
  tauriProcess = spawn('npx', ['tauri', 'dev'], {
    cwd: appDir,
    stdio: 'pipe',
    shell: true,
    env: {
      ...process.env,
      // Tell Tauri dev server to skip its own Vite and load from VersperClaw
      TAURI_DEV_HOST: '127.0.0.1',
      TAURI_DEV_PORT: '3456',
    },
  });

  tauriProcess.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      log.info(line);
    }
  });

  tauriProcess.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      log.info(line);
    }
  });

  tauriProcess.on('error', (err: Error) => {
    log.warn(`Friend Tauri error: ${err.message}`);
    tauriProcess = null;
  });

  tauriProcess.on('exit', (code: number | null) => {
    log.info(`Friend Tauri exited (code: ${code})`);
    tauriProcess = null;
  });
}

export function stopTauri(log: { info: (msg: string) => void }) {
  if (tauriProcess) {
    log.info('Stopping Friend Tauri window...');
    const proc = tauriProcess;
    tauriProcess = null;

    // Send SIGTERM first
    proc.kill('SIGTERM');

    // Force kill after 3s if still alive
    setTimeout(() => {
      try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 3000);
  }
}

export function getTauriProcess(): ReturnType<typeof spawn> | null {
  return tauriProcess;
}
