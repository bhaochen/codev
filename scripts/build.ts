import { chmodSync, cpSync, existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
  name: string
  version: string
}

import { FULL_EXPERIMENTAL_FEATURES } from './features.ts'

const args = process.argv.slice(2)

function runCommand(cmd: string[]): string | null {
  const proc = Bun.spawnSync({
    cmd,
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) return null
  return new TextDecoder().decode(proc.stdout).trim() || null
}

function getDevVersion(baseVersion: string): string {
  const timestamp = new Date().toISOString()
  const date = timestamp.slice(0, 10).replaceAll('-', '')
  const time = timestamp.slice(11, 19).replaceAll(':', '')
  const sha = runCommand(['git', 'rev-parse', '--short=8', 'HEAD']) ?? 'unknown'
  return `${baseVersion}-dev.${date}.t${time}.sha${sha}`
}

function getVersionChangelog(): string {
  return (
    runCommand(['git', 'log', '--format=%h %s', '-20']) ??
    'Local development build'
  )
}

// Collect feature flags (always all + any extras from args)
const featureSet = new Set<string>(FULL_EXPERIMENTAL_FEATURES)
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--feature' && args[i + 1]) {
    featureSet.add(args[i + 1]!)
    i += 1
  } else if (arg.startsWith('--feature=')) {
    featureSet.add(arg.slice('--feature='.length))
  }
}
const features = [...featureSet]

const outfile = join('dist', 'codev')

// ── Pre-step: build Friend VRM frontend ──────────────────────────────────
function buildFriendFrontend(): boolean {
  const frontendDir = join(process.cwd(), 'src', 'components', 'friend', 'frontend')
  const distIndex = join(frontendDir, 'dist', 'index.html')
  if (existsSync(distIndex)) {
    console.log('Friend frontend already built, skipping.')
    return true
  }
  console.log('Building Friend VRM frontend...')
  const proc = Bun.spawnSync({
    cmd: ['npm', 'run', 'build'],
    cwd: frontendDir,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (proc.exitCode !== 0) {
    console.error('Friend frontend build failed.')
    return false
  }
  console.log('Friend frontend built.')
  return true
}

if (!buildFriendFrontend()) {
  process.exit(1)
}

// ──────────────────────────────────────────────────────────────────────────

const buildTime = new Date().toISOString()
const version = getDevVersion(pkg.version)

mkdirSync(dirname(outfile), { recursive: true })

const externals = [
  '@ant/*',
  'audio-capture-napi',
  'image-processor-napi',
  'modifiers-napi',
  'url-handler-napi',
]

const defines = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  'process.env.NODE_ENV': JSON.stringify('development'),
  'process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD': JSON.stringify('true'),
  'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('false'),
  'process.env.CCR_FORCE_BUNDLE': JSON.stringify('true'),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'This reconstructed source snapshot does not include Anthropic internal issue routing.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(getVersionChangelog()),
} as const

const cmd = [
  'bun',
  'build',
  './src/entrypoints/cli.tsx',
  '--compile',
  '--target',
  'bun',
  '--format',
  'esm',
  '--outfile',
  outfile,
  '--minify',
  '--bytecode',
  '--packages',
  'bundle',
  '--conditions',
  'bun',
]

for (const external of externals) {
  cmd.push('--external', external)
}
for (const feature of features) {
  cmd.push(`--feature=${feature}`)
}
for (const [key, value] of Object.entries(defines)) {
  cmd.push('--define', `${key}=${value}`)
}

const proc = Bun.spawnSync({
  cmd,
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})

if (proc.exitCode !== 0) {
  process.exit(proc.exitCode ?? 1)
}

if (existsSync(outfile)) {
  chmodSync(outfile, 0o755)
}

// Copy vendor/ to dist/vendor/ for runtime audio-capture resolution
const distDir = dirname(outfile)
const vendorDir = join(distDir, 'vendor')
if (!existsSync(vendorDir)) {
  cpSync('vendor', vendorDir, { recursive: true })
  console.log(`Copied vendor/ → ${vendorDir}/`)
}

console.log(`Built ${outfile}`)
