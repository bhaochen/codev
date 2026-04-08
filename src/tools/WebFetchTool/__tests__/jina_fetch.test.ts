import { test, expect, describe, spyOn } from "bun:test";
import { jinaFetch } from "../jina_fetch"; // 确保路径正确

describe("WebFetchTool - Jina Fetch", () => {

  test("应该能成功抓取网页并返回格式化的 JSON", async () => {
    const testUrl = "https://httpbin.org/html";
    const resultJson = await jinaFetch(testUrl);

    // 1. 验证不为空
    expect(resultJson).not.toBeNull();

    if (resultJson) {
      const data = JSON.parse(resultJson);
      
      // 2. 验证关键字段是否符合 FetchResult 接口
      expect(data).toMatchObject({
        url: testUrl,
        extractor: "jina"
      });
      
      expect(typeof data.text).toBe("string");
      expect(typeof data.length).toBe("number");
      
      // 3. 验证内容不为空
      expect(data.text.length).toBeGreaterThan(0);
      
      // 4. 验证 Markdown 格式（Jina 默认行为）
      // httpbin.org/html 包含 <h1>，转换后应包含 #
      expect(data.text).toMatch(/#|Title/);

      console.log(`✅ 测试成功，抓取内容长度: ${data.length}`);
    }
  }, 30000); // Jina 有时响应较慢，放宽到 30s

  test("面对无效 URL 应该返回 null 而不崩溃", async () => {
    // 【修改点】使用 spyOn 拦截 console.error
    // 这样在测试运行时，预期的 400 错误日志就不会污染你的控制台
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    
    const invalidUrl = "https://not-a-real-url-123456.com";
    const result = await jinaFetch(invalidUrl);
    
    // 验证逻辑
    expect(result).toBeNull();
    
    // 验证确实触发了错误打印（可选）
    expect(errorSpy).toHaveBeenCalled();

    // 恢复控制台原有功能
    errorSpy.mockRestore();
  });

  test("面对空输入或非法格式应该直接返回 null", async () => {
    const result = await jinaFetch("");
    expect(result).toBeNull();
  });

});
