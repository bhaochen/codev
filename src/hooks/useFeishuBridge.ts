/**
 * useFeishuBridge — auto-starts Feishu service if configured.
 */

import { useEffect, useRef } from 'react'
import { feishuService } from '../services/feishu/FeishuService.js'
import { getFeishuConfig } from '../services/feishu/feishuConfig.js'

export function useFeishuBridge(): void {
  const attempted = useRef(false)

  useEffect(() => {
    if (attempted.current) return
    attempted.current = true

    const config = getFeishuConfig()
    if (!config.appId || !config.appSecret) return

    void feishuService.startFromSavedConfig().catch((e) => {
      console.warn('[feishu] auto-start failed:', e instanceof Error ? e.message : String(e))
    })
  }, [])
}