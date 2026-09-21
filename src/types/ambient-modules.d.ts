declare module 'react/compiler-runtime' {
  export function c(size: number): unknown[]
}

declare module '*.md' {
  const content: string
  export default content
}

declare module '@ant/*'
declare module 'image-processor-napi'
declare module 'url-handler-napi'

declare module 'src/cli/up.js' {
  export function up(): Promise<void>
}

declare module 'src/cli/rollback.js' {
  export function rollback(
    target?: string,
    options?: { list?: boolean; dryRun?: boolean; safe?: boolean },
  ): Promise<void>
}
