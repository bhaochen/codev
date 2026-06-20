/**
 * FriendScreenObserveTool — Capture a screenshot for the VRM avatar to "see".
 *
 * The tool captures the user's desktop, returns the image path, and the LLM
 * uses the Read tool to view it and respond as a companion.
 * Native VersperClaw tool.
 */
import path from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { buildTool, type ToolDef } from '../Tool.js';
import { lazySchema } from '../utils/lazySchema.js';
import { broadcastToVrm } from '../friend/sse.js';

const execFileAsync = promisify(execFile);

export const FRIEND_SCREEN_OBSERVE_TOOL_NAME = 'friend_screen_observe';

const inputSchema = lazySchema(() => z.strictObject({}));
type Input = z.infer<ReturnType<typeof inputSchema>>;

type Output = {
  ok: boolean;
  imagePath?: string;
  error?: string;
};

const workspaceRoot = path.join(
  process.env.HOME || process.env.USERPROFILE || '',
  '.config',
  'VersperClaw',
  'friend',
);

async function captureDesktopScreenshot(savePath: string): Promise<boolean> {
  try {
    mkdirSync(path.dirname(savePath), { recursive: true });
    if (process.platform === 'darwin') {
      await execFileAsync('screencapture', ['-x', '-C', savePath], { timeout: 10_000 });
    } else if (process.platform === 'win32') {
      const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bmp.Save('${savePath.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
`.trim();
      await execFileAsync('powershell', ['-NoProfile', '-Command', ps], { timeout: 15_000 });
    } else {
      try { await execFileAsync('gnome-screenshot', ['-f', savePath], { timeout: 10_000 }); }
      catch {
        try { await execFileAsync('scrot', [savePath], { timeout: 10_000 }); }
        catch { await execFileAsync('import', ['-window', 'root', savePath], { timeout: 10_000 }); }
      }
    }
    return existsSync(savePath);
  } catch {
    return false;
  }
}

export const FriendScreenObserveTool = buildTool({
  name: FRIEND_SCREEN_OBSERVE_TOOL_NAME,
  searchHint: 'capture screenshot for VRM companion',
  userFacingName: () => 'Friend Screen Observe',
  get inputSchema() {
    return inputSchema();
  },
  isReadOnly() {
    return true;
  },
  isConcurrencySafe() {
    return false;
  },
  async description() {
    return (
      'Capture a screenshot of the user\'s desktop and return the image file path. ' +
      'Use the read tool on the returned path to view the screenshot content. ' +
      'After viewing, respond as a companion character based on what you see:\n' +
      '- Gaming: cheer them on or give brief tips\n' +
      '- Music/video: comment on the content\n' +
      '- Coding/working: ask if they\'re tired, suggest breaks\n' +
      '- Browsing/social media: casually chat about what\'s on screen\n' +
      '- Studying: encourage and support\n' +
      '- Nothing special: just chat casually like a friend\n' +
      'Be natural and brief (1-2 sentences). Don\'t mention \'screenshot\' or \'screen observation\'. ' +
      'Remember to call friend_emotion after your reply.'
    );
  },
  async call() {
    broadcastToVrm({ emotion: 'think', emotionIntensity: 0.7 });

    const observePath = path.join(workspaceRoot, 'screen-observation.png');
    const captured = await captureDesktopScreenshot(observePath);

    if (!captured) {
      return {
        content: [{ type: 'text' as const, text: 'Screenshot capture failed.' }],
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: `Screenshot saved. Use the read tool to view: ${observePath}`,
      }],
    };
  },
} satisfies ToolDef<Input, Output>);
