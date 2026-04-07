import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * 从 ~/.claude/settings.json 中读取配置
 */
export function getGlobalConfig() {
  // 1. 定位路径: /home/yuki/.claude/settings.json
  // 使用 os.homedir() 保证跨平台兼容性
  const configPath = path.join(os.homedir(), '.claude', 'settings.json');

  try {
    // 2. 读取文件内容
    const fileContent = fs.readFileSync(configPath, 'utf-8');
    
    // 3. 解析 JSON
    const config = JSON.parse(fileContent);
    
    // 4. 返回 env 对象中的 JINA_API_KEY
    return config?.env?.JINA_API_KEY || null;
  } catch (error) {
    console.error(`无法读取配置文件: ${configPath}`, error);
    return null;
  }
}
