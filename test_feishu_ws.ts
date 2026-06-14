import * as Lark from '@larksuiteoapi/node-sdk'

const appId = 'cli_aaa6659174b85bec'
const appSecret = 'nMV7WvGm9Pbvtf0PA3RVLbqNujzeqP7I'

const client = new Lark.Client({
  appId,
  appSecret,
  appType: Lark.AppType.SelfBuild,
  domain: Lark.Domain.Feishu,
})

// Test bot info
try {
  const info = await client.request({
    method: 'GET',
    url: '/open-apis/bot/v3/info',
  })
  console.log('Bot info:', JSON.stringify(info, null, 2))
} catch (e) {
  console.error('Bot info failed:', e)
}

// Test WSClient
const dispatcher = new Lark.EventDispatcher({})

dispatcher.register({
  'im.message.receive_v1': async (data: any) => {
    console.log('Received message:', JSON.stringify(data, null, 2))
  },
} as any)

const ws = new Lark.WSClient({
  appId,
  appSecret,
  domain: Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.debug,
})

await ws.start({ eventDispatcher: dispatcher })
console.log('[WS] started, waiting 10s...')
await new Promise(r => setTimeout(r, 10000))
console.log('[WS] done')
ws.stop?.()