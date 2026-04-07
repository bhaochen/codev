#!/usr/bin/env bun
/**
 * WebSearch 诊断测试
 * 检查各个组件是否正常工作
 */

console.log('='.repeat(60))
console.log('WebSearch Diagnostic Test')
console.log('='.repeat(60))

async function test1_ImportModule() {
  console.log('\n1. 测试导入 node-tls-client...')
  try {
    const module = await import('node-tls-client')
    console.log('✓ 模块导入成功')
    console.log('  可用函数:', Object.keys(module))
    return module
  } catch (error) {
    console.error('✗ 模块导入失败:', error)
    throw error
  }
}

async function test2_InitTLS(module) {
  console.log('\n2. 测试初始化 TLS...')
  try {
    await module.initTLS()
    console.log('✓ TLS 初始化成功')
  } catch (error) {
    console.error('✗ TLS 初始化失败:', error)
    throw error
  }
}

async function test3_CreateSession(module) {
  console.log('\n3. 测试创建 Session...')
  try {
    const session = new module.Session({
      clientIdentifier: module.ClientIdentifier.chrome_131,
      timeout: 10000,
    })
    console.log('✓ Session 创建成功')
    await session.close()
    console.log('✓ Session 关闭成功')
  } catch (error) {
    console.error('✗ Session 创建失败:', error)
    throw error
  }
}

async function test4_MakeRequest(module) {
  console.log('\n4. 测试发送请求...')
  try {
    const session = new module.Session({
      clientIdentifier: module.ClientIdentifier.chrome_131,
      timeout: 10000,
    })
    
    const response = await session.get('https://html.duckduckgo.com/html/?q=test', {
      followRedirects: true,
    })
    
    console.log(`✓ 请求成功: ${response.status}`)
    
    const html = await response.text()
    console.log(`✓ 响应长度: ${html.length} bytes`)
    
    if (html.length > 10000) {
      console.log('✓ 响应长度正常')
    } else {
      console.warn('⚠️  响应长度异常 (可能被阻塞)')
    }
    
    await session.close()
  } catch (error) {
    console.error('✗ 请求失败:', error)
    throw error
  }
}

async function main() {
  let module = null
  
  try {
    module = await test1_ImportModule()
    await test2_InitTLS(module)
    await test3_CreateSession(module)
    await test4_MakeRequest(module)
    
    // 清理
    console.log('\n5. 清理 TLS...')
    await module.destroyTLS()
    console.log('✓ TLS 清理成功')
    
    console.log('\n' + '='.repeat(60))
    console.log('✅ 所有测试通过!')
    console.log('='.repeat(60))
  } catch (error) {
    console.log('\n' + '='.repeat(60))
    console.log('❌ 测试失败')
    console.log('='.repeat(60))
    process.exit(1)
  }
}

main()
