import React, { useEffect, useState } from 'react'
import { checkIsGitClean } from '../utils/background/remote/preconditions.js'
import { TeleportStash } from './TeleportStash.js'

export type TeleportLocalErrorType = 'needsGitStash'

type TeleportErrorProps = {
  onComplete: () => void
  errorsToIgnore?: ReadonlySet<TeleportLocalErrorType>
}

export function TeleportError({ onComplete }: TeleportErrorProps) {
  const [needsStash, setNeedsStash] = useState<boolean | null>(null)

  useEffect(() => {
    void checkIsGitClean().then(isClean => setNeedsStash(!isClean))
  }, [])

  useEffect(() => {
    if (needsStash === false) onComplete()
  }, [needsStash, onComplete])

  if (needsStash !== true) return null
  return (
    <TeleportStash
      onStashAndContinue={onComplete}
      onCancel={onComplete}
    />
  )
}

export async function getTeleportErrors(): Promise<Set<TeleportLocalErrorType>> {
  return (await checkIsGitClean()) ? new Set() : new Set(['needsGitStash'])
}
