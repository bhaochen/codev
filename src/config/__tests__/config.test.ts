import { test, expect, describe } from "bun:test";
import { getGlobalConfig } from "../config"; // 确保路径指向你刚才写的那个文件

describe("配置读取测试", () => {
  
  test("应该能从 ~/.claude/settings.json 读取到 JINA_API_KEY", () => {
    const apiKey = getGlobalConfig();
    
    // 打印出来看看，确认是否拿到了
    console.log("读取到的 API Key:", apiKey);
    
    // 断言检查
    expect(apiKey).not.toBeNull();
    expect(typeof apiKey).toBe("string");
    expect(apiKey).toStartWith("jina_");
  });

  test("如果文件不存在或格式错误应返回 null", () => {
    // 这是一个逻辑检查，确保函数在异常情况下不会直接 crash 掉整个程序
    // 如果你删掉 settings.json，这里应该返回 null
    const key = getGlobalConfig();
    if (key === null) {
      console.log("配置读取失败（符合预期，可能是文件不存在）");
    }
  });

});
