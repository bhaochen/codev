#!/usr/bin/env bun
/**
 * Test WebSearch output format
 */

async function testWebSearchOutput() {
  const { spawn } = await import('child_process')
  
  const query = 'milet 2026'
  const pythonScript = process.cwd() + '/scripts/python_webtools.py'
  
  const result = await new Promise<any>((resolve, reject) => {
    const child = spawn('.venv/bin/python', [pythonScript, 'web_search', query, '3'], {
      cwd: process.cwd(),
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (data) => {
      stdout += data.toString()
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python failed: ${stderr}`))
        return
      }

      try {
        const data = JSON.parse(stdout)
        resolve(data)
      } catch (error) {
        reject(error)
      }
    })

    child.on('error', reject)
  })

  console.log('Python result:')
  console.log(JSON.stringify(result, null, 2))

  // Simulate TypeScript processing
  const cleanedResults = result.results.map((r: any) => ({
    title: r.title,
    url: r.url,
    snippet: r.content || undefined,
  }))

  console.log('\n\nCleaned results:')
  console.log(JSON.stringify(cleanedResults, null, 2))

  // Simulate output format
  const searchResults = []
  if (cleanedResults.length === 0) {
    searchResults.push(`No results for: ${query}`)
  } else {
    searchResults.push({
      tool_use_id: 'search-1',
      content: cleanedResults.map((r: any) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      }))
    })
  }

  // Format for AI - improved format
  let formattedOutput = `Web search results for query: "${query}"\n\n`
  
  searchResults.forEach(result => {
    if (typeof result === 'string') {
      formattedOutput += result + '\n\n'
    } else {
      if (result.content?.length > 0) {
        result.content.forEach((item: any, index: number) => {
          formattedOutput += `${index + 1}. **${item.title || 'Untitled'}**\n`
          formattedOutput += `   URL: ${item.url}\n`
          if (item.snippet) {
            formattedOutput += `   ${item.snippet}\n`
          }
          formattedOutput += '\n'
        })
      } else {
        formattedOutput += 'No links found.\n\n'
      }
    }
  })

  formattedOutput += '\nREMINDER: You MUST include the sources above in your response to the user using markdown hyperlinks.'

  console.log('\n\nFormatted output for AI:')
  console.log(formattedOutput)
}

testWebSearchOutput().catch(console.error)
