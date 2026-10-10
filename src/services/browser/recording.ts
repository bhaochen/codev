/**
 * Browser Recording - 参考 browser-use 的 RecordingWatchdog 和 browser-use-pi 的 Recorder
 *
 * 职责：
 * - 通过 CDP Page.startScreencast 录制浏览器操作
 * - 定期采样截图，记录光标位置
 * - 可选导出为 MP4/GIF (需要 ffmpeg)
 *
 * 采样策略：
 * - 浏览器侧：CDP screencast 每 250ms 一帧
 * - 浏览器侧：同时记录鼠标位置和点击事件
 * - 渲染侧：headless Chrome 渲染 HTML 页面，包含帧 + 光标动画 + 点击高亮
 * - 编码侧：ffmpeg 将帧序列编码为 MP4 或 GIF
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { CdpClient } from "./cdp.js";
import { BrowserSessionService } from "./browserSession.js";

export interface RecordingConfig {
  /** 输出目录 */
  outputDir?: string;
  /** 帧率 (fps, 默认 4) */
  fps?: number;
  /** 最大录制时长 (ms, 默认 300_000 = 5分钟) */
  maxDurationMs?: number;
  /** 视频质量 (0-100, 默认 80) */
  quality?: number;
  /** 是否包含光标 */
  includeCursor?: boolean;
}

interface RecordedFrame {
  timestamp: number;
  base64: string;
  cursor?: { x: number; y: number };
  click?: { x: number; y: number; button: string; timestamp: number };
  action?: string;
}

interface RecordingState {
  frames: RecordedFrame[];
  startTime: number;
  targetId: string;
}

const DEFAULT_CONFIG: Required<RecordingConfig> = {
  outputDir: join(homedir(), ".codev", "browser-recordings"),
  fps: 4,
  maxDurationMs: 300_000,
  quality: 80,
  includeCursor: true,
};

export class BrowserRecorder {
  private config: Required<RecordingConfig>;
  private state?: RecordingState;
  private screencastActive = false;
  private frameInterval?: NodeJS.Timeout;
  private client?: CdpClient;
  private onFrame?: (data: string) => void;

  constructor(config: RecordingConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.ensureOutputDir();
  }

  private ensureOutputDir(): void {
    try {
      mkdirSync(this.config.outputDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  /**
   * 开始录制
   */
  async start(session: BrowserSessionService, targetId: string): Promise<void> {
    if (this.state) {
      throw new Error("Recording already in progress");
    }

    const client = (session as any).client as CdpClient;
    if (!client) {
      throw new Error("Browser not connected");
    }
    this.client = client;

    this.state = {
      frames: [],
      startTime: Date.now(),
      targetId,
    };

    // 启动 CDP screencast
    await client.send("Page.enable").catch(() => {});

    // 使用 screencast (高效)
    this.onFrame = (data: string) => {
      if (!this.state) return;
      this.state.frames.push({
        timestamp: Date.now(),
        base64: data,
      });
    };

    // 尝试 screencast 方式
    try {
      await client.send("Page.startScreencast", {
        format: "jpeg",
        quality: this.config.quality,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: Math.max(1, Math.round(24 / this.config.fps)),
      });
      this.screencastActive = true;
    } catch {
      // 回退：定期截图
      this.startFallbackCapture();
    }

    // 监听鼠标事件
    this.captureMouseEvents(client, targetId);

    // 自动停止
    setTimeout(() => {
      if (this.state) {
        this.stop().catch(() => {});
      }
    }, this.config.maxDurationMs);
  }

  private startFallbackCapture(): void {
    if (!this.client || !this.state) return;
    const interval = Math.round(1000 / this.config.fps);
    this.frameInterval = setInterval(async () => {
      if (!this.client || !this.state) return;
      try {
        const result = await this.client.send<{ data: string }>("Page.captureScreenshot", {
          format: "jpeg",
          quality: this.config.quality,
        });
        this.state.frames.push({
          timestamp: Date.now(),
          base64: result.data,
        });
      } catch {
        // ignore
      }
    }, interval);
  }

  /**
   * 捕获鼠标事件 (光标位置、点击)
   */
  private captureMouseEvents(client: CdpClient, targetId: string): void {
    // 通过 Runtime.evaluate 注入监听器
    const listenerScript = `
      (function() {
        if (window.__recorderListener) return;
        window.__recorderListener = true;
        window.__recorderClicks = [];
        window.__recorderCursor = null;

        document.addEventListener('mousemove', function(e) {
          window.__recorderCursor = { x: e.clientX, y: e.clientY, ts: Date.now() };
        }, { passive: true });

        document.addEventListener('click', function(e) {
          window.__recorderClicks.push({
            x: e.clientX, y: e.clientY,
            button: e.button === 0 ? 'left' : e.button === 2 ? 'right' : 'middle',
            ts: Date.now()
          });
        }, { passive: true });
      })();
    `;

    client.send("Runtime.evaluate", {
      expression: listenerScript,
    }).catch(() => {});
  }

  /**
   * 记录一个动作 (用于在帧上标注)
   */
  recordAction(action: string): void {
    if (!this.state) return;
    const latest = this.state.frames[this.state.frames.length - 1];
    if (latest) {
      latest.action = action;
    }
  }

  /**
   * 停止录制
   */
  async stop(): Promise<string | null> {
    if (!this.state) return null;

    if (this.frameInterval) {
      clearInterval(this.frameInterval);
      this.frameInterval = undefined;
    }

    if (this.client && this.screencastActive) {
      await this.client.send("Page.stopScreencast").catch(() => {});
      this.screencastActive = false;
    }

    const duration = Date.now() - this.state.startTime;
    const frameCount = this.state.frames.length;

    if (frameCount === 0) {
      this.state = undefined;
      return null;
    }

    // 保存原始数据
    const recordingId = `rec_${this.state.startTime}`;
    const rawPath = join(this.config.outputDir, `${recordingId}.json`);
    const rawData = {
      id: recordingId,
      startTime: this.state.startTime,
      duration,
      frameCount,
      fps: this.config.fps,
      targetId: this.state.targetId,
      frames: this.state.frames.map(f => ({
        ts: f.timestamp,
        cursor: f.cursor,
        click: f.click,
        action: f.action,
        // 不存 base64 到 JSON (太大)
      })),
    };
    writeFileSync(rawPath, JSON.stringify(rawData, null, 2), "utf8");

    // 保存帧序列 (用于 ffmpeg)
    const framesDir = join(this.config.outputDir, recordingId);
    mkdirSync(framesDir, { recursive: true });
    for (let i = 0; i < this.state.frames.length; i++) {
      const frame = this.state.frames[i];
      const framePath = join(framesDir, `frame_${String(i).padStart(5, "0")}.jpg`);
      writeFileSync(framePath, Buffer.from(frame.base64, "base64"));
    }

    this.state = undefined;
    return recordingId;
  }

  /**
   * 导出为 GIF (需要 ffmpeg)
   */
  async exportToGif(recordingId: string, outputPath?: string): Promise<string | null> {
    const framesDir = join(this.config.outputDir, recordingId);
    if (!existsSync(framesDir)) return null;

    const gifPath = outputPath ?? join(this.config.outputDir, `${recordingId}.gif`);

    // 调用 ffmpeg
    try {
      const { execSync } = await import("child_process");
      execSync(
        `ffmpeg -y -framerate ${this.config.fps} -i "${join(framesDir, "frame_%05d.jpg")}" -vf "scale=640:-1" -loop 0 "${gifPath}"`,
        { timeout: 60_000, stdio: "pipe" }
      );
      return gifPath;
    } catch {
      // ffmpeg 不可用或失败
      return null;
    }
  }

  /**
   * 导出为 MP4 (需要 ffmpeg)
   */
  async exportToMp4(recordingId: string, outputPath?: string): Promise<string | null> {
    const framesDir = join(this.config.outputDir, recordingId);
    if (!existsSync(framesDir)) return null;

    const mp4Path = outputPath ?? join(this.config.outputDir, `${recordingId}.mp4`);

    try {
      const { execSync } = await import("child_process");
      execSync(
        `ffmpeg -y -framerate ${this.config.fps} -i "${join(framesDir, "frame_%05d.jpg")}" -c:v libx264 -pix_fmt yuv420p -vf "scale=1280:-2" "${mp4Path}"`,
        { timeout: 120_000, stdio: "pipe" }
      );
      return mp4Path;
    } catch {
      return null;
    }
  }

  /**
   * 生成 HTML 播放器 (无需 ffmpeg)
   */
  async generateHtmlPlayer(recordingId: string, outputPath?: string): Promise<string | null> {
    const rawPath = join(this.config.outputDir, `${recordingId}.json`);
    if (!existsSync(rawPath)) return null;

    const framesDir = join(this.config.outputDir, recordingId);
    const htmlPath = outputPath ?? join(this.config.outputDir, `${recordingId}.html`);

    const rawData = JSON.parse(readFileSync(rawPath, "utf8"));
    const { frames, fps, duration } = rawData;

    // 生成 HTML
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Browser Recording - ${recordingId}</title>
  <style>
    body { margin: 0; background: #1a1a1a; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; font-family: system-ui, sans-serif; }
    #container { position: relative; }
    #frame { max-width: 100%; max-height: 80vh; border: 2px solid #333; }
    #cursor { position: absolute; width: 20px; height: 20px; pointer-events: none; z-index: 10; transition: left 0.05s, top 0.05s; }
    #cursor::before { content: ''; position: absolute; width: 0; height: 0; border-left: 8px solid transparent; border-right: 8px solid transparent; border-bottom: 12px solid #ff5f57; transform: rotate(-45deg); }
    #click { position: absolute; width: 30px; height: 30px; border: 3px solid #ff5f57; border-radius: 50%; pointer-events: none; z-index: 11; animation: clickPulse 0.3s ease-out forwards; }
    @keyframes clickPulse { 0% { transform: scale(0.5); opacity: 1; } 100% { transform: scale(1.5); opacity: 0; } }
    #controls { margin-top: 16px; display: flex; gap: 12px; align-items: center; color: #ccc; }
    button { background: #333; color: #ccc; border: 1px solid #555; padding: 6px 12px; border-radius: 4px; cursor: pointer; }
    button:hover { background: #444; }
    #timeline { width: 600px; max-width: 80vw; }
    #info { font-size: 12px; color: #888; margin-top: 8px; }
  </style>
</head>
<body>
  <div id="container">
    <img id="frame" src="" alt="Recording frame">
    <div id="cursor"></div>
    <div id="click"></div>
  </div>
  <div id="controls">
    <button id="play">Play</button>
    <button id="pause">Pause</button>
    <button id="restart">Restart</button>
    <span id="info">${frames.length} frames @ ${fps}fps (${(duration / 1000).toFixed(1)}s)</span>
  </div>
  <input type="range" id="timeline" min="0" max="${frames.length - 1}" value="0">

  <script>
    const frames = ${JSON.stringify(frames)};
    const fps = ${fps};
    const frameImg = document.getElementById('frame');
    const cursor = document.getElementById('cursor');
    const click = document.getElementById('click');
    const timeline = document.getElementById('timeline');
    const playBtn = document.getElementById('play');
    const pauseBtn = document.getElementById('pause');
    const restartBtn = document.getElementById('restart');

    let current = 0;
    let playing = false;
    let timer = null;

    function showFrame(i) {
      if (i < 0 || i >= frames.length) return;
      current = i;
      const frame = frames[i];
      frameImg.src = 'data:image/jpeg;base64,' + (frame.base64 || '');
      timeline.value = i;

      if (frame.cursor) {
        cursor.style.display = 'block';
        cursor.style.left = frame.cursor.x + 'px';
        cursor.style.top = frame.cursor.y + 'px';
      } else {
        cursor.style.display = 'none';
      }

      if (frame.click) {
        click.style.display = 'block';
        click.style.left = (frame.click.x - 15) + 'px';
        click.style.top = (frame.click.y - 15) + 'px';
        click.style.animation = 'none';
        click.offsetHeight; // reflow
        click.style.animation = '';
      }
    }

    function next() {
      if (current >= frames.length - 1) {
        pause();
        return;
      }
      showFrame(current + 1);
    }

    function play() {
      playing = true;
      playBtn.textContent = 'Playing';
      timer = setInterval(next, 1000 / fps);
    }

    function pause() {
      playing = false;
      playBtn.textContent = 'Play';
      if (timer) clearInterval(timer);
    }

    playBtn.onclick = () => playing ? pause() : play();
    pauseBtn.onclick = pause;
    restartBtn.onclick = () => { pause(); showFrame(0); };
    timeline.oninput = () => { pause(); showFrame(Number(timeline.value)); };

    showFrame(0);
  </script>
</body>
</html>`;

    writeFileSync(htmlPath, html, "utf8");
    return htmlPath;
  }

  /**
   * 检查是否正在录制
   */
  isRecording(): boolean {
    return !!this.state;
  }

  /**
   * 获取录制信息
   */
  getRecordingInfo(): { active: boolean; duration: number; frameCount: number } | null {
    if (!this.state) return null;
    return {
      active: true,
      duration: Date.now() - this.state.startTime,
      frameCount: this.state.frames.length,
    };
  }
}

/** 全局录制器 */
let recorderInstance: BrowserRecorder | undefined;

export function getBrowserRecorder(config?: RecordingConfig): BrowserRecorder {
  if (!recorderInstance) {
    recorderInstance = new BrowserRecorder(config);
  }
  return recorderInstance;
}

export function resetBrowserRecorder(): void {
  recorderInstance = undefined;
}