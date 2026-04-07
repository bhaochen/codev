#!/usr/bin/env bun
import { initTLS, Session, ClientIdentifier, destroyTLS } from 'node-tls-client'

console.log('Testing POST request with node-tls-client...')

try {
  await initTLS()
  console.log('✓ TLS initialized')
  
  const session = new Session({
    clientIdentifier: ClientIdentifier.chrome_131,
    timeout: 30000,
  })
  console.log('✓ Session created')
  
  const response = await session.post('https://html.duckduckgo.com/html/', {
    body: 'q=test&b=&l=us-en',
  })
  
  console.log(`✓ Request completed: ${response.status}`)
  
  const html = await response.text()
  console.log(`✓ Received ${html.length} bytes`)
  
  if (html.length > 10000) {
    console.log('\n✅ POST request works!')
  } else {
    console.log('\n⚠️  Response too short')
  }
  
  await session.close()
  await destroyTLS()
  console.log('\n✓ Cleanup completed')
} catch (error) {
  console.error('❌ Test failed:', error)
  process.exit(1)
}
