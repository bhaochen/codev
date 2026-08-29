// Stub for the missing feishu vendor profile schema.
// Mirrors the shape consumed by the vendored policy/fingerprint modules.
export type SandboxMode = 'none' | 'strict' | 'relaxed'

export interface ProfileConfig {
  access: {
    admins: string[]
    allowedChats: string[]
    allowedUsers: string[]
    requireMentionInGroup: boolean
  }
  attachments: {
    maxCount: number
    maxBytes: number
    maxFileBytes: number
    imageMaxBytes: number
  }
}
