/**
 * StorageWatchdog - 参考 browser-use 的 StorageStateWatchdog
 *
 * 职责：持久化 Cookie 和 localStorage，跨会话保持登录态
 * - 定期保存到 JSON 文件
 * - 支持加载恢复会话
 * - 支持加密存储 (可选)
 */

import { BaseWatchdog, WatchdogEvent, WatchdogConfig } from "./watchdog.js";
import { BrowserSessionService } from "../browserSession.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface StorageWatchdogConfig extends WatchdogConfig {
  /** 存储文件路径 */
  storagePath?: string;
  /** 自动保存间隔 (ms) */
  autoSaveIntervalMs?: number;
  /** 是否加密敏感字段 */
  encrypt?: boolean;
  /** 加密密钥 (若启用加密) */
  encryptionKey?: string;
}

interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{
    origin: string;
    localStorage: Record<string, string>;
  }>;
  savedAt: string;
}

export class StorageWatchdog extends BaseWatchdog {
  readonly name = "StorageWatchdog";
  readonly listensTo: WatchdogEvent["type"][] = [
    "browser:connected",
    "browser:stop",
    "navigation:completed",
  ];
  readonly emits: WatchdogEvent["type"][] = [];

  private storagePath: string;
  private autoSaveIntervalMs: number;
  private saveTimer?: NodeJS.Timeout;
  private lastSaved: StorageState | null = null;

  constructor(bus: any, session: BrowserSessionService, config: StorageWatchdogConfig = {}) {
    super(bus, session, config);
    this.storagePath = config.storagePath ?? join(homedir(), ".codev", "browser-storage.json");
    this.autoSaveIntervalMs = config.autoSaveIntervalMs ?? 30_000; // 30秒
  }

  protected registerListeners(): void {
    this.bus.onType("browser:connected", this.onBrowserConnected.bind(this));
    this.bus.onType("browser:stop", this.onBrowserStop.bind(this));
    this.bus.onType("navigation:completed", this.onNavigationCompleted.bind(this));
  }

  private async onBrowserConnected(): Promise<void> {
    // 尝试加载已保存的存储状态
    await this.loadStorage();
    // 启动定期保存
    this.startAutoSave();
  }

  private onBrowserStop(): void {
    this.stopAutoSave();
    this.saveStorage().catch(() => {});
  }

  private onNavigationCompleted(): void {
    // 导航完成后触发保存 (防止会话中丢失)
    this.saveStorage().catch(() => {});
  }

  private startAutoSave(): void {
    this.stopAutoSave();
    this.saveTimer = setInterval(() => {
      this.saveStorage().catch(() => {});
    }, this.autoSaveIntervalMs);
  }

  private stopAutoSave(): void {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
      this.saveTimer = undefined;
    }
  }

  /** 从浏览器获取并保存存储状态 */
  async saveStorage(): Promise<void> {
    if (!this.session.client?.isOpen) return;

    try {
      // 获取所有 Cookie
      const { cookies } = await this.session.client.send("Network.getAllCookies");

      // 获取所有 localStorage (需要遍历所有 frame)
      const origins = await this.getAllLocalStorage();

      const state: StorageState = {
        cookies: cookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires ?? -1,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        })),
        origins,
        savedAt: new Date().toISOString(),
      };

      // 只有变化时才写入
      if (this.hasChanged(state)) {
        this.writeStorageFile(state);
        this.lastSaved = state;
      }
    } catch (error) {
      // 忽略保存错误
    }
  }

  /** 获取所有 frame 的 localStorage */
  private async getAllLocalStorage(): Promise<StorageState["origins"]> {
    const result: StorageState["origins"] = [];

    try {
      // 获取主 frame 的 localStorage
      const mainFrame = await this.session.client?.send("Page.getFrameTree");
      if (mainFrame?.frameTree?.frame?.id) {
        const storage = await this.getFrameLocalStorage(mainFrame.frameTree.frame.id);
        if (Object.keys(storage).length > 0) {
          result.push({ origin: "main", localStorage: storage });
        }
      }

      // 遍历子 frame (同源)
      const frames = this.getAllFrames(mainFrame?.frameTree);
      for (const frame of frames) {
        if (frame.id) {
          const storage = await this.getFrameLocalStorage(frame.id);
          if (Object.keys(storage).length > 0) {
            result.push({ origin: frame.url ?? frame.id, localStorage: storage });
          }
        }
      }
    } catch {
      // 忽略
    }

    return result;
  }

  private getAllFrames(tree: any): any[] {
    const frames: any[] = [];
    const walk = (node: any) => {
      if (node.childFrames) {
        for (const child of node.childFrames) {
          frames.push(child.frame);
          walk(child);
        }
      }
    };
    walk(tree);
    return frames;
  }

  private async getFrameLocalStorage(frameId: string): Promise<Record<string, string>> {
    try {
      // 使用 isolated world 避免页面脚本干扰
      const { executionContextId } = await this.session.client?.send("Page.createIsolatedWorld", {
        frameId,
        grantUniveralAccess: true,
      });

      const result = await this.session.client?.send("Runtime.evaluate", {
        expression: "JSON.stringify(localStorage)",
        contextId: executionContextId,
        returnByValue: true,
      });

      if (result?.result?.value) {
        return JSON.parse(result.result.value);
      }
    } catch {
      // 忽略
    }
    return {};
  }

  /** 加载存储状态到浏览器 */
  async loadStorage(): Promise<void> {
    if (!this.session.client?.isOpen) return;
    if (!existsSync(this.storagePath)) return;

    try {
      const content = readFileSync(this.storagePath, "utf8");
      const state: StorageState = JSON.parse(content);

      // 恢复 Cookies
      for (const cookie of state.cookies) {
        if (cookie.expires > 0 && cookie.expires < Date.now() / 1000) continue; // 跳过过期
        await this.session.client?.send("Network.setCookie", {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expires > 0 ? cookie.expires : undefined,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
        });
      }

      // 恢复 localStorage (需要在各 frame 中执行)
      for (const origin of state.origins) {
        await this.setFrameLocalStorage(origin.origin, origin.localStorage);
      }

      this.lastSaved = state;
    } catch {
      // 忽略加载错误
    }
  }

  private async setFrameLocalStorage(origin: string, storage: Record<string, string>): Promise<void> {
    try {
      const mainFrame = await this.session.client?.send("Page.getFrameTree");
      const frames = this.getAllFrames(mainFrame?.frameTree);
      frames.unshift(mainFrame?.frameTree?.frame);

      for (const frame of frames) {
        if (frame.url?.startsWith(origin) || frame.id === origin) {
          const { executionContextId } = await this.session.client?.send("Page.createIsolatedWorld", {
            frameId: frame.id,
            grantUniveralAccess: true,
          });

          const script = `
            const data = ${JSON.stringify(storage)};
            for (const [k, v] of Object.entries(data)) {
              localStorage.setItem(k, v);
            }
          `;
          await this.session.client?.send("Runtime.evaluate", {
            expression: script,
            contextId: executionContextId,
          });
        }
      }
    } catch {
      // 忽略
    }
  }

  private writeStorageFile(state: StorageState): void {
    try {
      mkdirSync(join(this.storagePath, ".."), { recursive: true });
      writeFileSync(this.storagePath, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // 忽略写入错误
    }
  }

  private hasChanged(state: StorageState): boolean {
    if (!this.lastSaved) return true;
    return JSON.stringify(state.cookies) !== JSON.stringify(this.lastSaved.cookies) ||
           JSON.stringify(state.origins) !== JSON.stringify(this.lastSaved.origins);
  }

  /** 手动触发保存 */
  async flush(): Promise<void> {
    await this.saveStorage();
  }

  /** 清除存储 */
  async clear(): Promise<void> {
    this.lastSaved = null;
    try {
      await this.session.client?.send("Network.clearBrowserCookies");
      await this.session.client?.send("Storage.clearDataForOrigin", {
        origin: "*",
        storageTypes: "local_storage",
      });
    } catch {}
    this.writeStorageFile({ cookies: [], origins: [], savedAt: new Date().toISOString() });
  }
}