import * as React from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { ListItem } from '../../components/design-system/ListItem.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { feishuService } from '../../services/feishu/FeishuService.js'
import {
  clearFeishuConfig,
  getFeishuConfig,
  maskFeishuAppId,
  maskFeishuAppSecret,
  saveFeishuConfig,
} from '../../services/feishu/feishuConfig.js'

type Step =
  | { type: 'menu' }
  | { type: 'edit-app-id' }
  | { type: 'edit-app-secret' }
  | { type: 'edit-encrypt-key' }
  | { type: 'edit-verification-token' }
  | { type: 'edit-allowed-users' }
  | { type: 'confirm-clear' }

type Notice = {
  text: string
  tone: 'success' | 'error' | 'info'
}

function TextInput({
  title,
  hint,
  initialValue,
  masked = false,
  onSubmit,
  onCancel,
}: {
  title: string
  hint: string
  initialValue?: string
  masked?: boolean
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = React.useState(initialValue ?? '')
  const [cursorOffset, setCursorOffset] = React.useState(
    (initialValue ?? '').length,
  )

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }

    if (key.return) {
      onSubmit(value.trim())
      return
    }

    if (key.leftArrow) {
      setCursorOffset(current => Math.max(0, current - 1))
      return
    }

    if (key.rightArrow) {
      setCursorOffset(current => Math.min(value.length, current + 1))
      return
    }

    if (key.backspace || key.delete) {
      if (cursorOffset === 0) return
      const nextValue =
        value.slice(0, cursorOffset - 1) + value.slice(cursorOffset)
      setValue(nextValue)
      setCursorOffset(current => Math.max(0, current - 1))
      return
    }

    if (input) {
      const nextValue =
        value.slice(0, cursorOffset) + input + value.slice(cursorOffset)
      setValue(nextValue)
      setCursorOffset(current => current + input.length)
    }
  })

  const displayValue = masked ? '*'.repeat(value.length) : value
  const cursorChar =
    cursorOffset < displayValue.length ? displayValue[cursorOffset] : ' '

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{title}</Text>
      <Text dimColor>{hint}</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Value:</Text>
        <Box>
          <Text>{displayValue.slice(0, cursorOffset)}</Text>
          <Text backgroundColor="white" color="black">
            {cursorChar}
          </Text>
          <Text>{displayValue.slice(cursorOffset + 1)}</Text>
        </Box>
      </Box>
      <Text dimColor>[Enter] 保存 · [Esc] 返回</Text>
    </Box>
  )
}

function ConfirmClear({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void
  onCancel: () => void
}) {
  useInput((_, key) => {
    if (key.escape) {
      onCancel()
      return
    }

    if (key.return) {
      onConfirm()
    }
  })

  return (
    <Box flexDirection="column" gap={1}>
      <Text color="yellow">这会清空飞书 App ID / App Secret 以及所有白名单配置。</Text>
      <Text dimColor>
        如果当前 bot 正在运行，会一并停止。按 Enter 确认，Esc 返回。
      </Text>
    </Box>
  )
}

function FeishuDialog({
  onDone,
}: {
  onDone: LocalJSXCommandOnDone
}) {
  const serviceState = React.useSyncExternalStore(
    feishuService.subscribe,
    feishuService.getStateSnapshot,
  )
  const [config, setConfig] = React.useState(() => getFeishuConfig())
  const [step, setStep] = React.useState<Step>({ type: 'menu' })
  const [notice, setNotice] = React.useState<Notice | null>(null)
  const [focusIndex, setFocusIndex] = React.useState(0)
  const [busy, setBusy] = React.useState(false)

  const refreshConfig = React.useCallback(() => {
    setConfig(getFeishuConfig())
  }, [])

  const menuItems = React.useMemo(
    () => [
      {
        label: '设置 App ID',
        action: () => setStep({ type: 'edit-app-id' }),
      },
      {
        label: '设置 App Secret',
        action: () => setStep({ type: 'edit-app-secret' }),
      },
      {
        label: '设置加密密钥（可选）',
        action: () => setStep({ type: 'edit-encrypt-key' }),
      },
      {
        label: '设置验证 Token（可选）',
        action: () => setStep({ type: 'edit-verification-token' }),
      },
      {
        label: '设置允许访问的用户',
        action: () => setStep({ type: 'edit-allowed-users' }),
      },
      {
        label:
          serviceState.status === 'running' ? '停止当前飞书 Bot' : '启动当前飞书 Bot',
        action: async () => {
          setBusy(true)
          try {
            if (serviceState.status === 'running') {
              await feishuService.stop()
              setNotice({ text: '飞书 Bot 已停止。', tone: 'success' })
            } else {
              await feishuService.startFromSavedConfig()
              setNotice({
                text: '飞书 Bot 已启动，请在飞书中私聊机器人验证连接。',
                tone: 'success',
              })
            }
          } catch (error) {
            setNotice({
              text: error instanceof Error ? error.message : '启动飞书 Bot 失败',
              tone: 'error',
            })
          } finally {
            setBusy(false)
          }
        },
      },
      {
        label: '清空飞书配置',
        action: () => setStep({ type: 'confirm-clear' }),
      },
      {
        label: '关闭',
        action: () => onDone(undefined, { display: 'skip' }),
      },
    ],
    [onDone, serviceState.status],
  )

  React.useEffect(() => {
    setFocusIndex(current => Math.min(current, menuItems.length - 1))
  }, [menuItems.length])

  const saveAppId = React.useCallback(
    async (value: string) => {
      if (!value) {
        setNotice({ text: 'App ID 不能为空。', tone: 'error' })
        setStep({ type: 'menu' })
        return
      }

      setBusy(true)
      try {
        const current = getFeishuConfig()
        saveFeishuConfig({ ...current, appId: value })
        refreshConfig()
        if (serviceState.status === 'running') {
          await feishuService.stop()
          await feishuService.startFromSavedConfig()
        }
        setNotice({ text: 'App ID 已保存。', tone: 'success' })
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : '保存 App ID 失败',
          tone: 'error',
        })
      } finally {
        setBusy(false)
        setStep({ type: 'menu' })
      }
    },
    [refreshConfig, serviceState.status],
  )

  const saveAppSecret = React.useCallback(
    async (value: string) => {
      if (!value) {
        setNotice({ text: 'App Secret 不能为空。', tone: 'error' })
        setStep({ type: 'menu' })
        return
      }

      setBusy(true)
      try {
        const current = getFeishuConfig()
        saveFeishuConfig({ ...current, appSecret: value })
        refreshConfig()
        if (serviceState.status === 'running') {
          await feishuService.stop()
          await feishuService.startFromSavedConfig()
        }
        setNotice({ text: 'App Secret 已保存。', tone: 'success' })
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : '保存 App Secret 失败',
          tone: 'error',
        })
      } finally {
        setBusy(false)
        setStep({ type: 'menu' })
      }
    },
    [refreshConfig, serviceState.status],
  )

  const saveEncryptKey = React.useCallback(
    async (value: string) => {
      setBusy(true)
      try {
        const current = getFeishuConfig()
        saveFeishuConfig({ ...current, encryptKey: value || undefined })
        refreshConfig()
        if (serviceState.status === 'running') {
          await feishuService.stop()
          await feishuService.startFromSavedConfig()
        }
        setNotice({ text: '加密密钥已保存。', tone: 'success' })
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : '保存失败',
          tone: 'error',
        })
      } finally {
        setBusy(false)
        setStep({ type: 'menu' })
      }
    },
    [refreshConfig, serviceState.status],
  )

  const saveVerificationToken = React.useCallback(
    async (value: string) => {
      setBusy(true)
      try {
        const current = getFeishuConfig()
        saveFeishuConfig({ ...current, verificationToken: value || undefined })
        refreshConfig()
        if (serviceState.status === 'running') {
          await feishuService.stop()
          await feishuService.startFromSavedConfig()
        }
        setNotice({ text: '验证 Token 已保存。', tone: 'success' })
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : '保存失败',
          tone: 'error',
        })
      } finally {
        setBusy(false)
        setStep({ type: 'menu' })
      }
    },
    [refreshConfig, serviceState.status],
  )

  const saveAllowedUsers = React.useCallback(
    async (value: string) => {
      const users = value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
      setBusy(true)
      try {
        const current = getFeishuConfig()
        saveFeishuConfig({ ...current, allowedUsers: users.length > 0 ? users : undefined })
        refreshConfig()
        setNotice({ text: '允许用户列表已保存。', tone: 'success' })
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : '保存失败',
          tone: 'error',
        })
      } finally {
        setBusy(false)
        setStep({ type: 'menu' })
      }
    },
    [refreshConfig],
  )

  const clearConfigAndStop = React.useCallback(async () => {
    setBusy(true)
    try {
      await feishuService.stop()
      clearFeishuConfig()
      refreshConfig()
      setNotice({ text: '飞书配置已清空。', tone: 'success' })
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : '清空配置失败',
        tone: 'error',
      })
    } finally {
      setBusy(false)
      setStep({ type: 'menu' })
    }
  }, [refreshConfig])

  useInput((_, key) => {
    if (step.type !== 'menu' || busy) return

    if (key.escape) {
      onDone(undefined, { display: 'skip' })
      return
    }

    if (key.upArrow) {
      setFocusIndex(current => (current - 1 + menuItems.length) % menuItems.length)
      return
    }

    if (key.downArrow) {
      setFocusIndex(current => (current + 1) % menuItems.length)
      return
    }

    if (key.return) {
      void menuItems[focusIndex]?.action()
    }
  })

  const noticeColor =
    notice?.tone === 'error'
      ? 'red'
      : notice?.tone === 'success'
        ? 'green'
        : 'cyan'

  // Step rendering
  if (step.type === 'edit-app-id') {
    return (
      <Dialog title="飞书 App ID" onCancel={() => setStep({ type: 'menu' })}>
        <TextInput
          title="App ID"
          hint="从飞书开放平台 > 凭证与基础信息 获取。"
          initialValue={config?.appId}
          onSubmit={value => { void saveAppId(value) }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'edit-app-secret') {
    return (
      <Dialog title="飞书 App Secret" onCancel={() => setStep({ type: 'menu' })}>
        <TextInput
          title="App Secret"
          hint="从飞书开放平台 > 凭证与基础信息 获取。"
          initialValue={config?.appSecret}
          masked={true}
          onSubmit={value => { void saveAppSecret(value) }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'edit-encrypt-key') {
    return (
      <Dialog title="飞书加密密钥" onCancel={() => setStep({ type: 'menu' })}>
        <TextInput
          title="加密密钥（可选）"
          hint="如果启用了「订阅事件请求 URL 加密模式」才需要填写。"
          initialValue={config?.encryptKey}
          masked={true}
          onSubmit={value => { void saveEncryptKey(value) }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'edit-verification-token') {
    return (
      <Dialog title="飞书验证 Token" onCancel={() => setStep({ type: 'menu' })}>
        <TextInput
          title="验证 Token（可选）"
          hint="如果启用了「订阅事件请求 URL 验证」才需要填写。"
          initialValue={config?.verificationToken}
          masked={true}
          onSubmit={value => { void saveVerificationToken(value) }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'edit-allowed-users') {
    return (
      <Dialog title="允许访问的用户" onCancel={() => setStep({ type: 'menu' })}>
        <TextInput
          title="允许访问的飞书用户 open_id"
          hint="可输入一个或多个 open_id，支持空格或逗号分隔。配对成功后可发送配对码完成授权。"
          initialValue={config?.allowedUsers?.join(', ')}
          onSubmit={value => { void saveAllowedUsers(value) }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'confirm-clear') {
    return (
      <Dialog title="清空飞书配置" onCancel={() => setStep({ type: 'menu' })}>
        <ConfirmClear
          onConfirm={() => { void clearConfigAndStop() }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  return (
    <Dialog title="飞书 (Feishu)" onCancel={() => onDone(undefined, { display: 'skip' })}>
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          启动飞书长连接机器人，并把私聊消息接入当前会话。
        </Text>
        <Text>
          状态:
          {' '}
          <Text color={serviceState.status === 'running' ? 'green' : 'yellow'}>
            {serviceState.status === 'running'
              ? '运行中'
              : serviceState.status === 'starting'
                ? '启动中'
                : '未启动'}
          </Text>
        </Text>
        <Text>App ID: {maskFeishuAppId(config?.appId)}</Text>
        <Text>App Secret: {maskFeishuAppSecret(config?.appSecret)}</Text>
        <Text>
          加密密钥: {config?.encryptKey ? '已配置' : '未配置'}
        </Text>
        <Text>
          验证 Token: {config?.verificationToken ? '已配置' : '未配置'}
        </Text>
        <Text>
          允许用户:
          {' '}
          {config?.allowedUsers?.length
            ? config.allowedUsers.join(', ')
            : '未配置（使用配对码授权）'}
        </Text>
        {config?.pairedUsers?.length ? (
          <Text>
            已配对用户: {config.pairedUsers.map(u => u.displayName || u.userId).join(', ')}
          </Text>
        ) : null}
        {serviceState.lastError ? (
          <Text color="red">最近错误: {serviceState.lastError}</Text>
        ) : null}
        {notice ? <Text color={noticeColor}>{notice.text}</Text> : null}
        {busy ? <Text dimColor>处理中，请稍候...</Text> : null}
        <Box flexDirection="column" marginTop={1}>
          {menuItems.map((item, index) => (
            <ListItem key={item.label} isFocused={focusIndex === index}>
              <Text>{item.label}</Text>
            </ListItem>
          ))}
        </Box>
        <Text dimColor>上下箭头选择，Enter 执行，Esc 关闭</Text>
      </Box>
    </Dialog>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <FeishuDialog onDone={onDone} />
}

export default call