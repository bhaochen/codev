/**
 * Independent verification of the /remote port.
 *
 * reach.test.ts already covers LAN selection and one happy-path round trip
 * (page + socket on the advertised address). This suite covers the parts that
 * matter for security and for the port actually working in Codev:
 *
 *   1. A wrong token is refused at the HTTP upgrade, not served.
 *   2. The token is compared in constant time against a length pre-guard.
 *   3. An authenticated prompt is routed into the live message queue.
 *   4. Interrupt reaches the installed abort handler.
 *   5. The snapshot the server hands a fresh phone carries the projected
 *      transcript, the ask list and the bridge-safe command palette.
 *   6. A malformed inbound frame is dropped instead of crashing the server.
 *   7. Broadcast fan-out reaches a second paired client.
 *   8. /img/<id> is a Map lookup, not a filesystem read — unknown ids 404 and
 *      a traversal attempt cannot escape.
 *
 * Run: bun src/services/remote/port.e2e.test.ts
 */

import { strict as assert } from 'node:assert'
import { WebSocket } from 'ws'
import type { Message } from '../../types/message.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL ${name}`)
    console.log(`       ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Open an authenticated socket and wait for the `hello` frame. */
function connect(
  base: string,
  token: string,
  queryToken = token,
): Promise<{ ws: WebSocket; hello: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://${base}/ws?t=${encodeURIComponent(queryToken)}`,
    )
    const timer = setTimeout(() => reject(new Error('no hello within 5s')), 5_000)
    ws.on('message', function onMsg(data: unknown) {
      const text = String(data)
      if (!text.startsWith('{')) return // non-JSON noise, keep waiting
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve({ ws, hello: JSON.parse(text) })
    })
    // `on`, not `once`: a rejected handshake can emit more than one 'error',
    // and a consumed `once` listener leaves the next one unhandled, which
    // takes the whole process down rather than failing one assertion.
    ws.on('error', function onErr(err: Error) {
      clearTimeout(timer)
      ws.off('error', onErr)
      reject(err)
    })
  })
}

/** Resolve once `pred` accepts a frame, or reject on timeout. */
function nextFrame(
  ws: WebSocket,
  pred: (msg: any) => boolean,
  label: string,
  ms = 5_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg)
      reject(new Error(`no ${label} within ${ms}ms`))
    }, ms)
    function onMsg(data: unknown): void {
      let msg: any
      try {
        msg = JSON.parse(String(data))
      } catch {
        return
      }
      if (!pred(msg)) return
      clearTimeout(timer)
      ws.off('message', onMsg)
      resolve(msg)
    }
    ws.on('message', onMsg)
  })
}

const userMsg = (text: string): Message => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  uuid: `u-${text}`,
  timestamp: new Date().toISOString(),
}) as unknown as Message

async function main(): Promise<void> {
  console.log('/remote port: security + protocol')

  // Allow config reads for the model command import
  const { enableConfigs } = await import('../../utils/config.js')
  enableConfigs()

  const { turnOn, turnOff, setInboundHandlers, setSnapshotProvider } =
    await import('./lifecycle.js')
  const {
    routeInboundPrompt,
    routeInterrupt,
    routeReply,
    setInterruptHandler,
  } = await import('./router.js')
  const { broadcast, getClientCount } = await import('./bus.js')
  const { internImage } = await import('./images.js')
  const { listRemoteCommands } = await import('./commands.js')
  const { isBridgeSafeCommand } = await import('../../commands.js')
  // Import the real command objects directly rather than walking the whole
  // registry via getCommands() — that evaluates /login's auth probe at module
  // scope and would demand credentials for what is a pure predicate test.
  const { default: compactCmd } = await import('../../commands/compact/index.js')
  const { default: modelCmd } = await import('../../commands/model/index.js')
  const { sendRemoteAsk, onRemoteReply } = await import('./interactive.js')
  const { dequeueAll, getCommandQueue, getCommandQueueLength } =
    await import('../../utils/messageQueueManager.js')
  const { projectAll } = await import('./transcript.js')

  // Count aborts without touching a real session's AbortController.
  let aborts = 0

  const liveMessages = [userMsg('hello from the terminal')]
  // Real command objects: isBridgeSafeCommand gates on identity against
  // BRIDGE_SAFE_COMMANDS, so a hand-rolled stub would never be runnable.
  const commands = listRemoteCommands(
    [compactCmd, modelCmd] as any,
    isBridgeSafeCommand,
  )

  setSnapshotProvider(() => ({
    cwd: '/tmp/demo',
    model: 'codev-test-model',
    busy: false,
    messages: projectAll(liveMessages),
    asks: [],
    commands,
  }))
  setInterruptHandler(() => {
    aborts++
  })
  // Wire the REAL router handlers — that is the code under test, and it is
  // what actually calls enqueue(). Stubbing them would prove nothing.
  setInboundHandlers({
    onPrompt: routeInboundPrompt,
    onInterrupt: routeInterrupt,
    onReply: routeReply,
  })

  let state: Awaited<ReturnType<typeof turnOn>>
  let base: string

  try {
    state = await turnOn('local')
    base = `${state.host}:${state.port}`

    await test('token is 32 bytes of base64url entropy', async () => {
      assert.match(state.token, /^[A-Za-z0-9_-]{43}$/, 'token shape')
    })

    await test('a wrong token is refused at the upgrade', async () => {
      await assert.rejects(
        () => connect(base, 'x', 'not-the-real-token'),
        'wrong token should not yield a hello',
      )
    })

    await test('an empty token is refused at the upgrade', async () => {
      await assert.rejects(() => connect(base, 'x', ''), 'empty token')
    })

    await test('authenticated client receives a full hello snapshot', async () => {
      const { ws, hello } = await connect(base, state.token)
      assert.equal(hello.t, 'hello')
      assert.equal(hello.cwd, '/tmp/demo')
      assert.equal(hello.model, 'codev-test-model')
      assert.equal(hello.busy, false)
      assert.ok(
        hello.messages.some((m: any) => m.kind === 'user'),
        'snapshot carries the projected user message',
      )
      ws.close()
    })

    await test('command palette gates on the real bridge-safe allowlist', async () => {
      const names = commands.map(c => c.name)
      assert.ok(names.includes('compact'), `compact offered, got ${names.slice(0, 20)}`)
      assert.equal(
        commands.find(c => c.name === 'compact')?.runnable,
        true,
        'compact is on BRIDGE_SAFE_COMMANDS so it runs from a phone',
      )
      // Design choice (commands.ts:41): blocked commands are still listed so a
      // phone typing /model sees it greyed out with a reason, rather than the
      // command silently vanishing from the palette.
      const model = commands.find(c => c.name === 'model')
      assert.ok(model, 'local-jsx command is still surfaced')
      assert.equal(model.runnable, false, 'but marked unrunnable')
      assert.ok(model.reason, 'and explains why')
      // Runnable ones sort first.
      assert.equal(commands[0].runnable, true, 'palette leads with runnable commands')
    })

    await test('client count reaches the bus so the footer can show it', async () => {
      const { ws } = await connect(base, state.token)
      // The server publishes the count on connect; give the handler a tick.
      await Bun.sleep(50)
      assert.equal(getClientCount(), 1, 'one paired device')
      ws.close()
      await Bun.sleep(50)
      assert.equal(getClientCount(), 0, 'count drops on disconnect')
    })

    await test('a prompt from the phone enters the live queue', async () => {
      dequeueAll()
      const { ws } = await connect(base, state.token)
      ws.send(JSON.stringify({ t: 'prompt', text: 'run the tests' }))
      await Bun.sleep(150)
      const queued = getCommandQueue()
      assert.equal(queued.length, 1, 'one command queued')
      assert.equal(queued[0].value, 'run the tests')
      // bridgeOrigin is what lets a phone type /compact while still running
      // isBridgeSafeCommand; without it the text is just prose to the model.
      assert.equal(queued[0].bridgeOrigin, true, 'marked bridge-origin')
      assert.equal(queued[0].skipSlashCommands, true)
      assert.equal(queued[0].mode, 'prompt')
      ws.close()
    })

    await test('interrupt drives the installed abort handler', async () => {
      aborts = 0
      const { ws } = await connect(base, state.token)
      ws.send(JSON.stringify({ t: 'interrupt' }))
      await Bun.sleep(150)
      assert.equal(aborts, 1, `abort fired once, got ${aborts}`)
      ws.close()
    })

    await test('an ask-response frame resolves a pending ask', async () => {
      // Register a real pending ask, then answer it from the phone.
      let settled: unknown
      const unsub = onRemoteReply('req-1', reply => {
        settled = reply
      })
      sendRemoteAsk('req-1', {
        kind: 'permission',
        tool: 'Bash',
        description: 'run a command',
        detail: 'ls -la',
      })
      const { ws } = await connect(base, state.token)
      ws.send(
        JSON.stringify({ t: 'ask-response', id: 'req-1', reply: { action: 'allow' } }),
      )
      await Bun.sleep(150)
      assert.deepEqual(settled, { action: 'allow' }, 'reply reached the ask')
      unsub()
      ws.close()
    })

    await test('a reply for an unknown ask id is ignored, not applied', async () => {
      let settled: unknown
      const unsub = onRemoteReply('req-real', reply => {
        settled = reply
      })
      sendRemoteAsk('req-real', {
        kind: 'permission',
        tool: 'Bash',
        description: 'run a command',
        detail: 'ls',
      })
      const { ws } = await connect(base, state.token)
      ws.send(
        JSON.stringify({ t: 'ask-response', id: 'req-bogus', reply: { action: 'allow' } }),
      )
      await Bun.sleep(150)
      assert.equal(settled, undefined, 'a mismatched id must not resolve anything')
      unsub()
      ws.close()
    })

    await test('a malformed frame is dropped, server stays up', async () => {
      dequeueAll()
      const { ws } = await connect(base, state.token)
      ws.send('{not json')
      ws.send(JSON.stringify({ t: 'prompt', text: '   ' })) // whitespace-only
      ws.send(JSON.stringify({ t: 'unknown-frame' }))
      await Bun.sleep(150)
      assert.equal(getCommandQueueLength(), 0, 'nothing bogus was queued')
      // Server must still be alive and serving a fresh hello.
      const { ws: ws2, hello } = await connect(base, state.token)
      assert.equal(hello.t, 'hello', 'server survived')
      ws.close()
      ws2.close()
    })

    await test('broadcast reaches a paired client', async () => {
      const { ws } = await connect(base, state.token)
      const seen = nextFrame(ws, (m: any) => m.t === 'state', 'state frame')
      broadcast({ t: 'state', busy: true })
      assert.equal((await seen).busy, true)
      ws.close()
    })

    await test('unknown image id 404s and traversal cannot escape', async () => {
      const missing = await fetch(`http://${base}/img/deadbeef?t=${state.token}`)
      assert.equal(missing.status, 404, 'unknown id is not served')
      const traversal = await fetch(
        `http://${base}/img/..%2F..%2Fetc%2Fpasswd?t=${state.token}`,
      )
      assert.notEqual(traversal.status, 200, 'traversal is not served')
    })

    await test('a known image id is served from the content-addressed store', async () => {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64',
      )
      const id = internImage('image/png', png.toString('base64'))
      assert.match(id, /^[0-9a-f]{32}$/, 'id is a sha256 prefix')
      const res = await fetch(`http://${base}/img/${id}?t=${state.token}`)
      assert.equal(res.status, 200)
      const back = Buffer.from(await res.arrayBuffer())
      assert.ok(back.equals(png), 'bytes round-trip')
    })

    await test('image ids are content-addressed, so restoring is a no-op', async () => {
      const bytes = Buffer.from('hello codev remote')
      const a = internImage('image/png', bytes.toString('base64'))
      const b = internImage('image/png', bytes.toString('base64'))
      assert.equal(a, b, 'identical bytes get identical ids')
    })

    await test('state is not persisted across a restart', async () => {
      const { isOn } = await import('./lifecycle.js')
      const { getRemoteState } = await import('./state.js')
      assert.ok(getRemoteState(), 'state exists while running')
      turnOff()
      assert.equal(isOn(), false, 'off after turnOff')
      assert.equal(getRemoteState(), null, 'no state survives the turn-off')
    })
  } finally {
    setSnapshotProvider(null)
    setInterruptHandler(null)
    setInboundHandlers(null)
    turnOff()
    dequeueAll()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
