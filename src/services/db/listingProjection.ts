/**
 * Listing metadata projection — the DB-side equivalent of what
 * `readLiteMetadata` scrapes from JSONL head+tail windows.
 *
 * The /resume picker and session lists need: lastPrompt, customTitle/aiTitle,
 * tag, agentSetting, summary, gitBranch, projectPath (cwd), teamName,
 * isSidechain, pr-link fields. File reads recover these with head/tail scans;
 * this module projects them from ordered entries so session rows can serve
 * the same data without touching the file.
 *
 * Semantics mirror readLiteMetadata's "last occurrence wins" (the file scans
 * the TAIL last), with two deliberate deviations matching the file logic:
 *   - customTitle and aiTitle are tracked separately; readers apply
 *     `customTitle ?? aiTitle` because the file prefers ANY customTitle over
 *     any aiTitle regardless of position.
 *   - cwd / teamName / isSidechain are FIRST-wins (the file reads them from
 *     the head window).
 */
import type { Entry } from '../../types/logs.js'

export type ListingMeta = {
  /** Last 'last-prompt' entry's lastPrompt. */
  lastPrompt?: string
  /** Last custom-title entry's title (user titles win over AI titles). */
  customTitle?: string
  /** Last ai-title entry's title. */
  aiTitle?: string
  tag?: string
  agentSetting?: string
  /** Last 'summary' entry's summary text. */
  summary?: string
  /** Last transcript message's gitBranch. */
  gitBranch?: string
  /** First transcript message's cwd. */
  projectPath?: string
  /** First transcript message's teamName (presence filters team sessions). */
  teamName?: string
  /** First transcript message's isSidechain (head-window semantics). */
  isSidechain?: boolean
  agentName?: string
  agentColor?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
}

/** Keys where the FIRST defined value wins (head-window semantics). */
const FIRST_WINS_KEYS = new Set<keyof ListingMeta>([
  'projectPath',
  'teamName',
  'isSidechain',
])

type AnyEntry = Record<string, unknown>

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/**
 * Extract listing metadata from an ordered entry list.
 * Last-wins per field (with FIRST_WINS_KEYS exceptions); the file's tail scan
 * necessarily sees the LAST occurrence last, so this matches it.
 */
export function extractListingMeta(entries: readonly Entry[]): ListingMeta {
  const meta: ListingMeta = {}
  const setLast = <K extends keyof ListingMeta>(
    key: K,
    value: ListingMeta[K] | undefined,
  ): void => {
    if (value === undefined) return
    if (FIRST_WINS_KEYS.has(key) && meta[key] !== undefined) return
    meta[key] = value
  }

  for (const entry of entries) {
    const e = entry as AnyEntry
    switch (e.type) {
      case 'last-prompt':
        setLast('lastPrompt', str(e.lastPrompt))
        break
      case 'custom-title':
        setLast('customTitle', str(e.customTitle))
        break
      case 'ai-title':
        setLast('aiTitle', str(e.aiTitle))
        break
      case 'tag':
        setLast('tag', str(e.tag))
        break
      case 'agent-setting':
        setLast('agentSetting', str(e.agentSetting))
        break
      case 'agent-name':
        setLast('agentName', str(e.agentName))
        break
      case 'agent-color':
        setLast('agentColor', str(e.agentColor))
        break
      case 'summary':
        setLast('summary', str(e.summary))
        break
      case 'pr-link':
        setLast('prUrl', str(e.prUrl))
        setLast('prRepository', str(e.prRepository))
        if (typeof e.prNumber === 'number') setLast('prNumber', e.prNumber)
        break
      case 'user':
      case 'assistant':
      case 'system':
        setLast('gitBranch', str(e.gitBranch))
        setLast('projectPath', str(e.cwd))
        setLast('teamName', str(e.teamName))
        if (typeof e.isSidechain === 'boolean') {
          setLast('isSidechain', e.isSidechain)
        }
        break
      default:
        break
    }
  }

  return meta
}

/**
 * Merge a newer batch's listing metadata into an existing metadata object.
 * Defined patch values overwrite; FIRST_WINS_KEYS only fill when absent —
 * together these replicate "last occurrence wins" across flush batches.
 */
export function mergeListingMeta(
  existing: ListingMeta,
  patch: ListingMeta,
): ListingMeta {
  const merged: ListingMeta = { ...existing }
  for (const key of Object.keys(patch) as Array<keyof ListingMeta>) {
    const value = patch[key]
    if (value === undefined) continue
    if (FIRST_WINS_KEYS.has(key) && existing[key] !== undefined) continue
    ;(merged as Record<string, unknown>)[key] = value
  }
  return merged
}
