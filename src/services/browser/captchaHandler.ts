/**
 * CAPTCHA Handler - 参考 browser-use 的 CaptchaWatchdog
 *
 * 职责：
 * - 检测页面是否出现 CAPTCHA（reCAPTCHA, hCaptcha, Cloudflare 等）
 * - 等待用户手动解决或超时
 * - 可选：集成浏览器扩展 solver
 *
 * 检测策略：
 * - 常见 CAPTCHA iframe/容器选择器
 * - 页面文本关键词匹配
 * - 可选：CDP 自定义事件（需浏览器扩展支持）
 */

import { BrowserSessionService } from "./browserSession.js";

export interface CaptchaConfig {
  /** 超时时间 (ms, 默认 120_000 = 2分钟) */
  timeoutMs?: number;
  /** 是否自动检测 */
  autoDetect?: boolean;
  /** 浏览器扩展 solver 的 CDP 事件名 */
  solverEventName?: string;
}

/** 常见 CAPTCHA 选择器 */
const CAPTCHA_SELECTORS = [
  // reCAPTCHA
  'iframe[src*="recaptcha"]',
  '.g-recaptcha',
  '#recaptcha',
  '[data-sitekey]',
  // hCaptcha
  'iframe[src*="hcaptcha"]',
  '.h-captcha',
  '#hcaptcha',
  // Cloudflare
  '#cf-challenge-running',
  '.cf-turnstile',
  'iframe[src*="challenges.cloudflare.com"]',
  // Generic
  '[class*="captcha"]',
  '[id*="captcha"]',
  '[class*="challenge"]',
];

/** CAPTCHA 关键词 */
const CAPTCHA_KEYWORDS = [
  'captcha',
  'recaptcha',
  'hcaptcha',
  'i\'m not a robot',
  'verify you are human',
  'security check',
  'please verify',
  'challenge',
];

export class CaptchaHandler {
  private config: Required<CaptchaConfig>;
  private waiting = false;
  private waitStart = 0;
  private waitResolve?: (solved: boolean) => void;

  constructor(config: CaptchaConfig = {}) {
    this.config = {
      timeoutMs: config.timeoutMs ?? 120_000,
      autoDetect: config.autoDetect ?? true,
      solverEventName: config.solverEventName ?? 'BrowserUse.captchaSolverFinished',
    };
  }

  /**
   * 检测页面是否出现 CAPTCHA
   */
  async detect(session: BrowserSessionService): Promise<{ detected: boolean; type?: string }> {
    try {
      const result = await session.evaluate<{
        found: boolean;
        type?: string;
        selector?: string;
      }>(`
        (function() {
          // Check selectors
          const selectors = ${JSON.stringify(CAPTCHA_SELECTORS)};
          for (const sel of selectors) {
            try {
              if (document.querySelector(sel)) {
                const type = sel.includes('recaptcha') ? 'reCAPTCHA' :
                             sel.includes('hcaptcha') ? 'hCaptcha' :
                             sel.includes('cloudflare') || sel.includes('turnstile') ? 'Cloudflare' :
                             'unknown';
                return { found: true, type, selector: sel };
              }
            } catch (e) {}
          }

          // Check page text
          const text = document.body?.innerText?.toLowerCase() || '';
          const keywords = ${JSON.stringify(CAPTCHA_KEYWORDS)};
          for (const kw of keywords) {
            if (text.includes(kw)) {
              return { found: true, type: 'text-match', selector: kw };
            }
          }

          return { found: false };
        })()
      `, { timeoutMs: 5_000 });

      return { detected: result?.found ?? false, type: result?.type };
    } catch {
      return { detected: false };
    }
  }

  /**
   * 等待 CAPTCHA 解决
   * @returns true if solved, false if timeout
   */
  async waitForCaptcha(session: BrowserSessionService): Promise<boolean> {
    if (this.waiting) {
      return false; // Already waiting
    }

    this.waiting = true;
    this.waitStart = Date.now();

    return new Promise((resolve) => {
      this.waitResolve = resolve;

      // Poll for CAPTCHA disappearance
      const pollInterval = setInterval(async () => {
        if (!this.waiting) {
          clearInterval(pollInterval);
          return;
        }

        // Check timeout
        if (Date.now() - this.waitStart > this.config.timeoutMs) {
          this.waiting = false;
          clearInterval(pollInterval);
          resolve(false);
          return;
        }

        // Check if CAPTCHA is gone
        const { detected } = await this.detect(session);
        if (!detected) {
          this.waiting = false;
          clearInterval(pollInterval);
          resolve(true);
        }
      }, 2_000); // Poll every 2 seconds
    });
  }

  /**
   * 取消等待
   */
  cancel(): void {
    this.waiting = false;
    this.waitResolve?.(false);
    this.waitResolve = undefined;
  }

  /**
   * 检查是否正在等待
   */
  isWaiting(): boolean {
    return this.waiting;
  }

  /**
   * 获取等待信息
   */
  getWaitInfo(): { waiting: boolean; elapsed: number; timeout: number } | null {
    if (!this.waiting) return null;
    return {
      waiting: true,
      elapsed: Date.now() - this.waitStart,
      timeout: this.config.timeoutMs,
    };
  }
}

/** 全局单例 */
let captchaHandlerInstance: CaptchaHandler | undefined;

export function getCaptchaHandler(config?: CaptchaConfig): CaptchaHandler {
  if (!captchaHandlerInstance) {
    captchaHandlerInstance = new CaptchaHandler(config);
  }
  return captchaHandlerInstance;
}

export function resetCaptchaHandler(): void {
  captchaHandlerInstance = undefined;
}