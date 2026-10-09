/**
 * SecurityWatchdog - 参考 browser-use 的 SecurityWatchdog
 *
 * 职责：强制执行 allowed_domains / prohibited_domains URL 策略
 * - 拦截导航请求
 * - 支持 glob 模式
 * - 阻止 IP 地址访问
 * - 重定向被拦截 URL 到 about:blank
 */

import { BaseWatchdog, WatchdogEvent, WatchdogConfig } from "./watchdog.js";
import { BrowserSessionService } from "../browserSession.js";

export interface SecurityWatchdogConfig extends WatchdogConfig {
  /** 允许访问的域名列表 (支持 glob: *.example.com) */
  allowedDomains?: string[];
  /** 禁止访问的域名列表 */
  prohibitedDomains?: string[];
  /** 是否阻止 IP 地址访问 */
  blockIPAddresses?: boolean;
  /** 被拦截时重定向到的 URL */
  blockedRedirectUrl?: string;
}

const DEFAULT_BLOCKED_REDIRECT = "about:blank";

/** 将 glob 模式转为正则 */
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // 转义特殊字符
    .replace(/\*/g, ".*")                     // * -> .*
    .replace(/\?/g, ".");                     // ? -> .
  return new RegExp(`^${escaped}$`, "i");
}

/** 检查 URL 是否匹配域名模式列表 */
function matchDomainPatterns(url: string, patterns: string[]): boolean {
  try {
    const hostname = new URL(url).hostname;
    return patterns.some(pattern => globToRegex(pattern).test(hostname));
  } catch {
    return false;
  }
}

/** 检查是否为 IP 地址 */
function isIPAddress(hostname: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) ||
         /^\[?[0-9a-fA-F:]+\]?$/.test(hostname); // IPv6
}

export class SecurityWatchdog extends BaseWatchdog {
  readonly name = "SecurityWatchdog";
  readonly listensTo: WatchdogEvent["type"][] = ["navigation:started"];
  readonly emits: WatchdogEvent["type"][] = ["error"];

  private allowedPatterns: RegExp[] = [];
  private prohibitedPatterns: RegExp[] = [];
  private blockIPs: boolean;
  private redirectUrl: string;

  constructor(bus: any, session: BrowserSessionService, config: SecurityWatchdogConfig = {}) {
    super(bus, session, config);
    this.blockIPs = config.blockIPAddresses ?? true;
    this.redirectUrl = config.blockedRedirectUrl ?? DEFAULT_BLOCKED_REDIRECT;
    this.compilePatterns(config.allowedDomains ?? [], config.prohibitedDomains ?? []);
  }

  private compilePatterns(allowed: string[], prohibited: string[]): void {
    this.allowedPatterns = allowed.map(globToRegex);
    this.prohibitedPatterns = prohibited.map(globToRegex);
  }

  protected registerListeners(): void {
    this.bus.onType("navigation:started", this.onNavigationStarted.bind(this));
  }

  private async onNavigationStarted(event: Extract<WatchdogEvent, { type: "navigation:started" }>): Promise<void> {
    const { targetId, url } = event;

    // 检查是否被拦截
    const blocked = this.checkUrl(url);
    if (!blocked) return;

    // 发出错误事件
    this.emit({
      type: "error",
      targetId,
      message: `Navigation blocked by security policy: ${url}`,
      cause: blocked.reason,
    });

    // 重定向到 about:blank (通过 CDP 修改请求或直接导航)
    try {
      await this.session.navigate(this.redirectUrl);
    } catch {
      // 忽略重定向失败
    }
  }

  /** 检查 URL 是否被安全策略拦截，返回拦截原因或 null */
  checkUrl(url: string): { reason: string } | null {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname;

      // 1. IP 地址检查
      if (this.blockIPs && isIPAddress(hostname)) {
        return { reason: `IP address access blocked: ${hostname}` };
      }

      // 2. 禁止列表优先 (显式禁止)
      if (this.prohibitedPatterns.length > 0 && matchDomainPatterns(url, this.prohibitedPatterns)) {
        return { reason: `Domain prohibited: ${hostname}` };
      }

      // 3. 允许列表 (若配置了允许列表，则默认拒绝所有其他)
      if (this.allowedPatterns.length > 0 && !matchDomainPatterns(url, this.allowedPatterns)) {
        return { reason: `Domain not in allowed list: ${hostname}` };
      }

      return null;
    } catch {
      return { reason: `Invalid URL: ${url}` };
    }
  }

  /** 运行时更新策略 */
  updatePolicy(allowedDomains?: string[], prohibitedDomains?: string[]): void {
    this.compilePatterns(allowedDomains ?? [], prohibitedDomains ?? []);
  }
}