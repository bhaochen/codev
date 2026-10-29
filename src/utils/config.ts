import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import memoize from 'lodash-es/memoize.js'
import pickBy from 'lodash-es/pickBy.js'
import { basename, dirname, join, resolve } from 'path'
import { getOriginalCwd, getSessionTrustAccepted } from '../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../memdir/paths.js'
import { logEvent } from '../services/analytics/index.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import type {
  BillingType,
  ReferralEligibilityResponse,
} from '../services/oauth/types.js'
import { getCwd } from '../utils/cwd.js'
import { registerCleanup } from './cleanupRegistry.js'
import { logForDebugging } from './debug.js'
import { logForDiagnosticsNoPII } from './diagLogs.js'
import { getGlobalClaudeFile } from './env.js'
import { getClaudeConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { ConfigParseError, getErrnoCode } from './errors.js'
import { writeFileSyncAndFlush_DEPRECATED } from './file.js'
import { getFsImplementation } from './fsOperations.js'
import { findCanonicalGitRoot } from './git.js'
import { safeParseJSON } from './json.js'
import { stripBOM } from './jsonRead.js'
import * as lockfile from './lockfile.js'
import { logError } from './log.js'
import type { MemoryType } from './memory/types.js'
import { normalizePathForConfigKey } from './path.js'
import { getEssentialTrafficOnlyReason } from './privacyLevel.js'
import { getManagedFilePath } from './settings/managedPath.js'
import type { ThemeSetting } from './theme.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../memdir/teamMemPaths.js') as typeof import('../memdir/teamMemPaths.js'))
  : null
const ccrAutoConnect = feature('CCR_AUTO_CONNECT')
  ? (require('../bridge/bridgeEnabled.js') as typeof import('../bridge/bridgeEnabled.js'))
  : null

/* eslint-enable @typescript-eslint/no-require-imports */
import type { ImageDimensions } from './imageResizer.js'
import type { ModelOption } from './model/modelOptions.js'
import { jsonParse, jsonStringify } from './slowOperations.js'

// Re-entrancy guard: prevents getConfig → logEvent → getGlobalConfig → getConfig
// infinite recursion when the config file is corrupted. logEvent's sampling check
// reads GrowthBook features from the global config, which calls getConfig again.
let insideGetConfig = false

// Image dimension info for coordinate mapping (only set when image was resized)
export type PastedContent = {
  id: number // Sequential numeric ID
  type: 'text' | 'image'
  content: string
  mediaType?: string // e.g., 'image/png', 'image/jpeg'
  filename?: string // Display name for images in attachment slot
  dimensions?: ImageDimensions
  sourcePath?: string // Original file path for images dragged onto the terminal
}

export interface SerializedStructuredHistoryEntry {
  display: string
  pastedContents?: Record<number, PastedContent>
  pastedText?: string
}
export interface HistoryEntry {
  display: string
  pastedContents: Record<number, PastedContent>
}

export type ReleaseChannel = 'stable' | 'latest'

/** One OpenAI-compatible endpoint in the multi-endpoint custom provider store. */
export type CustomEndpoint = {
  id: string
  baseUrl: string
  apiKey?: string
  modelName?: string
}

function isCanonicalCustomEndpoint(entry: unknown): boolean {
  const ep = entry as Partial<CustomEndpoint> | null
  return (
    typeof ep === 'object' &&
    ep !== null &&
    typeof ep.id === 'string' &&
    typeof ep.baseUrl === 'string' &&
    ep.baseUrl !== '' &&
    (ep.apiKey === undefined || typeof ep.apiKey === 'string') &&
    (ep.modelName === undefined || typeof ep.modelName === 'string')
  )
}

/**
 * Coerce a persisted customEndpoints value into a well-formed array.
 *
 * The field has been persisted in codev.db as a JSON string instead of an
 * array by an older writer. `?? []` only guards null/undefined, so the raw
 * string reached array methods (`.findIndex`, `.map`) and crashed with
 * "… is not a function". Parse strings, drop malformed entries, and
 * synthesize missing ids; arrays already in the canonical shape are
 * returned as-is so this stays allocation-free on every config read.
 */
export function normalizeCustomEndpoints(value: unknown): CustomEndpoint[] {
  let parsed: unknown = value
  if (typeof value === 'string') {
    try {
      parsed = jsonParse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  if (parsed === value && parsed.every(isCanonicalCustomEndpoint)) {
    return parsed
  }
  const result: CustomEndpoint[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const ep = entry as Record<string, unknown>
    if (typeof ep.baseUrl !== 'string' || ep.baseUrl === '') continue
    result.push({
      id:
        typeof ep.id === 'string' && ep.id !== ''
          ? ep.id
          : `ep-${result.length}-${randomBytes(4).toString('hex')}`,
      baseUrl: ep.baseUrl,
      apiKey: typeof ep.apiKey === 'string' ? ep.apiKey : undefined,
      modelName: typeof ep.modelName === 'string' ? ep.modelName : undefined,
    })
  }
  return result
}

export type ProjectConfig = {
  allowedTools: string[]
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  lastAPIDuration?: number
  lastAPIDurationWithoutRetries?: number
  lastToolDuration?: number
  lastCost?: number
  lastDuration?: number
  lastLinesAdded?: number
  lastLinesRemoved?: number
  lastTotalInputTokens?: number
  lastTotalOutputTokens?: number
  lastTotalCacheCreationInputTokens?: number
  lastTotalCacheReadInputTokens?: number
  lastTotalWebSearchRequests?: number
  lastFpsAverage?: number
  lastFpsLow1Pct?: number
  lastSessionId?: string
  lastModelUsage?: Record<
    string,
    {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens: number
      cacheCreationInputTokens: number
      webSearchRequests: number
      costUSD: number
    }
  >
  lastSessionMetrics?: Record<string, number>
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number

  // Trust dialog settings
  hasTrustDialogAccepted?: boolean

  hasCompletedProjectOnboarding?: boolean
  projectOnboardingSeenCount: number
  hasClaudeMdExternalIncludesApproved?: boolean
  hasClaudeMdExternalIncludesWarningShown?: boolean
  // MCP server approval fields - migrated to settings but kept for backward compatibility
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
  // List of disabled MCP servers (all scopes) - used for enable/disable toggle
  disabledMcpServers?: string[]
  // Opt-in list for built-in MCP servers that default to disabled
  enabledMcpServers?: string[]
  // Worktree session management
  activeWorktreeSession?: {
    originalCwd: string
    worktreePath: string
    worktreeName: string
    originalBranch?: string
    sessionId: string
    hookBased?: boolean
  }
  /** Spawn mode for `claude remote-control` multi-session. Set by first-run dialog or `w` toggle. */
  remoteControlSpawnMode?: 'same-dir' | 'worktree'
}

const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  projectOnboardingSeenCount: 0,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
}

export type InstallMethod = 'local' | 'native' | 'global' | 'unknown'

export {
  EDITOR_MODES,
  NOTIFICATION_CHANNELS,
} from './configConstants.js'

import type { EDITOR_MODES, NOTIFICATION_CHANNELS } from './configConstants.js'

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
  organizationName?: string | null // added 4/23/2025, not populated for existing users
  organizationRole?: string | null
  workspaceRole?: string | null
  // Populated by /api/oauth/profile
  displayName?: string
  hasExtraUsageEnabled?: boolean
  billingType?: BillingType | null
  accountCreatedAt?: string
  subscriptionCreatedAt?: string
}

// TODO: 'emacs' is kept for backward compatibility - remove after a few releases
export type EditorMode = 'emacs' | (typeof EDITOR_MODES)[number]

export type DiffTool = 'terminal' | 'auto'

export type OutputStyle = string

export type GlobalConfig = {
  /**
   * @deprecated Use settings.apiKeyHelper instead.
   */
  apiKeyHelper?: string
  
  // Authentication provider configuration
  authProvider?: 'anthropic' | 'openai' | 'openrouter' | 'local' | 'opencode' | 'nvidia' | 'kiro' | 'custom'
  
  // OpenRouter API key
  openRouterApiKey?: string
  
  // OpenAI API configuration
  openAiApiKey?: string
  openAiAccessToken?: string
  openAiRefreshToken?: string
  openAiTokenExpiresAt?: number
  openAiWorkspaceId?: string
  openAiBaseUrl?: string
  
  // Local model configuration
  localBaseUrl?: string
  localModelName?: string
  localModelContextWindow?: number

  // Custom OpenAI-compatible API configuration (multi-endpoint)
  customBaseUrl?: string         // kept for legacy migration
  customApiKey?: string          // kept for legacy migration
  customModelName?: string       // kept for legacy migration
  customEndpoints?: CustomEndpoint[]  // multi-endpoint store
  currentCustomEndpointIndex?: number

  // OpenCode Zen configuration
  openCodeApiKey?: string
  openCodeModelName?: string

  // NVIDIA API key
  nvidiaApiKey?: string

  // Kiro configuration
  kiroAccessToken?: string
  kiroRefreshToken?: string
  kiroProfileArn?: string
  kiroRegion?: string
  kiroTokenExpiresAt?: number
  
  projects?: Record<string, ProjectConfig>
  numStartups: number
  installMethod?: InstallMethod
  autoUpdates?: boolean
  // Flag to distinguish protection-based disabling from user preference
  autoUpdatesProtectedForNative?: boolean
  // Session count when Doctor was last shown
  doctorShownAtSession?: number
  userID?: string
  theme: ThemeSetting
  hasCompletedOnboarding?: boolean
  // Tracks the last version that reset onboarding, used with MIN_VERSION_REQUIRING_ONBOARDING_RESET
  lastOnboardingVersion?: string
  // Tracks the last version for which release notes were seen, used for managing release notes
  lastReleaseNotesSeen?: string
  // Controls the startup welcome logo layout.
  welcomeLogoMode?: 'auto' | 'condensed' | 'full'
  // Controls whether the terminal uses the alternate screen.
  fullscreenMode?: 'auto' | 'fullscreen' | 'window'
  // Timestamp when changelog was last fetched (content stored in ~/.local/share/codev/cache/changelog.md)
  changelogLastFetched?: number
  // @deprecated - Migrated to ~/.local/share/codev/cache/changelog.md. Keep for migration support.
  cachedChangelog?: string
  mcpServers?: Record<string, McpServerConfig>
  // claude.ai MCP connectors that have successfully connected at least once.
  // Used to gate "connector unavailable" / "needs auth" startup notifications:
  // a connector the user has actually used is worth flagging when it breaks,
  // but an org-configured connector that's been needs-auth since day one is
  // something the user has demonstrably ignored and shouldn't nag about.
  claudeAiMcpEverConnected?: string[]
  preferredNotifChannel: NotificationChannel
  /**
   * @deprecated. Use the Notification hook instead (docs/hooks.md).
   */
  customNotifyCommand?: string
  verbose: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryApiKey?: string // Primary API key for the user when no environment variable is set, set via oauth (TODO: rename)
  hasAcknowledgedCostThreshold?: boolean
  hasSeenUndercoverAutoNotice?: boolean // ant-only: whether the one-time auto-undercover explainer has been shown
  hasSeenUltraplanTerms?: boolean // ant-only: whether the one-time CCR terms notice has been shown in the ultraplan launch dialog
  hasResetAutoModeOptInForDefaultOffer?: boolean // ant-only: one-shot migration guard, re-prompts churned auto-mode users
  oauthAccount?: AccountInfo
  iterm2KeyBindingInstalled?: boolean // Legacy - keeping for backward compatibility
  editorMode?: EditorMode
  bypassPermissionsModeAccepted?: boolean
  hasUsedBackslashReturn?: boolean
  autoCompactEnabled: boolean // Controls whether auto-compact is enabled
  autoCompactThresholdPercent?: number // Compact when the usable window is this full; undefined = auto
  autoCompactWindowCap?: number // Absolute ceiling on the effective window; undefined = none
  showTurnDuration: boolean // Controls whether to show turn duration message (e.g., "Cooked for 1m 6s")
  bareModeEnabled: boolean // Legacy max bare mode switch
  bareModeLevel?: 'extreme' | 'ultra' | 'max' | 'high' | 'medium' | 'low'
  /**
   * @deprecated Use settings.env instead.
   */
  env: { [key: string]: string } // Environment variables to set for the CLI
  hasSeenTasksHint?: boolean // Whether the user has seen the tasks hint
  hasUsedStash?: boolean // Whether the user has used the stash feature (Ctrl+S)
  hasUsedBackgroundTask?: boolean // Whether the user has backgrounded a task (Ctrl+B)
  queuedCommandUpHintCount?: number // Counter for how many times the user has seen the queued command up hint
  diffTool?: DiffTool // Which tool to use for displaying diffs (terminal or vscode)

  // Terminal setup state tracking
  iterm2SetupInProgress?: boolean
  iterm2BackupPath?: string // Path to the backup file for iTerm2 preferences
  appleTerminalBackupPath?: string // Path to the backup file for Terminal.app preferences
  appleTerminalSetupInProgress?: boolean // Whether Terminal.app setup is currently in progress

  // Key binding setup tracking
  shiftEnterKeyBindingInstalled?: boolean // Whether Shift+Enter key binding is installed (for iTerm2 or VSCode)
  optionAsMetaKeyInstalled?: boolean // Whether Option as Meta key is installed (for Terminal.app)

  // IDE configurations
  autoConnectIde?: boolean // Whether to automatically connect to IDE on startup if exactly one valid IDE is available
  autoInstallIdeExtension?: boolean // Whether to automatically install IDE extensions when running from within an IDE

  // IDE dialogs
  hasIdeOnboardingBeenShown?: Record<string, boolean> // Map of terminal name to whether IDE onboarding has been shown
  ideHintShownCount?: number // Number of times the /ide command hint has been shown
  hasIdeAutoConnectDialogBeenShown?: boolean // Whether the auto-connect IDE dialog has been shown

  tipsHistory: {
    [tipId: string]: number // Key is tipId, value is the numStartups when tip was last shown
  }

  // /buddy companion soul — bones regenerated from userId on read. See src/buddy/.
  companion?: import('../buddy/types.js').StoredCompanion
  companionMuted?: boolean

  // Feedback survey tracking
  feedbackSurveyState?: {
    lastShownTime?: number
  }

  // Transcript share prompt tracking ("Don't ask again")
  transcriptShareDismissed?: boolean

  // Memory usage tracking
  memoryUsageCount: number // Number of times user has added to memory

  // Sonnet-1M configs
  hasShownS1MWelcomeV2?: Record<string, boolean> // Whether the Sonnet-1M v2 welcome message has been shown per org
  // Cache of Sonnet-1M subscriber access per org - key is org ID
  // hasAccess means "hasAccessAsDefault" but the old name is kept for backward
  // compatibility.
  s1mAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >
  // Cache of Sonnet-1M PayG access per org - key is org ID
  // hasAccess means "hasAccessAsDefault" but the old name is kept for backward
  // compatibility.
  s1mNonSubscriberAccessCache?: Record<
    string,
    { hasAccess: boolean; hasAccessNotAsDefault?: boolean; timestamp: number }
  >

  // Guest passes eligibility cache per org - key is org ID
  passesEligibilityCache?: Record<
    string,
    ReferralEligibilityResponse & { timestamp: number }
  >

  // Grove config cache per account - key is account UUID
  groveConfigCache?: Record<
    string,
    { grove_enabled: boolean; timestamp: number }
  >

  // Guest passes upsell tracking
  passesUpsellSeenCount?: number // Number of times the guest passes upsell has been shown
  hasVisitedPasses?: boolean // Whether the user has visited /passes command
  passesLastSeenRemaining?: number // Last seen remaining_passes count — reset upsell when it increases

  // Overage credit grant upsell tracking (keyed by org UUID — multi-org users).
  // Inlined shape (not import()) because config.ts is in the SDK build surface
  // and the SDK bundler can't resolve CLI service modules.
  overageCreditGrantCache?: Record<
    string,
    {
      info: {
        available: boolean
        eligible: boolean
        granted: boolean
        amount_minor_units: number | null
        currency: string | null
      }
      timestamp: number
    }
  >
  overageCreditUpsellSeenCount?: number // Number of times the overage credit upsell has been shown
  hasVisitedExtraUsage?: boolean // Whether the user has visited /extra-usage — hides credit upsells

  // Voice mode notice tracking
  voiceNoticeSeenCount?: number // Number of times the voice-mode-available notice has been shown
  voiceLangHintShownCount?: number // Number of times the /voice dictation-language hint has been shown
  voiceLangHintLastLanguage?: string // Resolved STT language code when the hint was last shown — reset count when it changes
  voiceFooterHintSeenCount?: number // Number of sessions the "hold X to speak" footer hint has been shown

  // Opus 1M merge notice tracking
  opus1mMergeNoticeSeenCount?: number // Number of times the opus-1m-merge notice has been shown

  // Experiment enrollment notice tracking (keyed by experiment id)
  experimentNoticesSeenCount?: Record<string, number>

  // OpusPlan experiment config
  hasShownOpusPlanWelcome?: Record<string, boolean> // Whether the OpusPlan welcome message has been shown per org

  // Queue usage tracking
  promptQueueUseCount: number // Number of times use has used the prompt queue

  // Btw usage tracking
  btwUseCount: number // Number of times user has used /btw

  // Plan mode usage tracking
  lastPlanModeUse?: number // Timestamp of last plan mode usage

  // Subscription notice tracking
  subscriptionNoticeCount?: number // Number of times the subscription notice has been shown
  hasAvailableSubscription?: boolean // Cached result of whether user has a subscription available
  subscriptionUpsellShownCount?: number // Number of times the subscription upsell has been shown (deprecated)
  recommendedSubscription?: string // Cached config value from Statsig (deprecated)

  // Todo feature configuration
  todoFeatureEnabled: boolean // Whether the todo feature is enabled
  showExpandedTodos?: boolean // Whether to show todos expanded, even when empty
  showSpinnerTree?: boolean // Whether to show the teammate spinner tree instead of pills

  // First start time tracking
  firstStartTime?: string // ISO timestamp when Claude Code was first started on this machine

  messageIdleNotifThresholdMs: number // How long the user has to have been idle to get a notification that Claude is done generating

  githubActionSetupCount?: number // Number of times the user has set up the GitHub Action
  slackAppInstallCount?: number // Number of times the user has clicked to install the Slack app

  // File checkpointing configuration
  fileCheckpointingEnabled: boolean

  // Terminal progress bar configuration (OSC 9;4)
  terminalProgressBarEnabled: boolean

  // Terminal tab status indicator (OSC 21337). When on, emits a colored
  // dot + status text to the tab sidebar and drops the spinner prefix
  // from the title (the dot makes it redundant).
  showStatusInTerminalTab?: boolean

  // Push-notification toggles (set via /config). Default off — explicit opt-in required.
  taskCompleteNotifEnabled?: boolean
  inputNeededNotifEnabled?: boolean
  agentPushNotifEnabled?: boolean

  // Claude Code usage tracking
  claudeCodeFirstTokenDate?: string // ISO timestamp of the user's first Claude Code OAuth token

  // Model switch callout tracking (ant-only)
  modelSwitchCalloutDismissed?: boolean // Whether user chose "Don't show again"
  modelSwitchCalloutLastShown?: number // Timestamp of last shown (don't show for 24h)
  modelSwitchCalloutVersion?: string

  // Effort callout tracking - shown once for Opus 4.6 users
  effortCalloutDismissed?: boolean // v1 - legacy, read to suppress v2 for Pro users who already saw it
  effortCalloutV2Dismissed?: boolean

  // Remote callout tracking - shown once before first bridge enable
  remoteDialogSeen?: boolean

  // Cross-process backoff for initReplBridge's oauth_expired_unrefreshable skip.
  // `expiresAt` is the dedup key — content-addressed, self-clears when /login
  // replaces the token. `failCount` caps false positives: transient refresh
  // failures (auth server 5xx, lock errors) get 3 retries before backoff kicks
  // in, mirroring useReplBridge's MAX_CONSECUTIVE_INIT_FAILURES. Dead-token
  // accounts cap at 3 config writes; healthy+transient-blip self-heals in ~210s.
  bridgeOauthDeadExpiresAt?: number
  bridgeOauthDeadFailCount?: number

  // Desktop upsell startup dialog tracking
  desktopUpsellSeenCount?: number // Total showings (max 3)
  desktopUpsellDismissed?: boolean // "Don't ask again" picked

  // Idle-return dialog tracking
  idleReturnDismissed?: boolean // "Don't ask again" picked

  // Opus 4.5 Pro migration tracking
  opusProMigrationComplete?: boolean
  opusProMigrationTimestamp?: number

  // Sonnet 4.5 1m migration tracking
  sonnet1m45MigrationComplete?: boolean

  // Opus 4.0/4.1 → current Opus migration (shows one-time notif)
  legacyOpusMigrationTimestamp?: number

  // Sonnet 4.5 → 4.6 migration (pro/max/team premium)
  sonnet45To46MigrationTimestamp?: number

  // Cached statsig gate values
  cachedStatsigGates: {
    [gateName: string]: boolean
  }

  // Cached statsig dynamic configs
  cachedDynamicConfigs?: { [configName: string]: unknown }

  // Cached GrowthBook feature values
  cachedGrowthBookFeatures?: { [featureName: string]: unknown }

  // Local GrowthBook overrides (ant-only, set via /config Gates tab).
  // Checked after env-var overrides but before the real resolved value.
  growthBookOverrides?: { [featureName: string]: unknown }

  // Emergency tip tracking - stores the last shown tip to prevent re-showing
  lastShownEmergencyTip?: string

  // File picker gitignore behavior
  respectGitignore: boolean // Whether file picker should respect .gitignore files (default: true). Note: .ignore files are always respected

  // Copy command behavior
  copyFullResponse: boolean // Whether /copy always copies the full response instead of showing the picker

  // Fullscreen in-app text selection behavior
  copyOnSelect?: boolean // Auto-copy to clipboard on mouse-up (undefined → true; lets cmd+c "work" via no-op)

  // GitHub repo path mapping for teleport directory switching
  // Key: "owner/repo" (lowercase), Value: array of absolute paths where repo is cloned
  githubRepoPaths?: Record<string, string[]>

  // Terminal emulator to launch for claude-cli:// deep links. Captured from
  // TERM_PROGRAM during interactive sessions since the deep link handler runs
  // headless (LaunchServices/xdg) with no TERM_PROGRAM set.
  deepLinkTerminal?: string

  // iTerm2 it2 CLI setup
  iterm2It2SetupComplete?: boolean // Whether it2 setup has been verified
  preferTmuxOverIterm2?: boolean // User preference to always use tmux over iTerm2 split panes

  // Skill usage tracking for autocomplete ranking
  skillUsage?: Record<string, { usageCount: number; lastUsedAt: number }>
  // Official marketplace auto-install tracking
  officialMarketplaceAutoInstallAttempted?: boolean // Whether auto-install was attempted
  officialMarketplaceAutoInstalled?: boolean // Whether auto-install succeeded
  officialMarketplaceAutoInstallFailReason?:
    | 'policy_blocked'
    | 'git_unavailable'
    | 'gcs_unavailable'
    | 'unknown' // Reason for failure if applicable
  officialMarketplaceAutoInstallRetryCount?: number // Number of retry attempts
  officialMarketplaceAutoInstallLastAttemptTime?: number // Timestamp of last attempt
  officialMarketplaceAutoInstallNextRetryTime?: number // Earliest time to retry again

  // Claude in Chrome settings
  hasCompletedClaudeInChromeOnboarding?: boolean // Whether Claude in Chrome onboarding has been shown
  claudeInChromeDefaultEnabled?: boolean // Whether Claude in Chrome is enabled by default (undefined means platform default)
  cachedChromeExtensionInstalled?: boolean // Cached result of whether Chrome extension is installed

  // Chrome extension pairing state (persisted across sessions)
  chromeExtension?: {
    pairedDeviceId?: string
    pairedDeviceName?: string
  }

  // LSP plugin recommendation preferences
  lspRecommendationDisabled?: boolean // Disable all LSP plugin recommendations
  lspRecommendationNeverPlugins?: string[] // Plugin IDs to never suggest
  lspRecommendationIgnoredCount?: number // Track ignored recommendations (stops after 5)

  // Claude Code hint protocol state (<claude-code-hint /> tags from CLIs/SDKs).
  // Nested by hint type so future types (docs, mcp, ...) slot in without new
  // top-level keys.
  claudeCodeHints?: {
    // Plugin IDs the user has already been prompted for. Show-once semantics:
    // recorded regardless of yes/no response, never re-prompted. Capped at
    // 100 entries to bound config growth — past that, hints stop entirely.
    plugin?: string[]
    // User chose "don't show plugin installation hints again" from the dialog.
    disabled?: boolean
  }

  // Permission explainer configuration
  permissionExplainerEnabled?: boolean // Enable Haiku-generated explanations for permission requests (default: true)

  // Teammate spawn mode: 'auto' | 'tmux' | 'in-process'
  teammateMode?: 'auto' | 'tmux' | 'in-process' // How to spawn teammates (default: 'auto')
  // Model for new teammates when the tool call doesn't pass one.
  // undefined = hardcoded Opus (backward-compat); null = leader's model; string = model alias/ID.
  teammateDefaultModel?: string | null

  // PR status footer configuration (feature-flagged via GrowthBook)
  prStatusFooterEnabled?: boolean // Show PR review status in footer (default: true)

  // Tmux live panel visibility (ant-only, toggled via Enter on tmux pill)
  tungstenPanelVisible?: boolean

  // Cached org-level fast mode status from the API.
  // Used to detect cross-session changes and notify users.
  penguinModeOrgEnabled?: boolean

  // Epoch ms when background refreshes last ran (fast mode, quota, passes, client data).
  // Used with tengu_cicada_nap_ms to throttle API calls
  startupPrefetchedAt?: number

  // Run Remote Control at startup (requires BRIDGE_MODE)
  // undefined = use default (see getRemoteControlAtStartup() for precedence)
  remoteControlAtStartup?: boolean

  // Cached extra usage disabled reason from the last API response
  // undefined = no cache, null = extra usage enabled, string = disabled reason.
  cachedExtraUsageDisabledReason?: string | null

  // Auto permissions notification tracking (ant-only)
  autoPermissionsNotificationCount?: number // Number of times the auto permissions notification has been shown

  // Speculation configuration (ant-only)
  speculationEnabled?: boolean // Whether speculation is enabled (default: true)


  // Client data for server-side experiments (fetched during bootstrap).
  clientDataCache?: Record<string, unknown> | null

  // Additional model options for the model picker (fetched during bootstrap).
  additionalModelOptionsCache?: ModelOption[]

  // Disk cache for /api/claude_code/organizations/metrics_enabled.
  // Org-level settings change rarely; persisting across processes avoids a
  // cold API call on every `claude -p` invocation.
  metricsStatusCache?: {
    enabled: boolean
    timestamp: number
  }

  // Version of the last-applied migration set. When equal to
  // CURRENT_MIGRATION_VERSION, runMigrations() skips all sync migrations
  // (avoiding 11× saveGlobalConfig lock+re-read on every startup).
  migrationVersion?: number

  // Version of the session migration (JSONL → SQLite). When equal to
  // CURRENT_SESSION_MIGRATION_VERSION, runMigrations() skips the session
  // migration. Increment when the migration logic changes significantly.
  sessionMigrationVersion?: number

}

/**
 * Factory for a fresh default GlobalConfig. Used instead of deep-cloning a
 * shared constant — the nested containers (arrays, records) are all empty, so
 * a factory gives fresh refs at zero clone cost.
 */
function createDefaultGlobalConfig(): GlobalConfig {
  return {
    numStartups: 0,
    installMethod: undefined,
    autoUpdates: undefined,
    theme: 'dark',
    welcomeLogoMode: 'auto',
    fullscreenMode: 'auto',
    preferredNotifChannel: 'auto',
    verbose: false,
    editorMode: 'normal',
    autoCompactEnabled: true,
    showTurnDuration: true,
    bareModeEnabled: false,
    bareModeLevel: undefined,
    hasSeenTasksHint: false,
    hasUsedStash: false,
    hasUsedBackgroundTask: false,
    queuedCommandUpHintCount: 0,
    diffTool: 'auto',
    customApiKeyResponses: {
      approved: [],
      rejected: [],
    },
    env: {},
    tipsHistory: {},
    memoryUsageCount: 0,
    promptQueueUseCount: 0,
    btwUseCount: 0,
    todoFeatureEnabled: true,
    showExpandedTodos: false,
    messageIdleNotifThresholdMs: 60000,
    autoConnectIde: false,
    autoInstallIdeExtension: true,
    fileCheckpointingEnabled: true,
    terminalProgressBarEnabled: true,
    cachedStatsigGates: {},
    cachedDynamicConfigs: {},
    cachedGrowthBookFeatures: {},
    respectGitignore: true,
    copyFullResponse: false,
  }
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = createDefaultGlobalConfig()

export const GLOBAL_CONFIG_KEYS = [
  'apiKeyHelper',
  'authProvider',
  'openRouterApiKey',
  'openAiApiKey',
  'openAiAccessToken',
  'openAiBaseUrl',
  'localBaseUrl',
  'localModelName',
  'localModelContextWindow',
  'customBaseUrl',
  'customApiKey',
  'customModelName',
  'customEndpoints',
  'currentCustomEndpointIndex',
  'nvidiaApiKey',
  'kiroAccessToken',
  'kiroRefreshToken',
  'kiroProfileArn',
  'kiroRegion',
  'kiroTokenExpiresAt',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'theme',
  'welcomeLogoMode',
  'fullscreenMode',
  'verbose',
  'preferredNotifChannel',
  'shiftEnterKeyBindingInstalled',
  'editorMode',
  'hasUsedBackslashReturn',
  'bareModeEnabled',
  'bareModeLevel',
  'autoCompactEnabled',
  'autoCompactThresholdPercent',
  'autoCompactWindowCap',
  'showTurnDuration',
  'diffTool',
  'env',
  'tipsHistory',
  'todoFeatureEnabled',
  'showExpandedTodos',
  'messageIdleNotifThresholdMs',
  'autoConnectIde',
  'autoInstallIdeExtension',
  'fileCheckpointingEnabled',
  'terminalProgressBarEnabled',
  'showStatusInTerminalTab',
  'taskCompleteNotifEnabled',
  'inputNeededNotifEnabled',
  'agentPushNotifEnabled',
  'respectGitignore',
  'claudeInChromeDefaultEnabled',
  'hasCompletedClaudeInChromeOnboarding',
  'lspRecommendationDisabled',
  'lspRecommendationNeverPlugins',
  'lspRecommendationIgnoredCount',
  'copyFullResponse',
  'copyOnSelect',
  'permissionExplainerEnabled',
  'prStatusFooterEnabled',
  'remoteControlAtStartup',
  'remoteDialogSeen',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'allowedTools',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

/**
 * Check if the user has already accepted the trust dialog for the cwd.
 *
 * This function traverses parent directories to check if a parent directory
 * had approval. Accepting trust for a directory implies trust for child
 * directories.
 *
 * @returns Whether the trust dialog has been accepted (i.e. "should not be shown")
 */
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

export function checkHasTrustDialogAccepted(): boolean {
  // Trust only transitions false→true during a session (never the reverse),
  // so once true we can latch it. false is not cached — it gets re-checked
  // on every call so that trust dialog acceptance is picked up mid-session.
  // (lodash memoize doesn't fit here because it would also cache false.)
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

function computeTrustDialogAccepted(): boolean {
  // Check session-level trust (for home directory case where trust is not persisted)
  // When running from home dir, trust dialog is shown but acceptance is stored
  // in memory only. This allows hooks and other features to work during the session.
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  // Always check where trust would be saved (git root or original cwd)
  // This is the primary location where trust is persisted by saveCurrentProjectConfig
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  // Now check from current working directory and its parents
  // Normalize paths for consistent JSON key lookup
  let currentPath = normalizePathForConfigKey(getCwd())

  // Traverse all parent directories
  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    // Stop if we've reached the root (when parent is same as current)
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

/**
 * Check trust for an arbitrary directory (not the session cwd).
 * Walks up from `dir`, returning true if any ancestor has trust persisted.
 * Unlike checkHasTrustDialogAccepted, this does NOT consult session trust or
 * the memoized project path — use when the target dir differs from cwd (e.g.
 * /assistant installing into a user-typed path).
 */
export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

// We have to put this test code here because Jest doesn't support mocking ES modules :O
const TEST_GLOBAL_CONFIG_FOR_TESTING: GlobalConfig = {
  ...DEFAULT_GLOBAL_CONFIG,
  autoUpdates: false,
}
const TEST_PROJECT_CONFIG_FOR_TESTING: ProjectConfig = {
  ...DEFAULT_PROJECT_CONFIG,
}

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}

/**
 * Detect whether writing `fresh` would lose auth/onboarding state that the
 * in-memory cache still has. This happens when `getConfig` hits a corrupted
 * or truncated file mid-write (from another process or a non-atomic fallback)
 * and returns DEFAULT_GLOBAL_CONFIG. Writing that back would permanently
 * wipe auth. See GH #3117.
 */
function wouldLoseAuthState(fresh: {
  oauthAccount?: unknown
  hasCompletedOnboarding?: boolean
}): boolean {
  const cached = globalConfigCache.config
  if (!cached) return false
  const lostOauth =
    cached.oauthAccount !== undefined && fresh.oauthAccount === undefined
  const lostOnboarding =
    cached.hasCompletedOnboarding === true &&
    fresh.hasCompletedOnboarding !== true
  return lostOauth || lostOnboarding
}

export function saveGlobalConfig(
  updater: (currentConfig: GlobalConfig) => GlobalConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_GLOBAL_CONFIG_FOR_TESTING)
    // Skip if no changes (same reference returned)
    if (config === TEST_GLOBAL_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_GLOBAL_CONFIG_FOR_TESTING, config)
    return
  }

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const config = updater(current)
        // Skip if no changes (same reference returned)
        if (config === current) {
          return current
        }
        written = {
          ...config,
          projects: removeProjectHistory(current.projects),
        }
        return written
      },
    )
    // Only write-through if we actually wrote. If the auth-loss guard
    // tripped (or the updater made no changes), the file is untouched and
    // the cache is still valid -- touching it would corrupt the guard.
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })
    // Fall back to non-locked version on error. This fallback is a race
    // window: if another process is mid-write (or the file got truncated),
    // getConfig returns defaults. Refuse to write those over a good cached
    // config to avoid wiping auth. See GH #3117.
    const currentConfig = getConfig(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
    )
    if (wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveGlobalConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const config = updater(currentConfig)
    // Skip if no changes (same reference returned)
    if (config === currentConfig) {
      return
    }
    written = {
      ...config,
      projects: removeProjectHistory(currentConfig.projects),
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

// Cache for global config
let globalConfigCache: { config: GlobalConfig | null; mtime: number } = {
  config: null,
  mtime: 0,
}

// Tracking for config file operations (telemetry)
let lastReadFileStats: { mtime: number; size: number } | null = null
let configCacheHits = 0
let configCacheMisses = 0
// Session-total count of actual disk writes to the global config file.
// Exposed for ant-only dev diagnostics (see inc-4552) so anomalous write
// rates surface in the UI before they corrupt ~/.local/share/codev/config.json.
let globalConfigWriteCount = 0

export function getGlobalConfigWriteCount(): number {
  return globalConfigWriteCount
}

export const CONFIG_WRITE_DISPLAY_THRESHOLD = 20

function reportConfigCacheStats(): void {
  const total = configCacheHits + configCacheMisses
  if (total > 0) {
    logEvent('tengu_config_cache_stats', {
      cache_hits: configCacheHits,
      cache_misses: configCacheMisses,
      hit_rate: configCacheHits / total,
    })
  }
  configCacheHits = 0
  configCacheMisses = 0
}

// Register cleanup to report cache stats at session end
// eslint-disable-next-line custom-rules/no-top-level-side-effects
registerCleanup(async () => {
  reportConfigCacheStats()
})

/**
 * Migrates old autoUpdaterStatus to new installMethod and autoUpdates fields
 * @internal
 */
/**
 * Migrate legacy single custom-endpoint fields to the new multi-endpoint store.
 * Repairs customEndpoints values persisted in a non-array shape (e.g. a JSON
 * string) and falls back to the legacy single-endpoint fields when the store
 * is absent or empty.
 */
function migrateCustomEndpoints(config: GlobalConfig): GlobalConfig {
  const endpoints = normalizeCustomEndpoints(config.customEndpoints)
  if (endpoints.length > 0) {
    // Skip the rewrite when the stored value was already a valid array
    if (endpoints === config.customEndpoints) return config
    return { ...config, customEndpoints: endpoints }
  }
  const { customBaseUrl, customApiKey, customModelName } = config
  if (!customBaseUrl) return config
  return {
    ...config,
    customEndpoints: [{
      id: randomBytes(4).toString('hex'),
      baseUrl: customBaseUrl,
      apiKey: customApiKey,
      modelName: customModelName,
    }],
    currentCustomEndpointIndex: 0,
  }
}

function migrateConfigFields(config: GlobalConfig): GlobalConfig {
  // Already migrated
  if (config.installMethod !== undefined) {
    return migrateCustomEndpoints(config)
  }

  // autoUpdaterStatus is removed from the type but may exist in old configs
  const legacy = config as GlobalConfig & {
    autoUpdaterStatus?:
      | 'migrated'
      | 'installed'
      | 'disabled'
      | 'enabled'
      | 'no_permissions'
      | 'not_configured'
  }

  // Determine install method and auto-update preference from old field
  let installMethod: InstallMethod = 'unknown'
  let autoUpdates = config.autoUpdates ?? true // Default to enabled unless explicitly disabled

  switch (legacy.autoUpdaterStatus) {
    case 'migrated':
      installMethod = 'local'
      break
    case 'installed':
      installMethod = 'native'
      break
    case 'disabled':
      // When disabled, we don't know the install method
      autoUpdates = false
      break
    case 'enabled':
    case 'no_permissions':
    case 'not_configured':
      // These imply global installation
      installMethod = 'global'
      break
    case undefined:
      // No old status, keep defaults
      break
  }

  return {
    ...config,
    installMethod,
    autoUpdates,
  }
}

/**
 * Removes history field from projects (migrated to history.jsonl)
 * @internal
 */
function removeProjectHistory(
  projects: Record<string, ProjectConfig> | undefined,
): Record<string, ProjectConfig> | undefined {
  if (!projects) {
    return projects
  }

  const cleanedProjects: Record<string, ProjectConfig> = {}
  let needsCleaning = false

  for (const [path, projectConfig] of Object.entries(projects)) {
    // history is removed from the type but may exist in old configs
    const legacy = projectConfig as ProjectConfig & { history?: unknown }
    if (legacy.history !== undefined) {
      needsCleaning = true
      const { history, ...cleanedConfig } = legacy
      cleanedProjects[path] = cleanedConfig
    } else {
      cleanedProjects[path] = projectConfig
    }
  }

  return needsCleaning ? cleanedProjects : projects
}

// fs.watchFile poll interval for detecting writes from other instances (ms)
const CONFIG_FRESHNESS_POLL_MS = 1000
let freshnessWatcherStarted = false
let freshnessWatcher: ReturnType<typeof setInterval> | null = null

function startGlobalConfigFreshnessWatcher(): void {
  if (freshnessWatcherStarted || process.env.NODE_ENV === 'test') return
  freshnessWatcherStarted = true
  let lastContent: string | null = null
  const readDocument = (): string | null => {
    try {
      const { getSessionStore } = require('../services/db/SessionStore.js') as
        typeof import('../services/db/SessionStore.js')
      return getSessionStore().getAppDocument('config', 'global')
    } catch {
      return null
    }
  }
  lastContent = readDocument()
  freshnessWatcher = setInterval(() => {
    const content = readDocument()
    if (content === null || content === lastContent) return
    lastContent = content
    const parsed = safeParseJSON(content)
    if (parsed === null || typeof parsed !== 'object') return
    globalConfigCache = {
      config: migrateConfigFields({
        ...createDefaultGlobalConfig(),
        ...(parsed as Partial<GlobalConfig>),
      }),
      mtime: Date.now(),
    }
    lastReadFileStats = null
  }, CONFIG_FRESHNESS_POLL_MS)
  freshnessWatcher.unref?.()
  registerCleanup(async () => {
    if (freshnessWatcher) clearInterval(freshnessWatcher)
    freshnessWatcher = null
    freshnessWatcherStarted = false
  })
}

// Write-through: what we just wrote IS the new config. cache.mtime overshoots
// the file's real mtime (Date.now() is recorded after the write) so the
// freshness watcher skips re-reading our own write on its next tick.
function writeThroughGlobalConfigCache(config: GlobalConfig): void {
  globalConfigCache = { config, mtime: Date.now() }
  lastReadFileStats = null
}

export function getGlobalConfig(): GlobalConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_GLOBAL_CONFIG_FOR_TESTING
  }

  // Fast path: pure memory read. After startup, this always hits — our own
  // writes go write-through and other instances' writes are picked up by the
  // background freshness watcher (never blocks this path).
  if (globalConfigCache.config) {
    configCacheHits++
    return globalConfigCache.config
  }

  // Slow path: startup load. Read from DB (the sole durable store for global config).
  configCacheMisses++
  try {
    const config = migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
    globalConfigCache = {
      config,
      mtime: Date.now(),
    }
    startGlobalConfigFreshnessWatcher()
    return config
  } catch {
    // If anything goes wrong, fall back to uncached behavior
    return migrateConfigFields(
      getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig),
    )
  }
}

/** Read the persisted global config during early startup, before config gates open. */
export function getGlobalConfigSnapshot(): GlobalConfig {
  // In test mode, always return the in-memory test config so tests are
  // isolated from the on-disk database state that other tests may mutate.
  if (process.env.NODE_ENV === 'test') return TEST_GLOBAL_CONFIG_FOR_TESTING
  try {
    const content = readGlobalConfigFromDatabase(getGlobalClaudeFile())
    if (content) {
      const parsed = jsonParse(content) as Partial<GlobalConfig>
      return migrateConfigFields({ ...createDefaultGlobalConfig(), ...parsed })
    }
  } catch (error) {
    logForDebugging(`Could not read config snapshot from codev.db: ${error}`)
  }
  const mcpServers = readEditableMcpServers(getGlobalClaudeFile())
  return migrateConfigFields({
    ...createDefaultGlobalConfig(),
    ...(mcpServers ? { mcpServers } : {}),
  })
}

/**
 * Returns the effective value of remoteControlAtStartup. Precedence:
 *   1. User's explicit config value (always wins — honors opt-out)
 *   2. CCR auto-connect default (ant-only build, GrowthBook-gated)
 *   3. false (Remote Control must be explicitly opted into)
 */
export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) return explicit
  if (feature('CCR_AUTO_CONNECT')) {
    if (ccrAutoConnect?.getCcrAutoConnectDefault()) return true
  }
  return false
}

export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

function saveConfig<A extends object>(
  file: string,
  config: A,
  defaultConfig: A,
): void {
  if (file === getGlobalClaudeFile() && process.env.NODE_ENV !== 'test') {
    const filteredConfig = pickBy(
      config,
      (value, key) =>
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )
    persistGlobalConfigDocument(file, jsonStringify(filteredConfig))
    globalConfigWriteCount++
    return
  }
  // Ensure the directory exists before writing the config file
  const dir = dirname(file)
  const fs = getFsImplementation()
  // mkdirSync is already recursive in FsOperations implementation
  fs.mkdirSync(dir)

  // Filter out any values that match the defaults
  const filteredConfig = pickBy(
    config,
    (value, key) =>
      jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
  )
  // Write config file with secure permissions - mode only applies to new files
  const serialized = jsonStringify(filteredConfig, null, 2)
  writeFileSyncAndFlush_DEPRECATED(
    file,
    serialized,
    {
      encoding: 'utf-8',
      mode: 0o600,
    },
  )
  if (file === getGlobalClaudeFile()) {
    persistGlobalConfigDocument(file, serialized)
    globalConfigWriteCount++
  }
}

/** Persist global config in SQLite and keep editable MCP definitions in mcp.json. */
function persistGlobalConfigDocument(file: string, content: string): void {
  if (file !== getGlobalClaudeFile() || process.env.NODE_ENV === 'test') return
  try {
    const parsed = jsonParse(content) as Record<string, unknown>
    const mcpServers = parsed.mcpServers
    delete parsed.mcpServers
    const mcpPath = join(dirname(file), 'mcp.json')
    const fs = getFsImplementation()
    fs.mkdirSync(dirname(mcpPath))
    writeFileSyncAndFlush_DEPRECATED(
      mcpPath,
      jsonStringify({ mcpServers: mcpServers ?? {} }, null, 2),
      { encoding: 'utf-8', mode: 0o600 },
    )
    const { getSessionStore } = require('../services/db/SessionStore.js') as
      typeof import('../services/db/SessionStore.js')
    getSessionStore().upsertAppDocument('config', 'global', jsonStringify(parsed))
  } catch (error) {
    logForDebugging(`Could not persist global config: ${error}`)
  }
}

function readEditableMcpServers(file: string): Record<string, McpServerConfig> | undefined {
  try {
    const raw = getFsImplementation().readFileSync(
      join(dirname(file), 'mcp.json'),
      { encoding: 'utf-8' },
    )
    const parsed = jsonParse(raw) as { mcpServers?: unknown }
    return parsed.mcpServers && typeof parsed.mcpServers === 'object'
      ? parsed.mcpServers as Record<string, McpServerConfig>
      : undefined
  } catch {
    return undefined
  }
}

function readGlobalConfigFromDatabase(file: string): string | null {
  // Require: correct logical path + not test + running inside the data directory
  // that belongs to this global config file.
  // Deriving the data-dir expectation from the file path avoids the need for
  // a runtime CODEV_DATA_DIR env-var to be set — the binary writes directly
  // into ~/.local/share/codev/ (or wherever the data dir lives) without one.
  const expectedDataDir = dirname(getGlobalClaudeFile())
  const actualDataDir = dirname(file)
  const inDataDirContext = actualDataDir === expectedDataDir
  if (file !== getGlobalClaudeFile() || process.env.NODE_ENV === 'test' || !inDataDirContext) {
    return null
  }
  try {
    const { getSessionStore } = require('../services/db/SessionStore.js') as
      typeof import('../services/db/SessionStore.js')
    const content = getSessionStore().getAppDocument('config', 'global')
    if (content === null) return null
    const config = jsonParse(content) as Record<string, unknown>
    const mcpServers = readEditableMcpServers(file)
    if (mcpServers) config.mcpServers = mcpServers
    return jsonStringify(config)
  } catch (error) {
    logForDebugging(`Could not read global config from codev.db: ${error}`)
    return null
  }
}

/**
 * Returns true if a write was performed; false if the write was skipped
 * (no changes, or auth-loss guard tripped). Callers use this to decide
 * whether to invalidate the cache -- invalidating after a skipped write
 * destroys the good cached state the auth-loss guard depends on.
 */
function saveConfigWithLock<A extends object>(
  file: string,
  createDefault: () => A,
  mergeFn: (current: A) => A,
): boolean {
  const defaultConfig = createDefault()
  if (file === getGlobalClaudeFile() && process.env.NODE_ENV !== 'test') {
    const { getSessionStore } = require('../services/db/SessionStore.js') as
      typeof import('../services/db/SessionStore.js')
    const store = getSessionStore()
    let didWrite = false
    store.transaction(() => {
      const stored = store.getAppDocument('config', 'global')
      let currentConfig = createDefault()
      if (stored !== null) {
        try {
          currentConfig = { ...createDefault(), ...jsonParse(stored) }
        } catch (error) {
          logForDebugging(`Invalid global config in codev.db: ${error}`, { level: 'error' })
        }
      }
      if (wouldLoseAuthState(currentConfig)) return
      const mergedConfig = mergeFn(currentConfig)
      if (mergedConfig === currentConfig) return
      const filteredConfig = pickBy(
        mergedConfig,
        (value, key) =>
          jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
      )
      persistGlobalConfigDocument(file, jsonStringify(filteredConfig))
      didWrite = true
    })
    if (didWrite) globalConfigWriteCount++
    return didWrite
  }
  const dir = dirname(file)
  const fs = getFsImplementation()

  // Ensure directory exists (mkdirSync is already recursive in FsOperations)
  fs.mkdirSync(dir)

  let release
  try {
    const lockFilePath = `${file}.lock`
    const startTime = Date.now()
    release = lockfile.lockSync(file, {
      lockfilePath: lockFilePath,
      onCompromised: err => {
        // Default onCompromised throws from a setTimeout callback, which
        // becomes an unhandled exception. Log instead -- the lock being
        // stolen (e.g. after a 10s event-loop stall) is recoverable.
        logForDebugging(`Config lock compromised: ${err}`, { level: 'error' })
      },
    })
    const lockTime = Date.now() - startTime
    if (lockTime > 100) {
      logForDebugging(
        'Lock acquisition took longer than expected - another Claude instance may be running',
      )
      logEvent('tengu_config_lock_contention', {
        lock_time_ms: lockTime,
      })
    }

    // Check for stale write - file changed since we last read it
    // Only check for global config file since lastReadFileStats tracks that specific file
    if (lastReadFileStats && file === getGlobalClaudeFile()) {
      try {
        const currentStats = fs.statSync(file)
        if (
          currentStats.mtimeMs !== lastReadFileStats.mtime ||
          currentStats.size !== lastReadFileStats.size
        ) {
          logEvent('tengu_config_stale_write', {
            read_mtime: lastReadFileStats.mtime,
            write_mtime: currentStats.mtimeMs,
            read_size: lastReadFileStats.size,
            write_size: currentStats.size,
          })
        }
      } catch (e) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          throw e
        }
        // File doesn't exist yet, no stale check needed
      }
    }

    // Re-read the current config to get latest state. If the file is
    // momentarily corrupted (concurrent writes, kill-during-write), this
    // returns defaults -- we must not write those back over good config.
    const currentConfig = getConfig(file, createDefault)
    if (file === getGlobalClaudeFile() && wouldLoseAuthState(currentConfig)) {
      logForDebugging(
        'saveConfigWithLock: re-read config is missing auth that cache has; refusing to write to avoid wiping ~/.local/share/codev/config.json. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return false
    }

    // Apply the merge function to get the updated config
    const mergedConfig = mergeFn(currentConfig)

    // Skip write if no changes (same reference returned)
    if (mergedConfig === currentConfig) {
      return false
    }

    // Filter out any values that match the defaults
    const filteredConfig = pickBy(
      mergedConfig,
      (value, key) =>
        jsonStringify(value) !== jsonStringify(defaultConfig[key as keyof A]),
    )
    const serialized = jsonStringify(filteredConfig, null, 2)

    if (file === getGlobalClaudeFile()) {
      persistGlobalConfigDocument(file, serialized)
      globalConfigWriteCount++
      return true
    }
    writeFileSyncAndFlush_DEPRECATED(
      file,
      serialized,
      {
        encoding: 'utf-8',
        mode: 0o600,
      },
    )
    return true
  } finally {
    if (release) {
      release()
    }
  }
}

// Flag to track if config reading is allowed
let configReadingAllowed = false

export function isConfigReadingAllowed(): boolean {
  return configReadingAllowed
}

export function enableConfigs(): void {
  if (configReadingAllowed) {
    // Ensure this is idempotent
    return
  }

  const startTime = Date.now()
  logForDiagnosticsNoPII('info', 'enable_configs_started')

  // Any reads to configuration before this flag is set show an console warning
  // to prevent us from adding config reading during module initialization
  configReadingAllowed = true
  // We only check the global config because currently all the configs share a file
  getConfig(
    getGlobalClaudeFile(),
    createDefaultGlobalConfig,
    true /* throw on invalid */,
  )

  logForDiagnosticsNoPII('info', 'enable_configs_completed', {
    duration_ms: Date.now() - startTime,
  })
}

function getConfig<A>(
  file: string,
  createDefault: () => A,
  throwOnInvalid?: boolean,
): A {
  // Log a warning if config is accessed before it's allowed
  if (!configReadingAllowed && process.env.NODE_ENV !== 'test') {
    throw new Error('Config accessed before allowed.')
  }

  const fs = getFsImplementation()

  if (file === getGlobalClaudeFile() && process.env.NODE_ENV !== 'test') {
    const stored = readGlobalConfigFromDatabase(file)
    if (stored !== null) {
      try {
        return { ...createDefault(), ...jsonParse(stored) }
      } catch (error) {
        logForDebugging(`Global config document in codev.db is invalid: ${error}`, { level: 'error' })
        return createDefault()
      }
    }
    const mcpServers = readEditableMcpServers(file)
    return {
      ...createDefault(),
      ...(mcpServers ? { mcpServers } : {}),
    }
  }

  try {
    const fileContent = fs.readFileSync(file, {
      encoding: 'utf-8',
    })
    try {
      // Strip BOM before parsing - PowerShell 5.x adds BOM to UTF-8 files
      const parsedConfig = jsonParse(stripBOM(fileContent))
      persistGlobalConfigDocument(file, fileContent)
      return {
        ...createDefault(),
        ...parsedConfig,
      }
    } catch (error) {
      // Throw a ConfigParseError with the file path and default config
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      throw new ConfigParseError(errorMessage, file, createDefault())
    }
  } catch (error) {
    const errCode = getErrnoCode(error)
    if (errCode === 'ENOENT') {
      const databaseConfig = readGlobalConfigFromDatabase(file)
      if (databaseConfig !== null) {
        try {
          const parsedConfig = jsonParse(stripBOM(databaseConfig))
          return { ...createDefault(), ...parsedConfig }
        } catch (dbError) {
          logForDebugging(
            `Global config document in codev.db is invalid: ${dbError}`,
            { level: 'error' },
          )
        }
      }
      return createDefault()
    }

    // Re-throw ConfigParseError if throwOnInvalid is true
    if (error instanceof ConfigParseError && throwOnInvalid) {
      throw error
    }

    // Log config parse errors so users know what happened
    if (error instanceof ConfigParseError) {
      logForDebugging(
        `Config file corrupted, resetting to defaults: ${error.message}`,
        { level: 'error' },
      )

      // Guard: logEvent → shouldSampleEvent → getGlobalConfig → getConfig
      // causes infinite recursion when the config file is corrupted, because
      // the sampling check reads a GrowthBook feature from global config.
      // Only log analytics on the outermost call.
      if (!insideGetConfig) {
        insideGetConfig = true
        try {
          // Log the error for monitoring
          logError(error)
          logEvent('tengu_config_parse_error', {})
        } finally {
          insideGetConfig = false
        }
      }

      process.stderr.write(
        `\nClaude configuration file at ${file} is corrupted: ${error.message}\n`,
      )
    }

    return createDefault()
  }
}

// Memoized function to get the project path for config lookup
export const getProjectPathForConfig = memoize((): string => {
  const originalCwd = getOriginalCwd()
  const gitRoot = findCanonicalGitRoot(originalCwd)

  if (gitRoot) {
    // Normalize for consistent JSON keys (forward slashes on all platforms)
    // This ensures paths like C:\Users\... and C:/Users/... map to the same key
    return normalizePathForConfigKey(gitRoot)
  }

  // Not in a git repo
  return normalizePathForConfigKey(resolve(originalCwd))
})

export function getCurrentProjectConfig(): ProjectConfig {
  if (process.env.NODE_ENV === 'test') {
    return TEST_PROJECT_CONFIG_FOR_TESTING
  }

  const absolutePath = getProjectPathForConfig()
  const config = getGlobalConfig()

  if (!config.projects) {
    return DEFAULT_PROJECT_CONFIG
  }

  const projectConfig = config.projects[absolutePath] ?? DEFAULT_PROJECT_CONFIG
  // Not sure how this became a string
  // TODO: Fix upstream
  if (typeof projectConfig.allowedTools === 'string') {
    projectConfig.allowedTools =
      (safeParseJSON(projectConfig.allowedTools) as string[]) ?? []
  }

  return projectConfig
}

export function saveCurrentProjectConfig(
  updater: (currentConfig: ProjectConfig) => ProjectConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    const config = updater(TEST_PROJECT_CONFIG_FOR_TESTING)
    // Skip if no changes (same reference returned)
    if (config === TEST_PROJECT_CONFIG_FOR_TESTING) {
      return
    }
    Object.assign(TEST_PROJECT_CONFIG_FOR_TESTING, config)
    return
  }
  const absolutePath = getProjectPathForConfig()

  let written: GlobalConfig | null = null
  try {
    const didWrite = saveConfigWithLock(
      getGlobalClaudeFile(),
      createDefaultGlobalConfig,
      current => {
        const currentProjectConfig =
          current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
        const newProjectConfig = updater(currentProjectConfig)
        // Skip if no changes (same reference returned)
        if (newProjectConfig === currentProjectConfig) {
          return current
        }
        written = {
          ...current,
          projects: {
            ...current.projects,
            [absolutePath]: newProjectConfig,
          },
        }
        return written
      },
    )
    if (didWrite && written) {
      writeThroughGlobalConfigCache(written)
    }
  } catch (error) {
    logForDebugging(`Failed to save config with lock: ${error}`, {
      level: 'error',
    })

    // Same race window as saveGlobalConfig's fallback -- refuse to write
    // defaults over good cached config. See GH #3117.
    const config = getConfig(getGlobalClaudeFile(), createDefaultGlobalConfig)
    if (wouldLoseAuthState(config)) {
      logForDebugging(
        'saveCurrentProjectConfig fallback: re-read config is missing auth that cache has; refusing to write. See GH #3117.',
        { level: 'error' },
      )
      logEvent('tengu_config_auth_loss_prevented', {})
      return
    }
    const currentProjectConfig =
      config.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG
    const newProjectConfig = updater(currentProjectConfig)
    // Skip if no changes (same reference returned)
    if (newProjectConfig === currentProjectConfig) {
      return
    }
    written = {
      ...config,
      projects: {
        ...config.projects,
        [absolutePath]: newProjectConfig,
      },
    }
    saveConfig(getGlobalClaudeFile(), written, DEFAULT_GLOBAL_CONFIG)
    writeThroughGlobalConfigCache(written)
  }
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

/**
 * Returns true if plugin autoupdate should be skipped.
 * This checks if the auto-updater is disabled AND the FORCE_AUTOUPDATE_PLUGINS
 * env var is not set to 'true'. The env var allows forcing plugin autoupdate
 * even when the auto-updater is otherwise disabled.
 */
export function shouldSkipPluginAutoupdate(): boolean {
  return (
    isAutoUpdaterDisabled() &&
    !isEnvTruthy(process.env.FORCE_AUTOUPDATE_PLUGINS)
  )
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} set`
    case 'config':
      return 'config'
  }
}

export function getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null {
  if (process.env.NODE_ENV === 'development') {
    return { type: 'development' }
  }
  if (isEnvTruthy(process.env.DISABLE_AUTOUPDATER)) {
    return { type: 'env', envVar: 'DISABLE_AUTOUPDATER' }
  }
  const essentialTrafficEnvVar = getEssentialTrafficOnlyReason()
  if (essentialTrafficEnvVar) {
    return { type: 'env', envVar: essentialTrafficEnvVar }
  }
  const config = getGlobalConfig()
  if (
    config.autoUpdates === false &&
    (config.installMethod !== 'native' ||
      config.autoUpdatesProtectedForNative !== true)
  ) {
    return { type: 'config' }
  }
  return null
}

export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID }))
  return userID
}

export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getClaudeConfigHomeDir(), 'CLAUDE.md')
    case 'Local':
      return join(cwd, 'CLAUDE.local.md')
    case 'Project':
      return join(cwd, 'CLAUDE.md')
    case 'Managed':
      return join(getManagedFilePath(), 'CLAUDE.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // TeamMem is only a valid MemoryType when feature('TEAMMEM') is true
  if (feature('TEAMMEM')) {
    return teamMemPaths!.getTeamMemEntrypoint()
  }
  return '' // unreachable in external builds where TeamMem is not in MemoryType
}

export function getManagedClaudeRulesDir(): string {
  return join(getManagedFilePath(), '.claude', 'rules')
}

export function getUserClaudeRulesDir(): string {
  return join(getClaudeConfigHomeDir(), 'rules')
}

// Exported for testing only
export const _getConfigForTesting = getConfig
export const _wouldLoseAuthStateForTesting = wouldLoseAuthState
export function _setGlobalConfigCacheForTesting(
  config: GlobalConfig | null,
): void {
  globalConfigCache.config = config
  globalConfigCache.mtime = config ? Date.now() : 0
}
