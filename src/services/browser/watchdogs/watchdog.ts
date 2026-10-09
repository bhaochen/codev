/**
 * Watchdog 基类 - 参考 browser-use 的 BaseWatchdog 模式
 *
 * 设计原则：
 * 1. 每个 watchdog 负责单一横切关注点
 * 2. 通过事件总线通信，watchdog 间解耦
 * 3. 支持条件启用 (配置驱动)
 * 4. 生命周期: attach -> 运行 -> detach
 */

import { EventEmitter } from "events";
import { BrowserSessionService } from "../browserSession.js";

export interface WatchdogConfig {
  /** 是否启用此 watchdog */
  enabled?: boolean;
  /** watchdog 特定配置 */
  [key: string]: unknown;
}

/** Watchdog 生命周期事件 */
export type WatchdogEvent =
  | { type: "browser:launch"; headless: boolean }
  | { type: "browser:connected"; cdpUrl: string }
  | { type: "browser:disconnect"; reason: string }
  | { type: "browser:stop" }
  | { type: "tab:created"; targetId: string; url: string }
  | { type: "tab:closed"; targetId: string }
  | { type: "tab:activated"; targetId: string }
  | { type: "navigation:started"; targetId: string; url: string }
  | { type: "navigation:completed"; targetId: string; url: string }
  | { type: "action:before"; action: string; targetRef?: number }
  | { type: "action:after"; action: string; effect: string }
  | { type: "download:started"; targetId: string; url: string; suggestedFilename: string }
  | { type: "download:progress"; targetId: string; progress: number }
  | { type: "download:completed"; targetId: string; path: string }
  | { type: "download:failed"; targetId: string; error: string }
  | { type: "console:message"; targetId: string; level: string; text: string }
  | { type: "network:request"; targetId: string; requestId: string; url: string; method: string }
  | { type: "network:response"; targetId: string; requestId: string; status: number }
  | { type: "network:finished"; targetId: string; requestId: string }
  | { type: "dialog:opened"; targetId: string; type: string; message: string }
  | { type: "permission:requested"; targetId: string; permissions: string[] }
  | { type: "captcha:started" }
  | { type: "captcha:finished"; solved: boolean }
  | { type: "error"; targetId?: string; message: string; cause?: string };

/** 事件总线 - 简化版 EventEmitter */
export class WatchdogEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  /** 发布事件 */
  emitEvent(event: WatchdogEvent): void {
    this.emit("event", event);
    this.emit(event.type, event);
  }

  /** 订阅所有事件 */
  onEvent(listener: (event: WatchdogEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }

  /** 订阅特定类型事件 */
  onType<T extends WatchdogEvent["type"]>(type: T, listener: (event: Extract<WatchdogEvent, { type: T }>) => void): () => void {
    this.on(type, listener as any);
    return () => this.off(type, listener as any);
  }
}

/** Watchdog 基类 */
export abstract class BaseWatchdog {
  protected bus: WatchdogEventBus;
  protected session: BrowserSessionService;
  protected config: WatchdogConfig;
  protected enabled: boolean;
  private attached = false;

  constructor(bus: WatchdogEventBus, session: BrowserSessionService, config: WatchdogConfig = {}) {
    this.bus = bus;
    this.session = session;
    this.config = config;
    this.enabled = config.enabled !== false;
  }

  /** Watchdog 名称 (用于日志/调试) */
  abstract get name(): string;

  /** 声明监听的事件类型 (用于验证和文档) */
  abstract get listensTo(): WatchdogEvent["type"][];

  /** 声明发出的事件类型 */
  abstract get emits(): WatchdogEvent["type"][];

  /** 挂载到会话 - 子类可重写注册特定监听器 */
  attach(): void {
    if (this.attached || !this.enabled) return;
    this.attached = true;
    this.registerListeners();
    this.onAttach?.();
  }

  /** 卸载 */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.onDetach?.();
    this.removeAllListeners();
  }

  /** 子类重写: 注册事件监听器 */
  protected abstract registerListeners(): void;

  /** 子类可选: 挂载后钩子 */
  protected onAttach?(): void;

  /** 子类可选: 卸载前钩子 */
  protected onDetach?(): void;

  /** 安全发布事件 */
  protected emit(event: WatchdogEvent): void {
    if (this.attached) {
      this.bus.emitEvent(event);
    }
  }

  /** 检查是否已挂载 */
  isAttached(): boolean {
    return this.attached;
  }

  /** 获取配置值 */
  protected getConfig<T>(key: string, defaultValue: T): T {
    return (this.config[key] as T) ?? defaultValue;
  }
}

/** Watchdog 管理器 - 负责创建、挂载、卸载所有 watchdog */
export class WatchdogManager {
  private bus = new WatchdogEventBus();
  private watchdogs: BaseWatchdog[] = [];
  private session: BrowserSessionService;

  constructor(session: BrowserSessionService) {
    this.session = session;
  }

  /** 获取事件总线 (供外部发布事件) */
  getBus(): WatchdogEventBus {
    return this.bus;
  }

  /** 注册 watchdog */
  register(watchdog: BaseWatchdog): void {
    this.watchdogs.push(watchdog);
  }

  /** 挂载所有已注册的 watchdog */
  attachAll(): void {
    for (const wd of this.watchdogs) {
      wd.attach();
    }
  }

  /** 卸载所有 watchdog */
  detachAll(): void {
    for (const wd of this.watchdogs) {
      wd.detach();
    }
  }

  /** 获取已挂载的 watchdog 列表 */
  getAttached(): BaseWatchdog[] {
    return this.watchdogs.filter(w => w.isAttached());
  }

  /** 发布事件 (内部/外部调用) */
  emit(event: WatchdogEvent): void {
    this.bus.emitEvent(event);
  }
}