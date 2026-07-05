/**
 * Dev runner: invokes bun run ./src/entrypoints/cli.tsx with all experimental
 * feature flags and build-time defines enabled.
 *
 * Keeps the feature list in scripts/features.ts — one place to update.
 */
import { spawnSync } from 'bun'
import { FULL_EXPERIMENTAL_FEATURES } from './features.ts'

const version = '0.0.0-dev'
const buildTime = new Date().toISOString()

const featureArgs = FULL_EXPERIMENTAL_FEATURES.flatMap(f => ['--feature', f])

const defineArgs = [
  '--define', `MACRO.VERSION:${JSON.stringify(version)}`,
  '--define', `MACRO.BUILD_TIME:${JSON.stringify(buildTime)}`,
  '--define', `MACRO.PACKAGE_URL:${JSON.stringify('codev-dev')}`,
  '--define', `MACRO.NATIVE_PACKAGE_URL:undefined`,
  '--define', `MACRO.FEEDBACK_CHANNEL:${JSON.stringify('github')}`,
  '--define', `MACRO.ISSUES_EXPLAINER:${JSON.stringify('')}`,
  '--define', `MACRO.VERSION_CHANGELOG:${JSON.stringify('')}`,
  '--define', `process.env.USER_TYPE:${JSON.stringify('external')}`,
  '--define', `process.env.CLAUDE_CODE_FORCE_FULL_LOGO:${JSON.stringify('true')}`,
  '--define', `process.env.NODE_ENV:${JSON.stringify('development')}`,
  '--define', `process.env.CLAUDE_CODE_VERIFY_PLAN:${JSON.stringify('false')}`,
  '--define', `process.env.CCR_FORCE_BUNDLE:${JSON.stringify('true')}`,
]

const proc = spawnSync({
  cmd: ['bun', 'run', ...featureArgs, ...defineArgs, './src/entrypoints/cli.tsx', ...process.argv.slice(2)],
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
})

process.exit(proc.exitCode ?? 1)
