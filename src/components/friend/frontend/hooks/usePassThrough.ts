/**
 * Web fallback for Tauri window pass-through.
 * In the web version, cursor pass-through is not available.
 * This is a no-op.
 */
import { useEffect } from 'react'

export function usePassThrough(_enabled: boolean) {
  useEffect(() => {
    // No-op in web mode — pass-through is a Tauri-only feature
  }, [_enabled])
}
