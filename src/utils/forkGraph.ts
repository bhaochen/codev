import { open } from 'fs/promises'
import type { LogOption } from '../types/logs.js'
import { getSessionIdFromLog } from './sessionStorage.js'

export interface ForkNode {
  sessionId: string
  parentId: string | null
  log: LogOption
  children: ForkNode[]
}

const HEAD_READ_BYTES = 64 * 1024

/**
 * Scan each session transcript for its `forkedFrom` entry (written by /fork) to
 * discover parent to child links, then assemble a forest of fork trees.
 *
 * codev models forking as one linear transcript per session linked by a
 * unidirectional `forkedFrom` pointer, so the "session tree" is really a
 * forest of sessions. This rebuilds that structure from the on-disk logs.
 */
export async function buildForkForest(logs: LogOption[]): Promise<ForkNode[]> {
  const nodes = new Map<string, ForkNode>()
  for (const log of logs) {
    const id = getSessionIdFromLog(log)
    if (!id) continue
    nodes.set(id, { sessionId: id, parentId: null, log, children: [] })
  }

  await Promise.all(
    [...nodes.values()].map(async node => {
      node.parentId = await readForkParentId(node.log)
    }),
  )

  const roots: ForkNode[] = []
  for (const node of nodes.values()) {
    if (node.parentId && nodes.has(node.parentId)) {
      nodes.get(node.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const byModified = (a: ForkNode, b: ForkNode) =>
    b.log.modified.getTime() - a.log.modified.getTime()
  roots.sort(byModified)
  for (const node of nodes.values()) node.children.sort(byModified)
  return roots
}

async function readForkParentId(log: LogOption): Promise<string | null> {
  const path = log.fullPath
  if (!path) return null
  try {
    const fd = await open(path, 'r')
    try {
      const buf = Buffer.alloc(HEAD_READ_BYTES)
      const { bytesRead } = await fd.read(buf, 0, buf.length, 0)
      const head = buf.toString('utf8', 0, bytesRead)
      for (const line of head.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as { forkedFrom?: { sessionId?: string } }
          const parentId = entry?.forkedFrom?.sessionId
          if (parentId) return String(parentId)
        } catch {
          // skip non-JSON / partial trailing line
        }
      }
    } finally {
      await fd.close()
    }
  } catch {
    return null
  }
  return null
}
