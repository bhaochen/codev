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
import QRCode from 'qrcode'

type Step =
  | { type: 'menu' }
  | { type: 'edit-app-id' }
  | { type: 'edit-app-secret' }
  | { type: 'edit-encrypt-key' }
  | { type: 'edit-verification-token' }
  | { type: 'edit-allowed-users' }
  | { type: 'edit-admins' }
  | { type: 'edit-allowed-chats' }
  | { type: 'edit-mention-policy' }
  | { type: 'edit-tts-settings' }
  | { type: 'edit-tts-provider' }
  | { type: 'edit-tts-ref-audio' }
  | { type: 'confirm-clear' }
  | { type: 'scanning' }

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
        label: '设置管理员',
        action: () => setStep({ type: 'edit-admins' }),
      },
      {
        label: '设置允许响应的群',
        action: () => setStep({ type: 'edit-allowed-chats' }),
      },
      {
        label: `@提及要求: ${config?.requireMentionInGroup !== false ? '需 @bot' : '所有消息'}`,
        action: () => setStep({ type: 'edit-mention-policy' }),
      },
      {
        label: `TTS 语音回复: ${config?.ttsEnabled ? '开' : '关'}`,
        action: () => { void toggleTts() },
      },
      {
        label: `TTS 引擎: ${config?.ttsProvider === 'voxcpm' ? 'VoxCPM' : 'Edge TTS'}`,
        action: () => { void toggleTtsProvider() },
      },
      {
        label: `TTS 语音: ${config?.ttsVoice || 'zh-CN-XiaoxiaoNeural (中文)'}`,
        action: () => setStep({ type: 'edit-tts-settings' }),
      },
      {
        label: `TTS 参考音频: ${config?.ttsReferenceAudio ? '已配置' : '未配置'}`,
        action: () => setStep({ type: 'edit-tts-ref-audio' }),
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
        label: '扫码登录（创建应用）',
        action: () => setStep({ type: 'scanning' }),
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

  const saveAdmins = React.useCallback(
    async (value: string) => {
      const users = value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
      setBusy(true)
      try {
        const current = getFeishuConfig()
        saveFeishuConfig({ ...current, admins: users.length > 0 ? users : undefined })
        refreshConfig()
        setNotice({ text: '管理员列表已保存。', tone: 'success' })
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

  const saveAllowedChats = React.useCallback(
    async (value: string) => {
      const chats = value.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
      setBusy(true)
      try {
        const current = getFeishuConfig()
        saveFeishuConfig({ ...current, allowedChats: chats.length > 0 ? chats : undefined })
        refreshConfig()
        setNotice({ text: '允许响应的群列表已保存。', tone: 'success' })
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

  const toggleMentionPolicy = React.useCallback(
    async () => {
      setBusy(true)
      try {
        const current = getFeishuConfig()
        const next = current.requireMentionInGroup !== false ? false : true
        saveFeishuConfig({ ...current, requireMentionInGroup: next })
        refreshConfig()
        setNotice({
          text: next ? '群聊已设为需 @bot 才响应。' : '群聊已设为响应所有消息。',
          tone: 'success',
        })
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

  const toggleTts = React.useCallback(
    async () => {
      setBusy(true)
      try {
        const current = getFeishuConfig()
        const next = !current.ttsEnabled
        saveFeishuConfig({ ...current, ttsEnabled: next })
        refreshConfig()
        setNotice({
          text: next ? 'TTS 语音回复已开启。' : 'TTS 语音回复已关闭。',
          tone: 'success',
        })
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

  const saveTtsVoice = React.useCallback(
    async (value: string) => {
      setBusy(true)
      try {
        const current = getFeishuConfig()
        saveFeishuConfig({ ...current, ttsVoice: value || undefined })
        refreshConfig()
        setNotice({ text: 'TTS 语音已保存。', tone: 'success' })
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

  const toggleTtsProvider = React.useCallback(
    async () => {
      setBusy(true)
      try {
        const current = getFeishuConfig()
        const next = current.ttsProvider === 'edge' ? 'voxcpm' : 'edge'
        saveFeishuConfig({ ...current, ttsProvider: next })
        refreshConfig()
        setNotice({
          text: `TTS 引擎已切换为 ${next === 'edge' ? 'Edge TTS' : 'VoxCPM'}。`,
          tone: 'success',
        })
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

  const saveTtsRefAudio = React.useCallback(
    async (value: string) => {
      setBusy(true)
      try {
        const current = getFeishuConfig()
        saveFeishuConfig({ ...current, ttsReferenceAudio: value || undefined })
        refreshConfig()
        setNotice({ text: '参考音频路径已保存。', tone: 'success' })
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
    if (step.type === 'edit-mention-policy') {
      if (key.escape) {
        setStep({ type: 'menu' })
        return
      }
      if (key.return) {
        void toggleMentionPolicy()
        return
      }
      return
    }

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

  if (step.type === 'edit-admins') {
    return (
      <Dialog title="管理员" onCancel={() => setStep({ type: 'menu' })}>
        <TextInput
          title="管理员 open_id"
          hint="管理员拥有全部权限，可执行 /stop、/config 等管理命令。输入 open_id，多个以空格或逗号分隔。"
          initialValue={config?.admins?.join(', ')}
          onSubmit={value => { void saveAdmins(value) }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'edit-allowed-chats') {
    return (
      <Dialog title="允许响应的群聊" onCancel={() => setStep({ type: 'menu' })}>
        <TextInput
          title="群聊 chat_id"
          hint="输入群聊 chat_id，多个以空格或逗号分隔。仅在白名单中的群聊 bot 才会响应。"
          initialValue={config?.allowedChats?.join(', ')}
          onSubmit={value => { void saveAllowedChats(value) }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'edit-mention-policy') {
    return (
      <Dialog title="@提及要求" onCancel={() => setStep({ type: 'menu' })}>
        <Box flexDirection="column" gap={1}>
          <Text bold>群聊 @bot 要求</Text>
          <Text dimColor>
            当前: {config?.requireMentionInGroup !== false ? '需 @bot 才响应' : '响应所有群消息'}
          </Text>
          <Text dimColor marginTop={1}>
            切换后：
            {'\n'}- 需 @bot: 仅在群聊中被 @ 时才处理消息
            {'\n'}- 响应所有: 群聊中所有消息都会处理
          </Text>
          <Box marginTop={1}>
            <Text>按 Enter 切换，按 Esc 取消</Text>
          </Box>
        </Box>
      </Dialog>
    )
  }

  if (step.type === 'edit-tts-settings') {
    return (
      <Dialog title="TTS 语音设置" onCancel={() => setStep({ type: 'menu' })}>
        <TextInput
          title="TTS 语音名称"
          hint="Edge TTS 语音标识符，例如：zh-CN-XiaoxiaoNeural（中文女声）、zh-CN-YunxiNeural（中文男声）、en-US-JennyNeural（英文女声）。留空恢复默认。"
          initialValue={config?.ttsVoice}
          onSubmit={value => { void saveTtsVoice(value) }}
          onCancel={() => setStep({ type: 'menu' })}
        />
      </Dialog>
    )
  }

  if (step.type === 'edit-tts-ref-audio') {
    return (
      <Dialog title="VoxCPM 参考音频" onCancel={() => setStep({ type: 'menu' })}>
        <TextInput
          title="参考音频路径"
          hint="VoxCPM 语音克隆的参考音频文件路径（支持 WAV/MP3）。留空清空配置。"
          initialValue={config?.ttsReferenceAudio}
          onSubmit={value => { void saveTtsRefAudio(value) }}
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

  if (step.type === 'scanning') {
    return <ScanningDialog onCancel={() => setStep({ type: 'menu' })} onSuccess={() => {
      refreshConfig()
      setStep({ type: 'menu' })
    }} />
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
        <Text>
          管理员:
          {' '}
          {config?.admins?.length
            ? config.admins.join(', ')
            : '未配置'}
        </Text>
        <Text>
          允许群聊:
          {' '}
          {config?.allowedChats?.length
            ? `${config.allowedChats.length} 个`
            : '未配置'}
        </Text>
        <Text>
          群聊 @提及: {config?.requireMentionInGroup !== false ? '需 @bot' : '所有消息'}
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

function ScanningDialog({
  onCancel,
  onSuccess,
}: {
  onCancel: () => void
  onSuccess: () => void
}) {
  const [qrUrl, setQrUrl] = React.useState<string | null>(null)
  const [expireIn, setExpireIn] = React.useState<number>(0)
  const [status, setStatus] = React.useState<string>('正在连接飞书...')
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState(false)
  const [completed, setCompleted] = React.useState(false)

  // Refs to avoid re-triggering the effect when parent passes inline callbacks
  const onSuccessRef = React.useRef(onSuccess)
  onSuccessRef.current = onSuccess
  const onCancelRef = React.useRef(onCancel)
  onCancelRef.current = onCancel

  React.useEffect(() => {
    let cancelled = false

    const run = async () => {
      try {
        const { registerApp } = await import('@larksuite/channel')

        const result = await registerApp({
          source: 'versperclaw',
          onQRCodeReady: (info) => {
            if (cancelled) return
            setQrUrl(info.url)
            setExpireIn(info.expireIn)
            setStatus('请用飞书 App 扫描二维码，并在打开的页面中点击"授权"完成创建')
          },
          onStatusChange: (info) => {
            if (cancelled) return
            if (info.status === 'domain_switched') {
              setStatus('已切换到国际版 (larksuite.com)，请继续...')
            } else if (info.status === 'slow_down') {
              setStatus('等待授权确认中...')
            } else if (info.status === 'polling') {
              setStatus('等待授权确认中，请确保已在飞书中点击了"授权"...')
            }
          },
        })

        if (cancelled) return

        // Save credentials
        saveFeishuConfig({
          appId: result.client_id,
          appSecret: result.client_secret,
          tenant: (result as { user_info?: { tenant_brand?: string } }).user_info?.tenant_brand,
        })

        setSuccess(true)
        setStatus('应用创建成功！正在启动 Bot...')
        setCompleted(true)

        // Start the bot
        await feishuService.stop()
        await feishuService.startFromSavedConfig()

        if (!cancelled) {
          setTimeout(() => onSuccessRef.current(), 1500)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '扫码登录失败')
        }
      }
    }

    run()

    return () => {
      cancelled = true
    }
  }, []) // Run once on mount only — refs avoid dep instability

  useInput((_, key) => {
    if (key.escape && !completed) {
      onCancelRef.current()
    }
  })

  const [qrAscii, setQrAscii] = React.useState<string>('')
  const [qrError, setQrError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!qrUrl) return

    QRCode.toString(qrUrl, { type: 'terminal', small: true })
      .then(ascii => {
        setQrAscii(ascii)
        setQrError(null)
      })
      .catch(err => {
        console.error('[Feishu] QR generation error:', err)
        setQrError('无法生成二维码，请使用下方链接')
      })
  }, [qrUrl])

  return (
    <Dialog title="扫码登录飞书" onCancel={completed ? undefined : onCancel}>
      <Box flexDirection="column" gap={1}>
        {error ? (
          <>
            <Text color="red">错误: {error}</Text>
            <Text dimColor>按 Esc 返回</Text>
          </>
        ) : success ? (
          <>
            <Text color="green">✓ {status}</Text>
          </>
        ) : qrError ? (
          <>
            <Text bold color="yellow">二维码生成失败</Text>
            <Text dimColor marginTop={1}>请使用下方链接完成授权：</Text>
            <Box marginTop={1}>
              <Text selectText>{qrUrl}</Text>
            </Box>
            <Text dimColor marginTop={1}>{status}</Text>
            <Text dimColor marginTop={1}>按 Esc 取消</Text>
          </>
        ) : qrAscii ? (
          <>
            <Text bold>请用飞书 App 扫描下方二维码</Text>
            <Text dimColor>扫描后，请在打开的页面中点击【授权】完成应用创建</Text>
            <Box marginTop={1}>
              <Text>{qrAscii}</Text>
            </Box>
            <Text dimColor marginTop={1}>
              二维码有效期：约 {Math.max(1, Math.round(expireIn / 60))} 分钟
            </Text>
            {qrUrl && (
              <Text dimColor marginTop={1}>
                或打开链接：{qrUrl.slice(0, 70)}...
              </Text>
            )}
            <Text color="cyan" marginTop={1}>{status}</Text>
            <Text dimColor marginTop={1}>按 Esc 取消</Text>
          </>
        ) : (
          <>
            <Text>{status}</Text>
            <Text dimColor>请稍候...</Text>
          </>
        )}
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