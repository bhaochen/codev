#!/usr/bin/env bun
// Development entry point with runtime MACRO definitions

// Define MACRO at runtime for development BEFORE any imports
globalThis.MACRO = {
  VERSION: '2.1.87-dev',
  BUILD_TIME: new Date().toISOString(),
  PACKAGE_URL: 'claude-code-source-snapshot',
  NATIVE_PACKAGE_URL: undefined,
  FEEDBACK_CHANNEL: 'github',
  ISSUES_EXPLAINER: 'Development build',
  VERSION_CHANGELOG: 'Local development build'
}

// Now import CLI which will use the MACRO we just defined
const { main } = await import('./cli.tsx')
await main()
