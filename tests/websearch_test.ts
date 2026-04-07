#!/usr/bin/env bun
/**
 * WebSearch 集成测试
 * 测试打包后的 CLI 中的 WebSearch 功能
 */

import { spawn } from 'child_process'

console.log('='.repeat(60))
console.log('WebSearch Integration Test')
console.log('='.repeat(60))

async function testWebSearch() {
  return new Promise((resolve, reject) => {
    const child = spawn('./cli-dev', [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    })

    let stdout = ''
    let stderr = ''

    // 发送搜索命令
    setTimeout(() => {
      child.stdin.write('WebSearch("milet 最新动态 2026")\n')
      setTimeout(() => {
        child.stdin.end()
      }, 2000)
    }, 1000)

    child.stdout.on('data', (data) => {
      stdout += data.toString()
      console.log('[STDOUT]', data.toString().trim())
    })

    child.stderr.on('data', (data) => {
      stderr += data.toString()
      console.error('[STDERR]', data.toString().trim())
    })

    child.on('close', (code) => {
      console.log('\n' + '='.repeat(60))
      console.log(`Process exited with code ${code}`)
      console.log(`Stdout length: ${stdout.length}`)
      console.log(`Stderr length: ${stderr.length}`)
      
      // 检查是否有关键词
      const hasResults = stdout.includes('Links:') || stdout.includes('http')
      const hasError = stdout.includes('Error') || stdout.includes('error')
      
      if (hasResults) {
        console.log('\n✅ WebSearch 返回了结果!')
      } else if (hasError) {
        console.log('\n❌ WebSearch 返回了错误')
        reject(new Error('WebSearch returned error'))
      } else {
        console.log('\n⚠️  WebSearch 没有返回结果或错误')
        reject(new Error('No results or error returned'))
      }
      
      resolve(code)
    })

    // 超时处理
    setTimeout(() => {
      child.kill('SIGTERM')
      console.log('\n⚠️  Timeout - killed process')
      reject(new Error('Test timeout'))
    }, 60000)
  })
}

async function main() {
  try {
    await testWebSearch()
    console.log('\n✅ Test completed!')
  } catch (error) {
    console.error('\n❌ Test failed:', error)
    process.exit(1)
  }
}

main()
