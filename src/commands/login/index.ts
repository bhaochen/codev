// index.ts = 命令的"声明 + 注册"

import type { Command } from '../../commands.js'

// 把 login 注册成一个 CLI 命令, 优点: 1.更快启动, 2.模块解耦, 3.插件化
export default () =>
  ({
    type: 'local-jsx', // 说明这个命令不是 普通函数, 而是 返回一个 JSX UI (React + Ink), 这个 CLI 命令会渲染一个 "界面", 而不是直接输出文本
    name: 'login', // CLI 命名
    description: 'Authentication is managed by the configured model gateway',
    isEnabled: () => false,
    load: () => import('./login.js'), // 懒加载核心逻辑: CLI 启动的时候不会加载 /login 代码, 只有执行 /login 时才加载
  }) satisfies Command
