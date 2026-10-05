const CURSOR_EXCLUDED_ADDITION_TOOLS = new Set([
  'ProjectWorkflow',
  'CodebaseRetrieval',
  'GitHistorySearch',
  'InspectSite',
  'WebBrowser',
  'Browser',
  'ArtifactCanvas',
  'PackageManager',
  'VisualDesignAudit',
])

export function filterProviderToolsForLane<T extends { name: string }>(
  laneName: string,
  tools: T[],
): T[] {
  if (laneName !== 'cursor') return tools
  return tools.filter(tool => !CURSOR_EXCLUDED_ADDITION_TOOLS.has(tool.name))
}

export function filterSharedToolsForLane<
  T extends { implId: string; anthropicDef?: { name?: string } },
>(laneName: string, tools: T[]): T[] {
  if (laneName !== 'cursor') return tools
  return tools.filter(tool => {
    const visibleName = tool.anthropicDef?.name ?? tool.implId
    return (
      !CURSOR_EXCLUDED_ADDITION_TOOLS.has(tool.implId) &&
      !CURSOR_EXCLUDED_ADDITION_TOOLS.has(visibleName)
    )
  })
}
