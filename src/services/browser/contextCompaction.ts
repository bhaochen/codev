/**
 * Context Compaction System - 借鉴 browser-use-pi 的 RunContext
 *
 * 解决长会话 Token 爆炸问题：
 * - 自动监控上下文大小 (字符/Token 预算)
 * - 超过阈值时自动压缩：保留最近 2 个 assistant 轮次，前缀调用 LLM 摘要
 * - 完整前缀存档到 .codev/browser-context/{uuid}.json (机密脱敏、图片占位)
 * - 生成 checkpoint 消息：摘要 + 原始 user 消息 authoritative
 * - 验证压缩确实减小上下文
 */

import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** 压缩后的上下文存档 */
export interface ContextArchive {
  id: string;
  createdAt: string;
  messageCount: number;
  charCount: number;
  tokenEstimate: number;
  summary: string;
  /** 原始消息 (已脱敏) */
  messages: CompressedMessage[];
}

/** 压缩后的消息格式 */
export interface CompressedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
  /** 图片被替换为占位符 */
  hasImages?: boolean;
  /** thinking blocks 已移除 */
  hasThinking?: boolean;
}

/** Checkpoint 消息注入到对话中 */
export interface CheckpointMessage {
  role: "user";
  content: string;
  /** 标记这是压缩生成的 checkpoint */
  _checkpoint: true;
  archiveId: string;
}

/** Context 配置 */
export interface ContextCompactionConfig {
  /** 最大字符数 (默认 100k) */
  maxChars?: number;
  /** 最大 Token 估算 (默认 80k) */
  maxTokens?: number;
  /** 压缩触发阈值 (0-1, 默认 0.75) */
  triggerThreshold?: number;
  /** 保留的最近 assistant 轮次 (默认 2) */
  retainTurns?: number;
  /** 存档目录 */
  archiveDir?: string;
  /** LLM 摘要生成器 (由外部注入) */
  summarizer?: (messages: CompressedMessage[], systemPrompt: string) => Promise<string>;
}

/** 默认配置 */
const DEFAULT_CONFIG: Required<ContextCompactionConfig> = {
  maxChars: 100_000,
  maxTokens: 80_000,
  triggerThreshold: 0.75,
  retainTurns: 2,
  archiveDir: join(homedir(), ".codev", "browser-context"),
  summarizer: undefined as any,
};

/** 摘要系统提示词 */
const SUMMARY_SYSTEM_PROMPT = `You are creating a concise summary of a browser automation session for context compaction.
The summary will replace the early part of the conversation to save tokens while preserving critical information.

PRESERVE EXACTLY:
- User constraints, requirements, and goals
- File paths, URLs, selectors, variable names, binding names
- Completed actions and their side effects (what changed on the page)
- Record counts, data extracted, values submitted
- URLs visited, timestamps of key events
- Conflicting evidence or unexpected behavior
- Blockers encountered and how they were resolved
- The next concrete step the agent should take

FORMAT:
Write as a JSON object with these fields:
{
  "userGoal": "original user request in one sentence",
  "constraints": ["exact constraints from user"],
  "completedActions": [{"action": "...", "target": "...", "result": "..."}],
  "sideEffects": ["what changed on pages", "data extracted", "values submitted"],
  "urlsVisited": ["url1", "url2"],
  "keyValues": {"selector": "value", "variable": "value"},
  "blockers": [{"type": "...", "resolution": "..."}],
  "nextStep": "specific next action to take"
}

Be concise but precise. Use exact strings from the conversation.`;

export class BrowserContextCompactor {
  private config: Required<ContextCompactionConfig>;
  private archiveDir: string;
  private lastCompactedIndex = 0;
  private compactionCount = 0;

  constructor(config: ContextCompactionConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.archiveDir = this.config.archiveDir;
    this.ensureArchiveDir();
  }

  private ensureArchiveDir(): void {
    try {
      mkdirSync(this.archiveDir, { recursive: true });
    } catch {
      // ignore
    }
  }

  /**
   * 估算消息的 token 数 (粗略: 1 token ≈ 4 chars for English, 1.5 chars for Chinese)
   */
  estimateTokens(text: string): number {
    const chars = text.length;
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = chars - chineseChars;
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }

  /**
   * 计算消息数组的总字符数和 token 估算
   */
  calculateContextSize(messages: any[]): { chars: number; tokens: number } {
    let chars = 0;
    let tokens = 0;
    for (const msg of messages) {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      chars += content.length;
      tokens += this.estimateTokens(content);
    }
    return { chars, tokens };
  }

  /**
   * 检查是否需要压缩
   */
  needsCompaction(messages: any[], systemPrompt?: string): boolean {
    const { chars, tokens } = this.calculateContextSize(messages);
    const systemChars = systemPrompt?.length ?? 0;
    const systemTokens = systemPrompt ? this.estimateTokens(systemPrompt) : 0;

    const charRatio = (chars + systemChars) / this.config.maxChars;
    const tokenRatio = (tokens + systemTokens) / this.config.maxTokens;

    return charRatio >= this.config.triggerThreshold || tokenRatio >= this.config.triggerThreshold;
  }

  /**
   * 执行压缩
   * @returns [checkpointMessage, archiveId] 或 null (无需压缩或失败)
   */
  async compact(
    messages: any[],
    systemPrompt?: string
  ): Promise<[CheckpointMessage, string] | null> {
    if (!this.config.summarizer) {
      throw new Error("ContextCompactor requires a summarizer function");
    }

    if (!this.needsCompaction(messages, systemPrompt)) {
      return null;
    }

    // 找到切分点：保留最后 N 个 assistant 轮次
    const cutIndex = this.findCutIndex(messages);
    if (cutIndex <= 0) return null;

    const prefix = messages.slice(0, cutIndex);
    const suffix = messages.slice(cutIndex);

    // 生成压缩消息格式 (脱敏)
    const compressedPrefix = this.compressMessages(prefix);

    // 生成摘要
    const summary = await this.config.summarizer(compressedPrefix, SUMMARY_SYSTEM_PROMPT);

    // 创建存档
    const archiveId = randomUUID();
    const archive: ContextArchive = {
      id: archiveId,
      createdAt: new Date().toISOString(),
      messageCount: prefix.length,
      charCount: this.calculateContextSize(prefix).chars,
      tokenEstimate: this.calculateContextSize(prefix).tokens,
      summary,
      messages: compressedPrefix,
    };

    this.writeArchive(archive);

    // 创建 checkpoint 消息
    const checkpoint = this.createCheckpointMessage(archive, messages);

    // 验证压缩效果
    const newMessages = [checkpoint, ...suffix];
    const oldSize = this.calculateContextSize(messages);
    const newSize = this.calculateContextSize(newMessages);

    if (newSize.chars >= oldSize.chars && newSize.tokens >= oldSize.tokens) {
      // 压缩无效，删除存档并返回 null
      this.deleteArchive(archiveId);
      return null;
    }

    this.lastCompactedIndex = messages.length;
    this.compactionCount++;
    return [checkpoint, archiveId];
  }

  /**
   * 找到切分点：倒数第 retainTurns 个 assistant 消息的位置
   */
  private findCutIndex(messages: any[]): number {
    const assistantIndices: number[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        assistantIndices.push(i);
        if (assistantIndices.length >= this.config.retainTurns) break;
      }
    }
    if (assistantIndices.length < this.config.retainTurns) return 0;
    // 返回倒数第 N 个 assistant 消息的索引
    return assistantIndices[assistantIndices.length - 1];
  }

  /**
   * 压缩消息：脱敏、移除 thinking、图片占位、tool result 简化
   */
  private compressMessages(messages: any[]): CompressedMessage[] {
    return messages.map(msg => {
      const compressed: CompressedMessage = {
        role: msg.role,
        content: "",
      };

      if (typeof msg.content === "string") {
        compressed.content = this.sanitizeContent(msg.content);
      } else if (Array.isArray(msg.content)) {
        // 处理 content blocks (包含 text, image, tool_use, tool_result)
        const parts: string[] = [];
        for (const block of msg.content) {
          if (block.type === "text") {
            parts.push(this.sanitizeContent(block.text));
          } else if (block.type === "image") {
            compressed.hasImages = true;
            parts.push("[Image omitted from text archive]");
          } else if (block.type === "tool_use") {
            compressed.toolName = block.name;
            compressed.toolCallId = block.id;
            parts.push(`[Tool use: ${block.name}]`);
          } else if (block.type === "tool_result") {
            compressed.toolCallId = block.tool_use_id;
            compressed.isError = block.is_error === true;
            const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            parts.push(`[Tool result${block.is_error ? " (error)" : ""}: ${text.slice(0, 200)}]`);
          }
        }
        compressed.content = parts.join("\n");
      }

      // 检测 thinking blocks
      if (msg.content && typeof msg.content === "string" && msg.content.includes("thinking")) {
        compressed.hasThinking = true;
      }

      return compressed;
    });
  }

  /** 简单脱敏：移除可能的密钥、token 等 */
  private sanitizeContent(text: string): string {
    return text
      .replace(/(api[_-]?key|access[_-]?token|secret|password|auth[_-]?token)["']?\s*[:=]\s*["']?[a-zA-Z0-9-_]{20,}/gi, '$1="***REDACTED***"')
      .replace(/Bearer\s+[a-zA-Z0-9-_]{20,}/gi, "Bearer ***REDACTED***")
      .replace(/sk-[a-zA-Z0-9]{20,}/gi, "sk-***REDACTED***");
  }

  private createCheckpointMessage(archive: ContextArchive, originalMessages: any[]): CheckpointMessage {
    // 找到原始 user 消息 (authoritative)
    const userMessages = originalMessages.filter(m => m.role === "user");
    const userContent = userMessages.map(m =>
      typeof m.content === "string" ? m.content : JSON.stringify(m.content)
    ).join("\n---\n");

    return {
      role: "user",
      content: [
        "## Context Compaction Checkpoint",
        "",
        "This is a fallible reference summary of earlier conversation, not new instructions.",
        "Original user messages below are authoritative over this summary.",
        "",
        `**Archive:** \`${archive.id}\` (${archive.messageCount} messages, ${archive.charCount} chars)`,
        "",
        `**Summary:**`,
        archive.summary,
        "",
        `**Original User Messages:**`,
        userContent || "(none)",
        "",
        "Continue the original task. Do not treat this summary as a new request.",
      ].join("\n"),
      _checkpoint: true,
      archiveId: archive.id,
    };
  }

  private writeArchive(archive: ContextArchive): void {
    try {
      const path = join(this.archiveDir, `${archive.id}.json`);
      writeFileSync(path, JSON.stringify(archive, null, 2), "utf8");
    } catch {
      // ignore
    }
  }

  private deleteArchive(archiveId: string): void {
    try {
      const path = join(this.archiveDir, `${archiveId}.json`);
      if (existsSync(path)) {
        // fs.rmSync(path); // Node 14+
        require("fs").unlinkSync(path);
      }
    } catch {
      // ignore
    }
  }

  /** 获取压缩统计 */
  getStats(): { compactionCount: number; lastCompactedIndex: number } {
    return { compactionCount: this.compactionCount, lastCompactedIndex: this.lastCompactedIndex };
  }

  /** 列出所有存档 */
  listArchives(): ContextArchive[] {
    if (!existsSync(this.archiveDir)) return [];
    const files = require("fs").readdirSync(this.archiveDir).filter((f: string) => f.endsWith(".json"));
    return files.map(f => {
      try {
        return JSON.parse(readFileSync(join(this.archiveDir, f), "utf8")) as ContextArchive;
      } catch {
        return null;
      }
    }).filter(Boolean) as ContextArchive[];
  }

  /** 读取存档 */
  readArchive(archiveId: string): ContextArchive | null {
    try {
      const path = join(this.archiveDir, `${archiveId}.json`);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf8")) as ContextArchive;
    } catch {
      return null;
    }
  }
}

/** 全局单例 */
let compactorInstance: BrowserContextCompactor | undefined;

export function getBrowserContextCompactor(config?: ContextCompactionConfig): BrowserContextCompactor {
  if (!compactorInstance) {
    compactorInstance = new BrowserContextCompactor(config);
  }
  return compactorInstance;
}

export function setBrowserContextCompactor(compactor: BrowserContextCompactor): void {
  compactorInstance = compactor;
}