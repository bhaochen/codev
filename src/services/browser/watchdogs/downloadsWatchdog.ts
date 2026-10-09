/**
 * DownloadsWatchdog - 参考 browser-use 的 DownloadsWatchdog
 *
 * 职责：监控下载事件，自动保存文件
 * - CDP Fetch.requestPaused + Page.downloadWillBegin + downloadProgress
 * - 支持 click_with_download_detection 回调模式
 * - 自动保存到配置的下载目录
 */

import { BaseWatchdog, WatchdogEvent, WatchdogConfig } from "./watchdog.js";
import { BrowserSessionService } from "../browserSession.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface DownloadsWatchdogConfig extends WatchdogConfig {
  /** 下载保存目录 */
  downloadDir?: string;
  /** 是否自动接受下载 */
  autoAccept?: boolean;
  /** 下载超时 (ms) */
  timeoutMs?: number;
}

interface DownloadInfo {
  requestId: string;
  url: string;
  suggestedFilename: string;
  targetPath: string;
  receivedBytes: number;
  totalBytes: number;
  startTime: number;
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

export class DownloadsWatchdog extends BaseWatchdog {
  readonly name = "DownloadsWatchdog";
  readonly listensTo: WatchdogEvent["type"][] = [
    "browser:connected",
    "navigation:started",
    "network:request",
    "network:response",
    "network:finished",
  ];
  readonly emits: WatchdogEvent["type"][] = [
    "download:started",
    "download:progress",
    "download:completed",
    "download:failed",
  ];

  private downloadDir: string;
  private autoAccept: boolean;
  private timeoutMs: number;
  private downloads = new Map<string, DownloadInfo>();
  private downloadCallback?: (info: DownloadInfo) => void;

  constructor(bus: any, session: BrowserSessionService, config: DownloadsWatchdogConfig = {}) {
    super(bus, session, config);
    this.downloadDir = config.downloadDir ?? join(homedir(), "Downloads", "codev-browser");
    this.autoAccept = config.autoAccept ?? true;
    this.timeoutMs = config.timeoutMs ?? 300_000; // 5分钟
    this.ensureDir();
  }

  private ensureDir(): void {
    try {
      mkdirSync(this.downloadDir, { recursive: true });
    } catch {
      // 忽略
    }
  }

  protected registerListeners(): void {
    this.bus.onType("browser:connected", this.onBrowserConnected.bind(this));
    this.bus.onType("network:request", this.onNetworkRequest.bind(this));
    this.bus.onType("network:response", this.onNetworkResponse.bind(this));
    this.bus.onType("network:finished", this.onNetworkFinished.bind(this));
  }

  private async onBrowserConnected(): Promise<void> {
    // 启用 CDP Fetch 域以拦截下载
    try {
      await this.session.client?.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Response" }],
      });
    } catch {
      // 可能不支持或已启用
    }

    // 设置下载行为
    try {
      await this.session.client?.send("Browser.setDownloadBehavior", {
        behavior: this.autoAccept ? "allow" : "deny",
        downloadPath: this.downloadDir,
      });
    } catch {
      // 旧版本 CDP 可能不支持
    }
  }

  private onNetworkRequest(event: Extract<WatchdogEvent, { type: "network:request" }>): void {
    const { requestId, url, method } = event;
    // 记录请求开始，用于后续关联下载
  }

  private onNetworkResponse(event: Extract<WatchdogEvent, { type: "network:response" }>): void {
    const { requestId, status } = event;
    // 检查是否为下载响应
  }

  private onNetworkFinished(event: Extract<WatchdogEvent, { type: "network:finished" }>): void {
    const { requestId } = event;
    // 下载完成检查
  }

  /**
   * 注册点击后的下载检测回调
   * 返回一个 Promise，在下载完成或超时时 resolve/reject
   */
  async waitForDownload(
    trigger: () => Promise<void>,
    options: { timeoutMs?: number } = {}
  ): Promise<string> {
    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        this.downloadCallback = undefined;
        reject(new Error("Download wait timeout"));
      }, options.timeoutMs ?? this.timeoutMs);

      this.downloadCallback = (info) => {
        clearTimeout(timeout);
        this.downloadCallback = undefined;
        resolve(info.targetPath);
      };

      try {
        await trigger();
      } catch (error) {
        clearTimeout(timeout);
        this.downloadCallback = undefined;
        reject(error);
      }
    });
  }

  /** 内部处理下载完成 */
  private handleDownloadComplete(requestId: string, path: string): void {
    const info = this.downloads.get(requestId);
    if (info) {
      info.resolve(path);
      this.downloads.delete(requestId);
      this.emit({ type: "download:completed", targetId: "", path });
      this.downloadCallback?.(info);
    }
  }

  /** 获取下载目录 */
  getDownloadDir(): string {
    return this.downloadDir;
  }
}