// login.tsx: 真正的登录逻辑 + UI

import { feature } from 'bun:bundle';
import * as React from 'react';

// TODO
import { useMemo, useState } from 'react' 

import { resetCostState } from '../../bootstrap/state.js';
import { 
  clearTrustedDeviceToken,
  enrollTrustedDevice
} from '../../bridge/trustedDevice.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js';
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js';

// TODO
import { Select } from '../../components/CustomSelect/select.js';

import { Dialog } from '../../components/design-system/Dialog.js';

// TODO
import { OpenAILoginFlow } from '../../components/OpenAILoginFlow.js'
import { OpenRouterLoginFlow } from '../../components/OpenRouterLoginFlow.js'
import { LocalLoginFlow } from '../../components/LocalLoginFlow.js'
import { OpenCodeLoginFlow } from '../../components/OpenCodeLoginFlow.js'

import { useMainLoopModel } from '../../hooks/useMainLoopModel.js';

// TODO Box
import { Box, Text } from '../../ink.js';
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js';
import { refreshPolicyLimits } from '../../services/policyLimits/index.js';
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';

// TODO
import { getConfiguredAuthProvider } from '../../utils/auth.js';

import { stripSignatureBlocks } from '../../utils/messages.js';
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck
} from '../../utils/permissions/bypassPermissionsKillswitch.js';
import { resetUserCache } from '../../utils/user.js';

// TODO
type AuthProviderChoice = 'anthropic' | 'openai' | 'openrouter' | 'local' | 'opencode'

/* 第一层: 入口函数 call()
 * CLI 执行 /login 真正被调用的函数
 * 登录成功后的 核心逻辑
 * */
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext
): Promise<React.ReactNode> {
  // 渲染 React 组件: <Login />
  return (
    <Login
      onDone={async success => {
      
        // 更新 API Key, 通知系统 身份变了
        context.onChangeAPIKey();
        // Signature-bearing blocks (thinking, connector_text) are bound to the API key —
        // strip them so the new key doesn't reject stale signatures.
        // 清理旧消息签名, 防止 新账号 + 旧签名 = 校验失败
        context.setMessages(stripSignatureBlocks);

        if (success) {
          // 这些 reset 的本质: 换账号 = 全部重置
          // Post-login refresh logic. Keep in sync with onboarding in src/interactiveHelpers.tsx
          // 成本统计 Reset cost state when switching accounts
          resetCostState();

          // 远程配置 Refresh remotely managed settings after login (non-blocking)
          void refreshRemoteManagedSettings();
          // Refresh policy limits after login (non-blocking)
          void refreshPolicyLimits();
     
          // 用户缓存 Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
          resetUserCache();

          // Feature flags(GrowthBook) Refresh GrowthBook after login to get updated feature flags (e.g., for claude.ai MCPs)
          refreshGrowthBookAfterAuthChange();

          // 设备信任 记住这台设备
          // Clear any stale trusted device token from a previous account before
          // re-enrolling — prevents sending the old token on bridge calls while
          // the async enrollTrustedDevice() is in-flight.
          clearTrustedDeviceToken();
          // Enroll as a trusted device for Remote Control (10-min fresh-session window)
          void enrollTrustedDevice();

          // 权限系统(killswitch) 防止越权操作, 自动模式滥用
          // Reset killswitch gate checks and re-run with new org
          resetBypassPermissionsCheck();
          const appState = context.getAppState();
          void checkAndDisableBypassPermissionsIfNeeded(appState.toolPermissionContext, context.setAppState);
      
          // 自动模式 gating, Feature flag 控制功能开关
          if (feature('TRANSCRIPT_CLASSIFIER')) {
            resetAutoModeGateCheck();
            void checkAndDisableAutoModeIfNeeded(appState.toolPermissionContext, context.setAppState, appState.fastMode);
          }

          // Increment authVersion to trigger re-fetching of auth-dependent data in hooks (e.g., MCP servers)
          context.setAppState(prev => ({
            ...prev,
            authVersion: prev.authVersion + 1, // 触发全局更新, 用 version 触发所有 hook 重新 fetch
            mainLoopModel: null, // 重置为 null，使用新 provider 的默认模型
            mainLoopModelForSession: null, // 重置 session 模型
          }));
        }

        // 返回结果
        onDone(success ? 'Login successful' : 'Login interrupted');
      }} 
    />
  )
}

/* 第二层: UI 组件 Login, CLI UI(用 React + Ink)
 * UI 结构
 * <Dialog title="Login"> Dialog 是 CLI 弹窗
 *  <ConsoleOAuthFlow /> 真正执行 OAuth 登录逻辑, 打开浏览器, 获取 token, 回传 CLI
 * </Dialog>
 * */

export function Login(props: {
  onDone: (success: boolean, mainLoopModel: string) => void
  startingMessage?: string
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel()
  const configuredAuthProvider = getConfiguredAuthProvider()
  const [selectedProvider, setSelectedProvider] =
    useState<AuthProviderChoice | null>(null)

  const providerOptions = useMemo(
    () => [
      {
        label: (
          <Text>
            Anthropic{' '}
            <Text dimColor={true}>
              Subscription login, Console API billing, or Bedrock/Foundry/Vertex
            </Text>
            {'\n'}
          </Text>
        ),
        value: 'anthropic',
      },
      {
        label: (
          <Text>
            OpenAI / Codex{' '}
            <Text dimColor={true}>
              Codex login, Codex auth import, or OpenAI API key
            </Text>
            {'\n'}
          </Text>
        ),
        value: 'openai',
      },
      {
        label: (
          <Text>
            OpenRouter{' '}
            <Text dimColor={true}>OpenRouter API key via Responses API</Text>
            {'\n'}
          </Text>
        ),
        value: 'openrouter',
      },
      {
        label: (
          <Text>
            OpenCode Zen{' '}
            <Text dimColor={true}>
              Free models (Big Pickle, GPT 5 Nano) or Zen API key
            </Text>
            {'\n'}
          </Text>
        ),
        value: 'opencode',
      },
      {
        label: (
          <Text>
            Local{' '}
            <Text dimColor={true}>
              Local model server (Ollama, LM Studio, vLLM, etc.)
            </Text>
            {'\n'}
          </Text>
        ),
        value: 'local',
      },
    ],
    [],
  )

  const onCancel = () => props.onDone(false, mainLoopModel)
  const onFlowDone = () => props.onDone(true, mainLoopModel)

  const body =
    selectedProvider === null ? (
      <Box flexDirection="column" gap={1}>
        <Text bold={true}>
          {props.startingMessage ??
            'Choose which provider you want Better-Clawd to use.'}
        </Text>
        <Text dimColor={true}>
          Current default: {configuredAuthProvider}. Pick a provider first, then
          choose the login method inside that flow.
        </Text>
        <Text>Select provider:</Text>
        <Box>
          <Select
            options={providerOptions}
            onChange={value =>
              setSelectedProvider(value as AuthProviderChoice)
            }
          />
        </Box>
      </Box>
    ) : selectedProvider === 'openai' ? (
      <OpenAILoginFlow
        onDone={onFlowDone}
        startingMessage="Better-Clawd can use OpenAI with your Codex/ChatGPT login or a standard OpenAI API key."
      />
    ) : selectedProvider === 'openrouter' ? (
      <OpenRouterLoginFlow
        onDone={onFlowDone}
        startingMessage="Better-Clawd can use OpenRouter with your OpenRouter API key."
      />
    ) : selectedProvider === 'opencode' ? (
      <OpenCodeLoginFlow
        onDone={onFlowDone}
        startingMessage="Better-Clawd can use OpenCode Zen free models or with a Zen API key."
      />
    ) : selectedProvider === 'local' ? (
      <LocalLoginFlow
        onDone={onFlowDone}
        startingMessage="Configure local model server (Ollama, LM Studio, vLLM, etc.)."
      />
    ) : (
      <ConsoleOAuthFlow
        onDone={onFlowDone}
        startingMessage="Better-Clawd can use Anthropic login, Anthropic Console billing, or Anthropic-compatible 3rd-party platforms."
      />
    )

  return (
    <Dialog
      title="Login"
      onCancel={onCancel}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      {body}
    </Dialog>
  )
}

/*
import { c as _c } from "react/compiler-runtime";

export function Login(props) {
  const $ = _c(12);
  const mainLoopModel = useMainLoopModel();
  let t0;
  if ($[0] !== mainLoopModel || $[1] !== props) {
    t0 = () => props.onDone(false, mainLoopModel);
    $[0] = mainLoopModel;
    $[1] = props;
    $[2] = t0;
  } else {
    t0 = $[2];
  }
  let t1;
  if ($[3] !== mainLoopModel || $[4] !== props) {
    t1 = () => props.onDone(true, mainLoopModel);
    $[3] = mainLoopModel;
    $[4] = props;
    $[5] = t1;
  } else {
    t1 = $[5];
  }
  let t2;
  if ($[6] !== props.startingMessage || $[7] !== t1) {
    t2 = <ConsoleOAuthFlow onDone={t1} startingMessage={props.startingMessage} />;
    $[6] = props.startingMessage;
    $[7] = t1;
    $[8] = t2;
  } else {
    t2 = $[8];
  }
  let t3;
  if ($[9] !== t0 || $[10] !== t2) {
    t3 = <Dialog title="Login" onCancel={t0} color="permission" inputGuide={_temp}>{t2}</Dialog>;
    $[9] = t0;
    $[10] = t2;
    $[11] = t3;
  } else {
    t3 = $[11];
  }
  return t3;
}
function _temp(exitState) {
  return exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="cancel" />;
}
*/

/*
 * index.ts → 命令注册(类似路由)
 *    ↓
 * login.tsx → UI + 逻辑
 *    ↓
 * ConsoleOAuthFlow → OAuth 登录
 *    ↓
 * context → 全局状态更新
 *    ↓
 * services → 刷新配置/权限/缓存
 * */

/* 编译优化后的单流程 React 组件，专注 Anthropic 登录
 * 
 * */

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJuYW1lcyI6WyJmZWF0dXJlIiwiUmVhY3QiLCJyZXNldENvc3RTdGF0ZSIsImNsZWFyVHJ1c3RlZERldmljZVRva2VuIiwiZW5yb2xsVHJ1c3RlZERldmljZSIsIkxvY2FsSlNYQ29tbWFuZENvbnRleHQiLCJDb25maWd1cmFibGVTaG9ydGN1dEhpbnQiLCJDb25zb2xlT0F1dGhGbG93IiwiRGlhbG9nIiwidXNlTWFpbkxvb3BNb2RlbCIsIlRleHQiLCJyZWZyZXNoR3Jvd3RoQm9va0FmdGVyQXV0aENoYW5nZSIsInJlZnJlc2hQb2xpY3lMaW1pdHMiLCJyZWZyZXNoUmVtb3RlTWFuYWdlZFNldHRpbmdzIiwiTG9jYWxKU1hDb21tYW5kT25Eb25lIiwic3RyaXBTaWduYXR1cmVCbG9ja3MiLCJjaGVja0FuZERpc2FibGVBdXRvTW9kZUlmTmVlZGVkIiwiY2hlY2tBbmREaXNhYmxlQnlwYXNzUGVybWlzc2lvbnNJZk5lZWRlZCIsInJlc2V0QXV0b01vZGVHYXRlQ2hlY2siLCJyZXNldEJ5cGFzc1Blcm1pc3Npb25zQ2hlY2siLCJyZXNldFVzZXJDYWNoZSIsImNhbGwiLCJvbkRvbmUiLCJjb250ZXh0IiwiUHJvbWlzZSIsIlJlYWN0Tm9kZSIsInN1Y2Nlc3MiLCJvbkNoYW5nZUFQSUtleSIsInNldE1lc3NhZ2VzIiwiYXBwU3RhdGUiLCJnZXRBcHBTdGF0ZSIsInRvb2xQZXJtaXNzaW9uQ29udGV4dCIsInNldEFwcFN0YXRlIiwiZmFzdE1vZGUiLCJwcmV2IiwiYXV0aFZlcnNpb24iLCJMb2dpbiIsInByb3BzIiwiJCIsIl9jIiwibWFpbkxvb3BNb2RlbCIsInQwIiwidDEiLCJ0MiIsInN0YXJ0aW5nTWVzc2FnZSIsInQzIiwiX3RlbXAiLCJleGl0U3RhdGUiLCJwZW5kaW5nIiwia2V5TmFtZSJdLCJzb3VyY2VzIjpbImxvZ2luLnRzeCJdLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyBmZWF0dXJlIH0gZnJvbSAnYnVuOmJ1bmRsZSdcbmltcG9ydCAqIGFzIFJlYWN0IGZyb20gJ3JlYWN0J1xuaW1wb3J0IHsgcmVzZXRDb3N0U3RhdGUgfSBmcm9tICcuLi8uLi9ib290c3RyYXAvc3RhdGUuanMnXG5pbXBvcnQge1xuICBjbGVhclRydXN0ZWREZXZpY2VUb2tlbixcbiAgZW5yb2xsVHJ1c3RlZERldmljZSxcbn0gZnJvbSAnLi4vLi4vYnJpZGdlL3RydXN0ZWREZXZpY2UuanMnXG5pbXBvcnQgdHlwZSB7IExvY2FsSlNYQ29tbWFuZENvbnRleHQgfSBmcm9tICcuLi8uLi9jb21tYW5kcy5qcydcbmltcG9ydCB7IENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludCB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvQ29uZmlndXJhYmxlU2hvcnRjdXRIaW50LmpzJ1xuaW1wb3J0IHsgQ29uc29sZU9BdXRoRmxvdyB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvQ29uc29sZU9BdXRoRmxvdy5qcydcbmltcG9ydCB7IERpYWxvZyB9IGZyb20gJy4uLy4uL2NvbXBvbmVudHMvZGVzaWduLXN5c3RlbS9EaWFsb2cuanMnXG5pbXBvcnQgeyB1c2VNYWluTG9vcE1vZGVsIH0gZnJvbSAnLi4vLi4vaG9va3MvdXNlTWFpbkxvb3BNb2RlbC5qcydcbmltcG9ydCB7IFRleHQgfSBmcm9tICcuLi8uLi9pbmsuanMnXG5pbXBvcnQgeyByZWZyZXNoR3Jvd3RoQm9va0FmdGVyQXV0aENoYW5nZSB9IGZyb20gJy4uLy4uL3NlcnZpY2VzL2FuYWx5dGljcy9ncm93dGhib29rLmpzJ1xuaW1wb3J0IHsgcmVmcmVzaFBvbGljeUxpbWl0cyB9IGZyb20gJy4uLy4uL3NlcnZpY2VzL3BvbGljeUxpbWl0cy9pbmRleC5qcydcbmltcG9ydCB7IHJlZnJlc2hSZW1vdGVNYW5hZ2VkU2V0dGluZ3MgfSBmcm9tICcuLi8uLi9zZXJ2aWNlcy9yZW1vdGVNYW5hZ2VkU2V0dGluZ3MvaW5kZXguanMnXG5pbXBvcnQgdHlwZSB7IExvY2FsSlNYQ29tbWFuZE9uRG9uZSB9IGZyb20gJy4uLy4uL3R5cGVzL2NvbW1hbmQuanMnXG5pbXBvcnQgeyBzdHJpcFNpZ25hdHVyZUJsb2NrcyB9IGZyb20gJy4uLy4uL3V0aWxzL21lc3NhZ2VzLmpzJ1xuaW1wb3J0IHtcbiAgY2hlY2tBbmREaXNhYmxlQXV0b01vZGVJZk5lZWRlZCxcbiAgY2hlY2tBbmREaXNhYmxlQnlwYXNzUGVybWlzc2lvbnNJZk5lZWRlZCxcbiAgcmVzZXRBdXRvTW9kZUdhdGVDaGVjayxcbiAgcmVzZXRCeXBhc3NQZXJtaXNzaW9uc0NoZWNrLFxufSBmcm9tICcuLi8uLi91dGlscy9wZXJtaXNzaW9ucy9ieXBhc3NQZXJtaXNzaW9uc0tpbGxzd2l0Y2guanMnXG5pbXBvcnQgeyByZXNldFVzZXJDYWNoZSB9IGZyb20gJy4uLy4uL3V0aWxzL3VzZXIuanMnXG5cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBjYWxsKFxuICBvbkRvbmU6IExvY2FsSlNYQ29tbWFuZE9uRG9uZSxcbiAgY29udGV4dDogTG9jYWxKU1hDb21tYW5kQ29udGV4dCxcbik6IFByb21pc2U8UmVhY3QuUmVhY3ROb2RlPiB7XG4gIHJldHVybiAoXG4gICAgPExvZ2luXG4gICAgICBvbkRvbmU9e2FzeW5jIHN1Y2Nlc3MgPT4ge1xuICAgICAgICBjb250ZXh0Lm9uQ2hhbmdlQVBJS2V5KClcbiAgICAgICAgLy8gU2lnbmF0dXJlLWJlYXJpbmcgYmxvY2tzICh0aGlua2luZywgY29ubmVjdG9yX3RleHQpIGFyZSBib3VuZCB0byB0aGUgQVBJIGtleSDigJRcbiAgICAgICAgLy8gc3RyaXAgdGhlbSBzbyB0aGUgbmV3IGtleSBkb2Vzbid0IHJlamVjdCBzdGFsZSBzaWduYXR1cmVzLlxuICAgICAgICBjb250ZXh0LnNldE1lc3NhZ2VzKHN0cmlwU2lnbmF0dXJlQmxvY2tzKVxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgIC8vIFBvc3QtbG9naW4gcmVmcmVzaCBsb2dpYy4gS2VlcCBpbiBzeW5jIHdpdGggb25ib2FyZGluZyBpbiBzcmMvaW50ZXJhY3RpdmVIZWxwZXJzLnRzeFxuICAgICAgICAgIC8vIFJlc2V0IGNvc3Qgc3RhdGUgd2hlbiBzd2l0Y2hpbmcgYWNjb3VudHNcbiAgICAgICAgICByZXNldENvc3RTdGF0ZSgpXG4gICAgICAgICAgLy8gUmVmcmVzaCByZW1vdGVseSBtYW5hZ2VkIHNldHRpbmdzIGFmdGVyIGxvZ2luIChub24tYmxvY2tpbmcpXG4gICAgICAgICAgdm9pZCByZWZyZXNoUmVtb3RlTWFuYWdlZFNldHRpbmdzKClcbiAgICAgICAgICAvLyBSZWZyZXNoIHBvbGljeSBsaW1pdHMgYWZ0ZXIgbG9naW4gKG5vbi1ibG9ja2luZylcbiAgICAgICAgICB2b2lkIHJlZnJlc2hQb2xpY3lMaW1pdHMoKVxuICAgICAgICAgIC8vIENsZWFyIHVzZXIgZGF0YSBjYWNoZSBCRUZPUkUgR3Jvd3RoQm9vayByZWZyZXNoIHNvIGl0IHBpY2tzIHVwIGZyZXNoIGNyZWRlbnRpYWxzXG4gICAgICAgICAgcmVzZXRVc2VyQ2FjaGUoKVxuICAgICAgICAgIC8vIFJlZnJlc2ggR3Jvd3RoQm9vayBhZnRlciBsb2dpbiB0byBnZXQgdXBkYXRlZCBmZWF0dXJlIGZsYWdzIChlLmcuLCBmb3IgY2xhdWRlLmFpIE1DUHMpXG4gICAgICAgICAgcmVmcmVzaEdyb3d0aEJvb2tBZnRlckF1dGhDaGFuZ2UoKVxuICAgICAgICAgIC8vIENsZWFyIGFueSBzdGFsZSB0cnVzdGVkIGRldmljZSB0b2tlbiBmcm9tIGEgcHJldmlvdXMgYWNjb3VudCBiZWZvcmVcbiAgICAgICAgICAvLyByZS1lbnJvbGxpbmcg4oCUIHByZXZlbnRzIHNlbmRpbmcgdGhlIG9sZCB0b2tlbiBvbiBicmlkZ2UgY2FsbHMgd2hpbGVcbiAgICAgICAgICAvLyB0aGUgYXN5bmMgZW5yb2xsVHJ1c3RlZERldmljZSgpIGlzIGluLWZsaWdodC5cbiAgICAgICAgICBjbGVhclRydXN0ZWREZXZpY2VUb2tlbigpXG4gICAgICAgICAgLy8gRW5yb2xsIGFzIGEgdHJ1c3RlZCBkZXZpY2UgZm9yIFJlbW90ZSBDb250cm9sICgxMC1taW4gZnJlc2gtc2Vzc2lvbiB3aW5kb3cpXG4gICAgICAgICAgdm9pZCBlbnJvbGxUcnVzdGVkRGV2aWNlKClcbiAgICAgICAgICAvLyBSZXNldCBraWxsc3dpdGNoIGdhdGUgY2hlY2tzIGFuZCByZS1ydW4gd2l0aCBuZXcgb3JnXG4gICAgICAgICAgcmVzZXRCeXBhc3NQZXJtaXNzaW9uc0NoZWNrKClcbiAgICAgICAgICBjb25zdCBhcHBTdGF0ZSA9IGNvbnRleHQuZ2V0QXBwU3RhdGUoKVxuICAgICAgICAgIHZvaWQgY2hlY2tBbmREaXNhYmxlQnlwYXNzUGVybWlzc2lvbnNJZk5lZWRlZChcbiAgICAgICAgICAgIGFwcFN0YXRlLnRvb2xQZXJtaXNzaW9uQ29udGV4dCxcbiAgICAgICAgICAgIGNvbnRleHQuc2V0QXBwU3RhdGUsXG4gICAgICAgICAgKVxuICAgICAgICAgIGlmIChmZWF0dXJlKCdUUkFOU0NSSVBUX0NMQVNTSUZJRVInKSkge1xuICAgICAgICAgICAgcmVzZXRBdXRvTW9kZUdhdGVDaGVjaygpXG4gICAgICAgICAgICB2b2lkIGNoZWNrQW5kRGlzYWJsZUF1dG9Nb2RlSWZOZWVkZWQoXG4gICAgICAgICAgICAgIGFwcFN0YXRlLnRvb2xQZXJtaXNzaW9uQ29udGV4dCxcbiAgICAgICAgICAgICAgY29udGV4dC5zZXRBcHBTdGF0ZSxcbiAgICAgICAgICAgICAgYXBwU3RhdGUuZmFzdE1vZGUsXG4gICAgICAgICAgICApXG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIEluY3JlbWVudCBhdXRoVmVyc2lvbiB0byB0cmlnZ2VyIHJlLWZldGNoaW5nIG9mIGF1dGgtZGVwZW5kZW50IGRhdGEgaW4gaG9va3MgKGUuZy4sIE1DUCBzZXJ2ZXJzKVxuICAgICAgICAgIGNvbnRleHQuc2V0QXBwU3RhdGUocHJldiA9PiAoe1xuICAgICAgICAgICAgLi4ucHJldixcbiAgICAgICAgICAgIGF1dGhWZXJzaW9uOiBwcmV2LmF1dGhWZXJzaW9uICsgMSxcbiAgICAgICAgICB9KSlcbiAgICAgICAgfVxuICAgICAgICBvbkRvbmUoc3VjY2VzcyA/ICdMb2dpbiBzdWNjZXNzZnVsJyA6ICdMb2dpbiBpbnRlcnJ1cHRlZCcpXG4gICAgICB9fVxuICAgIC8+XG4gIClcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIExvZ2luKHByb3BzOiB7XG4gIG9uRG9uZTogKHN1Y2Nlc3M6IGJvb2xlYW4sIG1haW5Mb29wTW9kZWw6IHN0cmluZykgPT4gdm9pZFxuICBzdGFydGluZ01lc3NhZ2U/OiBzdHJpbmdcbn0pOiBSZWFjdC5SZWFjdE5vZGUge1xuICBjb25zdCBtYWluTG9vcE1vZGVsID0gdXNlTWFpbkxvb3BNb2RlbCgpXG5cbiAgcmV0dXJuIChcbiAgICA8RGlhbG9nXG4gICAgICB0aXRsZT1cIkxvZ2luXCJcbiAgICAgIG9uQ2FuY2VsPXsoKSA9PiBwcm9wcy5vbkRvbmUoZmFsc2UsIG1haW5Mb29wTW9kZWwpfVxuICAgICAgY29sb3I9XCJwZXJtaXNzaW9uXCJcbiAgICAgIGlucHV0R3VpZGU9e2V4aXRTdGF0ZSA9PlxuICAgICAgICBleGl0U3RhdGUucGVuZGluZyA/IChcbiAgICAgICAgICA8VGV4dD5QcmVzcyB7ZXhpdFN0YXRlLmtleU5hbWV9IGFnYWluIHRvIGV4aXQ8L1RleHQ+XG4gICAgICAgICkgOiAoXG4gICAgICAgICAgPENvbmZpZ3VyYWJsZVNob3J0Y3V0SGludFxuICAgICAgICAgICAgYWN0aW9uPVwiY29uZmlybTpub1wiXG4gICAgICAgICAgICBjb250ZXh0PVwiQ29uZmlybWF0aW9uXCJcbiAgICAgICAgICAgIGZhbGxiYWNrPVwiRXNjXCJcbiAgICAgICAgICAgIGRlc2NyaXB0aW9uPVwiY2FuY2VsXCJcbiAgICAgICAgICAvPlxuICAgICAgICApXG4gICAgICB9XG4gICAgPlxuICAgICAgPENvbnNvbGVPQXV0aEZsb3dcbiAgICAgICAgb25Eb25lPXsoKSA9PiBwcm9wcy5vbkRvbmUodHJ1ZSwgbWFpbkxvb3BNb2RlbCl9XG4gICAgICAgIHN0YXJ0aW5nTWVzc2FnZT17cHJvcHMu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
