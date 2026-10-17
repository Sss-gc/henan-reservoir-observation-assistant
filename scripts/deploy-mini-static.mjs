import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

const root = fileURLToPath(new URL('../', import.meta.url))
const config = 'mini-static/wrangler.jsonc'
const secretFile = path.join(root, '.tools/mini-static-secrets.json')
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
if (process.env.CI) process.exit(0) // CI updates assets only; preserve existing authentication secrets.
let secrets
try { secrets = JSON.parse(await fs.readFile(secretFile, 'utf8')) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  secrets = { OBSERVER_ACCESS_CODE: `rsv-${randomBytes(18).toString('base64url')}`,
    OBSERVER_SESSION_SECRET: randomBytes(48).toString('base64url') }
  await fs.mkdir(path.dirname(secretFile), { recursive: true })
  await fs.writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600 })
}
await wrangler(['secret', 'bulk'], JSON.stringify(secrets))
const hostname = published.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0]
const serviceBaseUrl = process.env.MINIPROGRAM_SERVICE_URL || hostname
if (!serviceBaseUrl || !/^https:\/\/[a-z0-9.-]+$/i.test(serviceBaseUrl)) throw new Error('请设置MINIPROGRAM_SERVICE_URL为已部署并验证的HTTPS地址')
const health = await fetch(`${serviceBaseUrl}/api/health`, { signal: AbortSignal.timeout(20000) })
if (!health.ok || (await health.json()).status !== 'ok') throw new Error('线上服务尚未就绪，未切换小程序配置')
await fs.writeFile(path.join(root, 'miniprogram/config.js'),
  `module.exports = {\n  // Public address only; credentials stay on the server.\n  serviceBaseUrl: ${JSON.stringify(serviceBaseUrl)},\n}\n`)
await fs.writeFile(path.join(root, '.tools/mini-static-access.txt'),
  `星地同步实验助手 私人访问\n服务地址：${serviceBaseUrl}\n访问口令：${secrets.OBSERVER_ACCESS_CODE}\n仅向获准研究人员提供口令。小程序会保存30天会话，不保存此口令。\n`, { mode: 0o600 })
console.log('已验证独立服务，并更新小程序地址。访问口令保存在 .tools/mini-static-access.txt，不会打包进小程序或提交仓库。')
