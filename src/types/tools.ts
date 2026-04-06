export interface WebSearchProgress {
  type: 'query_update' | 'search_results_received'
  query?: string
  resultCount?: number
}

export interface BashProgress {
  type: 'bash_progress'
  output: string
  fullOutput: string
  elapsedTimeSeconds?: number
  totalLines?: number
}

export interface MCPProgress {
  type: string
  [key: string]: unknown
}

export interface REPLToolProgress {
  type: string
  [key: string]: unknown
}

export interface SkillToolProgress {
  type: string
  [key: string]: unknown
}

export interface TaskOutputProgress {
  type: string
  [key: string]: unknown
}

export type ToolProgressData = 
  | WebSearchProgress
  | BashProgress
  | MCPProgress
  | REPLToolProgress
  | SkillToolProgress
  | TaskOutputProgress