// Type surface for the ant-internal `@ant/computer-use-input` package (enigo
// native). Externalized at build time; loaded lazily under feature('CHICAGO_MCP')
// via `requireComputerUseInput` — typing only. The runtime export is a
// discriminated union narrowed once in inputLoader.ts to the bare API.
export type ComputerUseInputAPI = any
export type ComputerUseInput =
  | ({ isSupported: true } & ComputerUseInputAPI)
  | { isSupported: false }