import axios from 'axios';
import { getGlobalConfig } from "../../config/config";

const JINA_API_KEY = getGlobalConfig() || process.env.JINA_API_KEY;
const SEARCH_ENDPOINT = "https://s.jina.ai/";

interface SearchItem {
  title: string;
  url: string;
  content: string;
}

function formatResults(query: string, items: SearchItem[]): string {
  if (items.length === 0) return `No results for: ${query}`;
  
  let output = `Results for: ${query}\n\n`;
  items.forEach((item, i) => {
    output += `${i + 1}. ${item.title}\n   ${item.url}\n   ${item.content}\n\n`;
  });
  return output.trim();
}

/**
 * 执行 Jina 搜索
 */
export async function jinaSearch(query: string, n: number = 5): Promise<string> {
  // 增加对 key 的存在性校验
  if (!JINA_API_KEY) {
    return "Error: JINA_API_KEY not set";
  }

  try {
    // 【关键修改】使用路径拼接而不是 params，并进行编码
    const requestUrl = `${SEARCH_ENDPOINT}${encodeURIComponent(query)}`;

    const response = await axios.get(requestUrl, {
      headers: {
        'Authorization': `Bearer ${JINA_API_KEY}`,
        'Accept': 'application/json',
        // 显式指定 User-Agent 有助于减少被某些网关拒绝的概率
        'User-Agent': 'Mozilla/5.0 (compatible; Bun/1.1; Axios)'
      },
      // 搜索通常比抓取慢，稍微延长超时
      timeout: 20000 
    });

    // 结构化解析
    const rawData = response.data?.data || [];
    const items: SearchItem[] = rawData.slice(0, n).map((d: any) => ({
      title: (d.title || "No Title").trim(),
      url: d.url || "",
      content: (d.content || "").slice(0, 500).replace(/\s+/g, ' ').trim()
    }));

    return formatResults(query, items);
  } catch (error: any) {
    // 增加更详细的错误捕获，方便测试识别
    const errMsg = error.response?.data?.message || error.message;
    return `Error: ${errMsg}`;
  }
}
