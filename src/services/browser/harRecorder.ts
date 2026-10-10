/**
 * HAR Recorder - 参考 browser-use 的 HarRecordingWatchdog
 *
 * 职责：
 * - 将 NetworkEntry 转换为 HAR 1.2 格式
 * - 导出为 .har 文件用于网络调试/性能分析
 *
 * HAR 格式规范: http://www.softwareishard.com/blog/har-12-spec/
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { NetworkEntry } from "./browserSession.js";

export interface HarConfig {
  /** 输出目录 */
  outputDir?: string;
  /** 是否包含请求体 */
  includePostData?: boolean;
  /** 是否包含响应体 (需要额外 CDP 调用) */
  includeResponseBody?: boolean;
}

/** HAR 1.2 格式类型 */
interface HarLog {
  log: {
    version: string;
    creator: {
      name: string;
      version: string;
    };
    browser?: {
      name: string;
      version: string;
    };
    pages: HarPage[];
    entries: HarEntry[];
  };
}

interface HarPage {
  startedDateTime: string;
  id: string;
  title: string;
  pageTimings: {
    onContentLoad: number;
    onLoad: number;
  };
}

interface HarEntry {
  pageref: string;
  startedDateTime: string;
  time: number;
  request: HarRequest;
  response: HarResponse;
  cache: object;
  timings: {
    blocked: number;
    dns: number;
    connect: number;
    send: number;
    wait: number;
    receive: number;
  };
}

interface HarRequest {
  method: string;
  url: string;
  httpVersion: string;
  cookies: Array<{ name: string; value: string }>;
  headers: Array<{ name: string; value: string }>;
  queryString: Array<{ name: string; value: string }>;
  postData?: {
    mimeType: string;
    text: string;
    params?: Array<{ name: string; value?: string; fileName?: string }>;
  };
  headersSize: number;
  bodySize: number;
}

interface HarResponse {
  status: number;
  statusText: string;
  httpVersion: string;
  cookies: Array<{ name: string; value: string }>;
  headers: Array<{ name: string; value: string }>;
  content: {
    size: number;
    mimeType: string;
    text?: string;
  };
  redirectURL: string;
  headersSize: number;
  bodySize: number;
}

const DEFAULT_CONFIG: Required<HarConfig> = {
  outputDir: join(homedir(), ".codev", "browser-har"),
  includePostData: false,
  includeResponseBody: false,
};

export class HarRecorder {
  private config: Required<HarConfig>;

  constructor(config: HarConfig = {}) {
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
   * 将 NetworkEntry 数组转换为 HAR 格式并导出
   */
  async export(
    entries: NetworkEntry[],
    metadata: { url?: string; title?: string; tabId?: string } = {}
  ): Promise<string | null> {
    if (entries.length === 0) {
      return null;
    }

    const pageId = metadata.tabId ?? "page_1";
    const startedDateTime = new Date(entries[0]?.ts ?? Date.now()).toISOString();

    const har: HarLog = {
      log: {
        version: "1.2",
        creator: {
          name: "Codev Browser Tool",
          version: "1.0.0",
        },
        pages: [
          {
            startedDateTime,
            id: pageId,
            title: metadata.title ?? metadata.url ?? "Recording",
            pageTimings: {
              onContentLoad: -1,
              onLoad: -1,
            },
          },
        ],
        entries: entries.map(entry => this.convertEntry(entry, pageId)),
      },
    };

    const filename = `har_${Date.now()}.har`;
    const outputPath = join(this.config.outputDir, filename);
    writeFileSync(outputPath, JSON.stringify(har, null, 2), "utf8");
    return outputPath;
  }

  private convertEntry(entry: NetworkEntry, pageId: string): HarEntry {
    const startedDateTime = new Date(entry.ts).toISOString();
    const method = entry.method;
    const url = entry.url;

    // 解析 URL 参数
    const queryString: Array<{ name: string; value: string }> = [];
    try {
      const urlObj = new URL(url);
      for (const [key, value] of urlObj.searchParams) {
        queryString.push({ name: key, value });
      }
    } catch {
      // ignore
    }

    // 解析请求体
    const postData: HarRequest["postData"] | undefined = entry.postData
      ? {
          mimeType: "application/x-www-form-urlencoded",
          text: entry.postData,
        }
      : undefined;

    return {
      pageref: pageId,
      startedDateTime,
      time: entry.finished ? 100 : -1, // 近似值
      request: {
        method,
        url,
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: [],
        queryString,
        ...(postData ? { postData } : {}),
        headersSize: -1,
        bodySize: entry.postData ? entry.postData.length : 0,
      },
      response: {
        status: entry.status ?? 0,
        statusText: entry.error ?? "",
        httpVersion: "HTTP/1.1",
        cookies: [],
        headers: [],
        content: {
          size: 0,
          mimeType: entry.mime ?? "unknown",
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: 0,
      },
      cache: {},
      timings: {
        blocked: -1,
        dns: -1,
        connect: -1,
        send: 0,
        wait: entry.finished ? 50 : -1,
        receive: entry.finished ? 50 : -1,
      },
    };
  }

  /**
   * 获取导出目录
   */
  getOutputDir(): string {
    return this.config.outputDir;
  }
}

/** 全局单例 */
let harRecorderInstance: HarRecorder | undefined;

export function getHarRecorder(config?: HarConfig): HarRecorder {
  if (!harRecorderInstance) {
    harRecorderInstance = new HarRecorder(config);
  }
  return harRecorderInstance;
}

export function resetHarRecorder(): void {
  harRecorderInstance = undefined;
}