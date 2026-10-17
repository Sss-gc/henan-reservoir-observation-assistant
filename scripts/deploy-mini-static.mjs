import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const config = 'mini-static/wrangler.jsonc'
function wrangler(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args, '--config', config],
      { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk; process.stdout.write(chunk) })
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk) })
    child.stdin.end(input || '')
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(`Wrangler failed (${code})`)))
  })
}
const manifest = JSON.parse(await fs.readFile(path.join(root, 'mini-static/dist/data/manifest.json'), 'utf8'))
if (manifest.pipeline !== 'miniprogram-static-independent-v1' || Object.keys(manifest.documents).length !== 26) throw new Error('独立数据及26份Word必须完整生成后才能部署')
const published = await wrangler(['deploy'])
if (process.env.CI) process.exit(0) // CI updates the independent static version; no login secrets are required.
const hostname = published.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0]
const serviceBaseUrl = process.env.MINIPROGRAM_SERVICE_URL || hostname
if (!serviceBaseUrl || !/^https:\/\/[a-z0-9.-]+$/i.test(serviceBaseUrl)) throw new Error('请设置MINIPROGRAM_SERVICE_URL为已部署并验证的HTTPS地址')
const health = await fetch(`${serviceBaseUrl}/api/health`, { signal: AbortSignal.timeout(20000) })
const status = await health.json()
if (!health.ok || status.status !== 'ok' || status.access !== 'public') throw new Error('免登录静态服务尚未就绪，未切换小程序配置')
await fs.writeFile(path.join(root, 'miniprogram/config.js'),
  `module.exports = {\n  // Public address only; credentials stay on the server.\n  serviceBaseUrl: ${JSON.stringify(serviceBaseUrl)},\n}\n`)
console.log('已验证免登录独立静态服务，并更新小程序地址。打开即可使用，无需访问口令。')
