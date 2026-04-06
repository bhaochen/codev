/* TUI/CLI 中渲染 Web 工具调用过程的 UI 组件集合, 基于 React(类似于Ink的终端 React 框架)
 * 显示
 * 「工具调用参数」
 * 「工具执行中」状态
 * 「工具返回结果」
 * 本质
 * 「Tool UI Renderer」工具可视化层
  */
import React from 'react';
import { MessageResponse } from '../../components/MessageResponse.js'; // UI 组件: 用来包裹一条“消息" (类似聊天气泡)
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'; // 常量: 工具摘要最大长度
import { Box, Text } from '../../ink.js'; // Box: 布局(类似 div), Text: 文本, 来自 Ink (终端版React)
import type { ToolProgressData } from '../../Tool.js'; // 工具执行过程中的数据结构, TypeScript 类型 (仅类型, 不参与运行)
import type { ProgressMessage } from '../../types/message.js'; // 类型: 进度消息 
import { formatFileSize, truncate } from '../../utils/format.js'; // 工具函数: 字节 -> 可读大小 (KB/MB), truncate 截断字符串
import type { Output } from './WebFetchTool.js'; // Web 工具返回结果的类型

// 工具调用的时候 - 渲染工具使用的消息
export function renderToolUseMessage({
  url, // 要访问的 网址
  prompt // 附带提示词
}: Partial<{ // 意味着这两个字段可以没有
  url: string;
  prompt: string;
}>, {
  verbose // 是否详细模式
}: {
  theme?: string; // 没有用到
  verbose: boolean;
}): React.ReactNode { // 返回值 是 React 节点(可以是字符串/JSX)
  if (!url) {
    return null; // 如果没有 url 不渲染任何内容
  }
  if (verbose) { // 如果是详细模式 返回字符串
    // `url: "${url}"` 一定有
    /* verbose && prompt ? `, prompt: "${prompt}"` : ''
     * 如果 verbose = True, 且 prompt 存在, 就追加 , prompt: ""
      */
    return `url: "${url}"${verbose && prompt ? `, prompt: "${prompt}"` : ''}`;
  }
  // 非 verbose 模式只返回 url
  return url;
}

// 工具执行中的时候 - 渲染工具使用过程中的消息
export function renderToolUseProgressMessage(
  // 无参数函数
): React.ReactNode {
  return <MessageResponse height={1}>
            <Text dimColor>Fetching…</Text>
         </MessageResponse>; // 渲染一个消息容器, 高度 1 行, 显示灰色文本, 最后结束组件
}

// 渲染工具结果的消息
export function renderToolResultMessage({
  bytes, // 数据大小
  code, // HTTP 状态码 eg: 200
  codeText, // 状态描述 eg: OK
  result // 内容
}: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[], // 进度消息列表, 变量名前有 _, 表示没用到的占位符 
{
  verbose
}: {
  verbose: boolean; // 是否详细模式
}): React.ReactNode { // 返回 React 节点
  const formattedSize = formatFileSize(bytes);
  if (verbose) {
    return <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            Received <Text bold>{formattedSize}</Text> ({code} {codeText})
          </Text>
        </MessageResponse>
        <Box flexDirection="column">
          <Text>{result}</Text>
        </Box>
      </Box>;
  }
  return <MessageResponse height={1}>
      <Text>
        Received <Text bold>{formattedSize}</Text> ({code} {codeText})
      </Text>
    </MessageResponse>;
}
export function getToolUseSummary(input: Partial<{
  url: string;
  prompt: string;
}> | undefined): string | null {
  if (!input?.url) {
    return null;
  }
  return truncate(input.url, TOOL_SUMMARY_MAX_LENGTH);
}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJSZWFjdCIsIk1lc3NhZ2VSZXNwb25zZSIsIlRPT0xfU1VNTUFSWV9NQVhfTEVOR1RIIiwiQm94IiwiVGV4dCIsIlRvb2xQcm9ncmVzc0RhdGEiLCJQcm9ncmVzc01lc3NhZ2UiLCJmb3JtYXRGaWxlU2l6ZSIsInRydW5jYXRlIiwiT3V0cHV0IiwicmVuZGVyVG9vbFVzZU1lc3NhZ2UiLCJ1cmwiLCJwcm9tcHQiLCJQYXJ0aWFsIiwidmVyYm9zZSIsInRoZW1lIiwiUmVhY3ROb2RlIiwicmVuZGVyVG9vbFVzZVByb2dyZXNzTWVzc2FnZSIsInJlbmRlclRvb2xSZXN1bHRNZXNzYWdlIiwiYnl0ZXMiLCJjb2RlIiwiY29kZVRleHQiLCJyZXN1bHQiLCJfcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2UiLCJmb3JtYXR0ZWRTaXplIiwiZ2V0VG9vbFVzZVN1bW1hcnkiLCJpbnB1dCJdLCJzb3VyY2VzIjpbIlVJLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgUmVhY3QgZnJvbSAncmVhY3QnXG5pbXBvcnQgeyBNZXNzYWdlUmVzcG9uc2UgfSBmcm9tICcuLi8uLi9jb21wb25lbnRzL01lc3NhZ2VSZXNwb25zZS5qcydcbmltcG9ydCB7IFRPT0xfU1VNTUFSWV9NQVhfTEVOR1RIIH0gZnJvbSAnLi4vLi4vY29uc3RhbnRzL3Rvb2xMaW1pdHMuanMnXG5pbXBvcnQgeyBCb3gsIFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgdHlwZSB7IFRvb2xQcm9ncmVzc0RhdGEgfSBmcm9tICcuLi8uLi9Ub29sLmpzJ1xuaW1wb3J0IHR5cGUgeyBQcm9ncmVzc01lc3NhZ2UgfSBmcm9tICcuLi8uLi90eXBlcy9tZXNzYWdlLmpzJ1xuaW1wb3J0IHsgZm9ybWF0RmlsZVNpemUsIHRydW5jYXRlIH0gZnJvbSAnLi4vLi4vdXRpbHMvZm9ybWF0LmpzJ1xuaW1wb3J0IHR5cGUgeyBPdXRwdXQgfSBmcm9tICcuL1dlYkZldGNoVG9vbC5qcydcblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VNZXNzYWdlKFxuICB7IHVybCwgcHJvbXB0IH06IFBhcnRpYWw8eyB1cmw6IHN0cmluZzsgcHJvbXB0OiBzdHJpbmcgfT4sXG4gIHsgdmVyYm9zZSB9OiB7IHRoZW1lPzogc3RyaW5nOyB2ZXJib3NlOiBib29sZWFuIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBpZiAoIXVybCkge1xuICAgIHJldHVybiBudWxsXG4gIH1cbiAgaWYgKHZlcmJvc2UpIHtcbiAgICByZXR1cm4gYHVybDogXCIke3VybH1cIiR7dmVyYm9zZSAmJiBwcm9tcHQgPyBgLCBwcm9tcHQ6IFwiJHtwcm9tcHR9XCJgIDogJyd9YFxuICB9XG4gIHJldHVybiB1cmxcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlclRvb2xVc2VQcm9ncmVzc01lc3NhZ2UoKTogUmVhY3QuUmVhY3ROb2RlIHtcbiAgcmV0dXJuIChcbiAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICA8VGV4dCBkaW1Db2xvcj5GZXRjaGluZ+KApjwvVGV4dD5cbiAgICA8L01lc3NhZ2VSZXNwb25zZT5cbiAgKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gcmVuZGVyVG9vbFJlc3VsdE1lc3NhZ2UoXG4gIHsgYnl0ZXMsIGNvZGUsIGNvZGVUZXh0LCByZXN1bHQgfTogT3V0cHV0LFxuICBfcHJvZ3Jlc3NNZXNzYWdlc0Zvck1lc3NhZ2U6IFByb2dyZXNzTWVzc2FnZTxUb29sUHJvZ3Jlc3NEYXRhPltdLFxuICB7IHZlcmJvc2UgfTogeyB2ZXJib3NlOiBib29sZWFuIH0sXG4pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBmb3JtYXR0ZWRTaXplID0gZm9ybWF0RmlsZVNpemUoYnl0ZXMpXG4gIGlmICh2ZXJib3NlKSB7XG4gICAgcmV0dXJuIChcbiAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICA8TWVzc2FnZVJlc3BvbnNlIGhlaWdodD17MX0+XG4gICAgICAgICAgPFRleHQ+XG4gICAgICAgICAgICBSZWNlaXZlZCA8VGV4dCBib2xkPntmb3JtYXR0ZWRTaXplfTwvVGV4dD4gKHtjb2RlfSB7Y29kZVRleHR9KVxuICAgICAgICAgIDwvVGV4dD5cbiAgICAgICAgPC9NZXNzYWdlUmVzcG9uc2U+XG4gICAgICAgIDxCb3ggZmxleERpcmVjdGlvbj1cImNvbHVtblwiPlxuICAgICAgICAgIDxUZXh0PntyZXN1bHR9PC9UZXh0PlxuICAgICAgICA8L0JveD5cbiAgICAgIDwvQm94PlxuICAgIClcbiAgfVxuICByZXR1cm4gKFxuICAgIDxNZXNzYWdlUmVzcG9uc2UgaGVpZ2h0PXsxfT5cbiAgICAgIDxUZXh0PlxuICAgICAgICBSZWNlaXZlZCA8VGV4dCBib2xkPntmb3JtYXR0ZWRTaXplfTwvVGV4dD4gKHtjb2RlfSB7Y29kZVRleHR9KVxuICAgICAgPC9UZXh0PlxuICAgIDwvTWVzc2FnZVJlc3BvbnNlPlxuICApXG59XG5cbmV4cG9ydCBmdW5jdGlvbiBnZXRUb29sVXNlU3VtbWFyeShcbiAgaW5wdXQ6IFBhcnRpYWw8eyB1cmw6IHN0cmluZzsgcHJvbXB0OiBzdHJpbmcgfT4gfCB1bmRlZmluZWQsXG4pOiBzdHJpbmcgfCBudWxsIHtcbiAgaWYgKCFpbnB1dD8udXJsKSB7XG4gICAgcmV0dXJuIG51bGxcbiAgfVxuICByZXR1cm4gdHJ1bmNhdGUoaW5wdXQudXJsLCBUT09MX1NVTU1BUllfTUFYX0xFTkdUSClcbn1cbiJdLCJtYXBwaW5ncyI6IkFBQUEsT0FBT0EsS0FBSyxNQUFNLE9BQU87QUFDekIsU0FBU0MsZUFBZSxRQUFRLHFDQUFxQztBQUNyRSxTQUFTQyx1QkFBdUIsUUFBUSwrQkFBK0I7QUFDdkUsU0FBU0MsR0FBRyxFQUFFQyxJQUFJLFFBQVEsY0FBYztBQUN4QyxjQUFjQyxnQkFBZ0IsUUFBUSxlQUFlO0FBQ3JELGNBQWNDLGVBQWUsUUFBUSx3QkFBd0I7QUFDN0QsU0FBU0MsY0FBYyxFQUFFQyxRQUFRLFFBQVEsdUJBQXVCO0FBQ2hFLGNBQWND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
