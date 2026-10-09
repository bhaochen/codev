/**
 * Browser Context Compaction - 专门针对 Browser Tool 的上下文压缩
 *
 * Browser 会话产生大量 token：
 * - elementsText: 编号的交互元素列表 (每次 observe 都会产生)
 * - pageText: 页面 markdown 内容
 * - screenshot: vision tokens (图片 base64)
 * - consoleText / networkText: 控制台和网络日志
 *
 * 策略：
 * 1. 监控 BrowserTool 产生的消息大小
 * 2. 当浏览器相关消息超过阈值时，触发专用摘要
 * 3. 摘要保留：访问的 URL、执行的关键动作、提取的数据、遇到的阻塞点
 * 4. 与现有 auto-compact 系统集成
 */

import { getBrowserContextCompactor, BrowserContextCompactor, ContextArchive } from "./contextCompaction.js";
import type { BrowserOutput } from "../../tools/BrowserTool/BrowserTool.js";

/** Browser 动作摘要条目 */
export interface BrowserActionSummary {
  step: number;
  action: string;
  url: string;
  target?: string;
  result: "success" | "noop" | "error";
  extractedData?: string;
  receipt?: string;
}

/** Browser 会话摘要 */
export interface BrowserSessionSummary {
  userGoal: string;
  urlsVisited: string[];
  keyActions: BrowserActionSummary[];
  extractedData: Record<string, string>;
  blockers: Array<{ type: string; resolution: string }>;
  currentUrl: string;
  currentTitle: string;
  nextStep: string;
}

/** Browser 摘要系统提示词 */
const BROWSER_SUMMARY_SYSTEM_PROMPT = `You are creating a concise summary of a BROWSER AUTOMATION session for context compaction.
The summary will replace early browser interactions to save tokens while preserving critical information.

PRESERVE EXACTLY:
- User's original goal and constraints
- URLs visited (in order)
- Key actions: click, fill, navigate, extract, etc. with their targets
- Data extracted (prices, text, links, structured data)
- Blockers encountered (captcha, login, consent, overlays) and how resolved
- Current page state (URL, title)
- The NEXT concrete step to take

FORMAT as JSON:
{
  "userGoal": "original user request in one sentence",
  "urlsVisited": ["https://example.com", "https://example.com/login"],
  "keyActions": [
    {"step": 1, "action": "navigate", "url": "https://example.com", "target": "", "result": "success", "receipt": "url → https://example.com · new document · dom changed (0→15 interactive) · 1200ms"},
    {"step": 3, "action": "click", "url": "https://example.com", "target": "Login button", "result": "success", "extractedData": "", "receipt": "url unchanged · same document · dom changed (15→18 interactive) · 350ms"}
  ],
  "extractedData": {"productPrice": "$29.99", "productTitle": "Widget Pro"},
  "blockers": [{"type": "consent banner", "resolution": "auto-dismissed via dismiss action"}],
  "currentUrl": "https://example.com/dashboard",
  "currentTitle": "Dashboard",
  "nextStep": "Click 'Settings' link (@12) to access configuration"
}

Be concise but precise. Use exact strings from observations.`;

export class BrowserContextManager {
  private compactor: BrowserContextCompactor;
  private browserMessageIndices: number[] = [];
  private lastBrowserActionIndex = 0;
  private actionSummaries: BrowserActionSummary[] = [];
  private extractedData: Record<string, string> = {};
  private visitedUrls: string[] = [];
  private blockers: Array<{ type: string; resolution: string }> = [];

  constructor() {
    this.compactor = getBrowserContextCompactor({
      // Browser 会话专用配置：更激进的压缩
      maxChars: 80_000,
      maxTokens: 60_000,
      triggerThreshold: 0.65, // 更早触发
      retainTurns: 2,
      summarizer: this.browserSummarizer.bind(this),
    });
  }

  /**
   * 记录 BrowserTool 的输出，用于后续摘要
   */
  recordBrowserAction(output: BrowserOutput, step: number): void {
    if (!output.ok && output.reason !== "coordinate_guessing") {
      // 记录错误但不计入摘要
      return;
    }

    const action = output.action;
    const url = output.url ?? "";
    const receipt = output.receipt ?? "";
    const target = this.extractTargetFromOutput(output);
    const extracted = this.extractDataFromOutput(output);

    const summary: BrowserActionSummary = {
      step,
      action,
      url,
      target,
      result: output.ok ? (output.receipt?.includes("NO OBSERVABLE EFFECT") ? "noop" : "success") : "error",
      extractedData: extracted,
      receipt,
    };

    this.actionSummaries.push(summary);

    // 记录 URL
    if (url && !this.visitedUrls.includes(url)) {
      this.visitedUrls.push(url);
    }

    // 记录提取的数据
    if (extracted) {
      const key = `${action}_${step}`;
      this.extractedData[key] = extracted;
    }

    // 检测阻塞点
    this.detectBlockers(output);

    this.lastBrowserActionIndex = this.browserMessageIndices.length;
  }

  private extractTargetFromOutput(output: BrowserOutput): string | undefined {
    // 从 message 或 receipt 中提取目标
    if (output.message.includes("@")) {
      const match = output.message.match(/@(\d+)/);
      if (match) return `ref @${match[1]}`;
    }
    if (output.message.includes('"')) {
      const match = output.message.match(/"([^"]+)"/);
      if (match) return match[1];
    }
    return undefined;
  }

  private extractDataFromOutput(output: BrowserOutput): string | undefined {
    // 从 extract、read、measure 等动作中提取关键数据
    if (output.action === "extract" && output.detailText) {
      return output.detailText.slice(0, 500);
    }
    if (output.action === "read" && output.pageText) {
      return output.pageText.slice(0, 300);
    }
    if (output.action === "measure" && output.detailText) {
      return output.detailText.slice(0, 300);
    }
    return undefined;
  }

  private detectBlockers(output: BrowserOutput): void {
    const text = (output.message + " " + output.warnings.join(" ")).toLowerCase();
    const blockerPatterns = [
      { pattern: /captcha/i, type: "captcha", resolution: "waiting for solver" },
      { pattern: /consent|cookie|gdpr/i, type: "consent banner", resolution: "auto-dismissed" },
      { pattern: /login|sign.?in|auth/i, type: "login required", resolution: "credentials needed" },
      { pattern: /overlay|modal|popup|dialog/i, type: "overlay", resolution: "dismissed via dismiss action" },
      { pattern: /blocked|denied|forbidden|403/i, type: "access denied", resolution: "security policy" },
      { pattern: /timeout|timed out/i, type: "timeout", resolution: "retry with longer wait" },
    ];

    for (const { pattern, type, resolution } of blockerPatterns) {
      if (pattern.test(text)) {
        const existing = this.blockers.find(b => b.type === type);
        if (!existing) {
          this.blockers.push({ type, resolution });
        }
      }
    }
  }

  /**
   * Browser 专用摘要生成器
   */
  private async browserSummarizer(
    messages: any[],
    systemPrompt: string
  ): Promise<string> {
    // 过滤出 browser 相关的消息
    const browserMessages = messages.filter(m => {
      if (m.role !== "user" && m.role !== "assistant") return false;
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return content.includes("Browser") ||
             content.includes("navigate") ||
             content.includes("click") ||
             content.includes("observe") ||
             content.includes("screenshot") ||
             content.includes("extract");
    });

    if (browserMessages.length === 0) {
      return JSON.stringify({
        userGoal: "Browser automation session",
        urlsVisited: this.visitedUrls,
        keyActions: this.actionSummaries,
        extractedData: this.extractedData,
        blockers: this.blockers,
        currentUrl: this.visitedUrls[this.visitedUrls.length - 1] ?? "",
        currentTitle: "",
        nextStep: "Continue browser automation",
      });
    }

    // 构建浏览器专用上下文
    const browserContext = `
BROWSER SESSION SUMMARY REQUEST:
Visited URLs: ${this.visitedUrls.join(" → ")}
Actions: ${this.actionSummaries.map(a => `${a.step}. ${a.action} ${a.target ?? ""} (${a.result})`).join("; ")}
Extracted: ${JSON.stringify(this.extractedData)}
Blockers: ${this.blockers.map(b => `${b.type}: ${b.resolution}`).join("; ")}
Current: ${this.visitedUrls[this.visitedUrls.length - 1] ?? "unknown"}
`;

    // 调用 LLM 生成摘要 (实际需要外部注入 summarizer)
    // 这里返回结构化摘要，实际摘要由外部 LLM 生成
    return JSON.stringify({
      userGoal: "Browser automation task (see conversation)",
      urlsVisited: this.visitedUrls,
      keyActions: this.actionSummaries.slice(-20), // 保留最近 20 个动作
      extractedData: this.extractedData,
      blockers: this.blockers,
      currentUrl: this.visitedUrls[this.visitedUrls.length - 1] ?? "",
      currentTitle: "",
      nextStep: "Continue from last action",
    });
  }

  /**
   * 检查是否需要压缩浏览器上下文
   */
  checkBrowserContextSize(messages: any[]): boolean {
    // 计算 browser 相关消息的大小
    let browserChars = 0;
    for (const msg of messages) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      if (content.includes("elementsText") ||
          content.includes("pageText") ||
          content.includes("screenshot") ||
          content.includes("vision") ||
          content.includes("consoleText") ||
          content.includes("networkText")) {
        browserChars += content.length;
      }
    }
    return browserChars > 50_000; // 50k chars 阈值
  }

  /**
   * 获取压缩统计
   */
  getStats() {
    return {
      actionCount: this.actionSummaries.length,
      urlsVisited: this.visitedUrls.length,
      extractedDataKeys: Object.keys(this.extractedData).length,
      blockers: this.blockers.length,
      ...this.compactor.getStats(),
    };
  }

  /** 重置状态 (新会话) */
  reset(): void {
    this.browserMessageIndices = [];
    this.lastBrowserActionIndex = 0;
    this.actionSummaries = [];
    this.extractedData = {};
    this.visitedUrls = [];
    this.blockers = [];
  }

  /** 获取存档列表 */
  listArchives() {
    return this.compactor.listArchives();
  }

  /** 读取存档 */
  readArchive(id: string) {
    return this.compactor.readArchive(id);
  }
}

/** 全局单例 */
let browserContextManager: BrowserContextManager | undefined;

export function getBrowserContextManager(): BrowserContextManager {
  if (!browserContextManager) {
    browserContextManager = new BrowserContextManager();
  }
  return browserContextManager;
}

export function resetBrowserContextManager(): void {
  browserContextManager = undefined;
}