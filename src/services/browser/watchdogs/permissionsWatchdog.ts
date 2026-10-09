/**
 * PermissionsWatchdog - 参考 browser-use 的 PermissionsWatchdog
 *
 * 职责：自动授予浏览器权限
 * - clipboard-read/write
 * - camera/microphone
 * - geolocation
 * - notifications
 * - 等
 */

import { BaseWatchdog, WatchdogEvent, WatchdogConfig } from "./watchdog.js";
import { BrowserSessionService } from "../browserSession.js";

export interface PermissionsWatchdogConfig extends WatchdogConfig {
  /** 预授权的权限列表 */
  permissions?: string[];
  /** 是否自动接受所有权限请求 */
  autoAccept?: boolean;
}

const DEFAULT_PERMISSIONS = [
  "clipboard-read",
  "clipboard-write",
  "camera",
  "microphone",
  "geolocation",
  "notifications",
  "midi",
  "midi-sysex",
] as const;

export class PermissionsWatchdog extends BaseWatchdog {
  readonly name = "PermissionsWatchdog";
  readonly listensTo: WatchdogEvent["type"][] = ["browser:connected", "permission:requested"];
  readonly emits: WatchdogEvent["type"][] = [];

  private permissions: string[];
  private autoAccept: boolean;
  private granted = new Set<string>();

  constructor(bus: any, session: BrowserSessionService, config: PermissionsWatchdogConfig = {}) {
    super(bus, session, config);
    this.permissions = config.permissions ?? [...DEFAULT_PERMISSIONS];
    this.autoAccept = config.autoAccept ?? true;
  }

  protected registerListeners(): void {
    this.bus.onType("browser:connected", this.onBrowserConnected.bind(this));
    this.bus.onType("permission:requested", this.onPermissionRequested.bind(this));
  }

  private async onBrowserConnected(event: Extract<WatchdogEvent, { type: "browser:connected" }>): Promise<void> {
    // 浏览器连接后自动授予预设权限
    for (const permission of this.permissions) {
      await this.grantPermission(permission);
    }
  }

  private async onPermissionRequested(event: Extract<WatchdogEvent, { type: "permission:requested" }>): Promise<void> {
    if (!this.autoAccept) return;

    for (const permission of event.permissions) {
      await this.grantPermission(permission);
    }
  }

  /** 通过 CDP 授予权限 */
  private async grantPermission(permission: string): Promise<void> {
    if (this.granted.has(permission)) return;

    try {
      await this.session.client?.send("Browser.grantPermissions", {
        permissions: [permission],
        origin: "*", // 所有源
      });
      this.granted.add(permission);
    } catch {
      // 忽略授权失败 (某些权限可能不支持或已弃用)
    }
  }

  /** 运行时添加权限 */
  addPermission(permission: string): void {
    if (!this.permissions.includes(permission)) {
      this.permissions.push(permission);
    }
  }
}