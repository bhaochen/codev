#!/usr/bin/env bun
console.log('Testing standard fetch...')

try {
  const response = await fetch('https://html.duckduckgo.com/html/?q=test&b=&l=us-en', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Connection': 'keep-alive',
    },
  })
  
  console.log(`✓ Response status: ${response.status}`)
  
  const html = await response.text()
  console.log(`✓ Response length: ${html.length} bytes`)
  
  if (html.length > 10000) {
    console.log('\n✅ Standard fetch works!')
  } else {
    console.log('\n⚠️  Response too short')
  }
} catch (error) {
  console.error('❌ Test failed:', error)
  process.exit(1)
}
