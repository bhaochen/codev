// Type surface + local stubs for the ant-internal `@ant/computer-use-mcp`
// package. The real package is externalized at build time (scripts/build.ts
// externals) and loaded lazily at runtime under feature('CHICAGO_MCP') — it is
// never bundled in the CLI. This file only gives tsc a resolvable, well-typed
// face: the shared session/permission types re-export the hand-written shapes
// in ./types.js, while the runtime-foreign native/executor shapes use the
// `any`-typed stub convention (mirrored by ./executor.js).
export type {
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
  CoordinateMode,
  CuPermissionRequest,
  CuPermissionResponse,
  ScreenshotDims,
} from './types.js'
export { DEFAULT_GRANT_FLAGS } from './types.js'
export type { ComputerExecutor, InstalledApp, ScreenshotResult } from './executor.js'

import type {
  ComputerUseHostAdapter,
  ComputerUseSessionContext,
  CoordinateMode,
} from './types.js'

export type CuCallToolResult = unknown
/** `targetImageSize` bounds — the real package clamps to a max edge. */
export type ResizeParams = { maxEdge?: number; [k: string]: unknown }
export type DisplayGeometry = any
export type FrontmostApp = any
export type ResolvePrepareCaptureResult = any
export type RunningApp = any

// Value stubs — dead code path (feature-gated, externalized at build).
const __target = function noop() {}
const __handler: ProxyHandler<any> = {
  get(_t, prop) {
    if (prop === '__esModule') return true
    if (prop === Symbol.toPrimitive) return () => undefined
    if (prop === Symbol.iterator) return function* () {}
    if (prop === Symbol.asyncIterator) return async function* () {}
    if (prop === 'then') return undefined
    return new Proxy(__target, __handler)
  },
  apply() {
    return new Proxy(__target, __handler)
  },
  construct() {
    return new Proxy(__target, __handler)
  },
}
const stub: any = new Proxy(__target, __handler)

export const bindSessionContext: (
  host: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
  ctx: ComputerUseSessionContext,
) => { dispatch: (name: string, args: unknown) => Promise<CuCallToolResult> } = stub
export const buildComputerUseTools: (
  capabilities: unknown,
  coordinateMode: CoordinateMode,
) => readonly { name: string }[] = stub
export type ComputerUseMcpServerLike = {
  setRequestHandler(
    schema: unknown,
    handler: (request: unknown) => unknown,
  ): void
  connect(transport: unknown): Promise<void>
}
export const createComputerUseMcpServer: (
  adapter: ComputerUseHostAdapter,
  coordinateMode: CoordinateMode,
) => ComputerUseMcpServerLike = stub
export const API_RESIZE_PARAMS: ResizeParams = stub
export const targetImageSize: (
  physW: number,
  physH: number,
  params: ResizeParams,
) => [number, number] = stub