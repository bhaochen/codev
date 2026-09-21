import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { scanWiFi } from './LocationTool.js'

let stubDir: string
const originalPath = process.env.PATH

beforeEach(async () => {
  stubDir = await mkdtemp(join(tmpdir(), 'nmcli-stub-'))
  const script = join(stubDir, 'nmcli')
  await writeFile(script, '#!/bin/sh\nprintf "AA-BB-CC-DD-EE-FF:70\\n"\n')
  await chmod(script, 0o755)
  process.env.PATH = `${stubDir}:${originalPath ?? ''}`
})

afterEach(async () => {
  process.env.PATH = originalPath
  await rm(stubDir, { recursive: true, force: true })
})

describe('scanWiFi', () => {
  test('scans access points via nmcli on Node', async () => {
    const aps = await scanWiFi()
    expect(aps).toEqual([
      { macAddress: 'AA-BB-CC-DD-EE-FF', signalStrength: 70 },
    ])
  })
})
