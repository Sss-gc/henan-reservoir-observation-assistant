import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PROJECT = 'henan-reservoir-observation-assistant'
const EMAIL = '306221976@qq.com'
const LOGIN_URL = `https://${PROJECT}.pages.dev/login`
const WRANGLER_BIN = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url))

function readHidden(prompt) {
  if (!process.stdin.isTTY) throw new Error('必须在交互式终端中运行此命令。')
  return new Promise((resolve, reject) => {
    let value = ''
    process.stdout.write(prompt)
    process.stdin.setRawMode(true)
    process.stdin.setEncoding('utf8')
    process.stdin.resume()
    const finish = (error) => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') return finish()
        if (character === '\u0003') return finish(new Error('已取消。'))
        if (character === '\u007f' || character === '\b') {
          if (value) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        if (character >= ' ') {
          value += character
          process.stdout.write('•')
        }
      }
    }
    process.stdin.on('data', onData)
  })
}

function runWranglerSecretOnce(name, value, environment) {
  const child = spawn(process.execPath, [
    WRANGLER_BIN, 'pages', 'secret', 'put', name,
    '--project-name', PROJECT, '--env', environment,
  ], { stdio: ['pipe', 'inherit', 'inherit'] })
  child.stdin.end(`${value}\n`)
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Wrangler 设置 ${name} 失败（退出码 ${code}）。`)))
  })
}

async function runWranglerSecret(name, value, environment) {
  const delays = [0, 2_000, 5_000, 10_000]
  let lastError
  for (const [index, delay] of delays.entries()) {
    if (delay) {
      process.stdout.write(`网络连接失败，${delay / 1_000} 秒后自动重试（${index + 1}/${delays.length}）…\n`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    try {
      await runWranglerSecretOnce(name, value, environment)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function runWranglerDeployOnce() {
  const child = spawn(process.execPath, [
    WRANGLER_BIN, 'pages', 'deploy', 'dist',
    '--project-name', PROJECT, '--branch', 'main', '--commit-dirty=true',
  ], { stdio: 'inherit' })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Wrangler 重新部署失败（退出码 ${code}）。`)))
  })
}

async function runWranglerDeploy() {
  const delays = [0, 2_000, 5_000, 10_000]
  let lastError
  for (const [index, delay] of delays.entries()) {
    if (delay) {
      process.stdout.write(`部署连接失败，${delay / 1_000} 秒后自动重试（${index + 1}/${delays.length}）…\n`)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
    try {
      await runWranglerDeployOnce()
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

function verifyProductionLogin(password) {
  const child = spawn('curl.exe', [
    '--silent', '--show-error', '--output', 'NUL', '--write-out', '%{http_code}',
    '--max-time', '30', '--request', 'POST',
    '--header', `Origin: https://${PROJECT}.pages.dev`,
    '--header', 'Sec-Fetch-Site: same-origin',
    '--header', 'Content-Type: application/x-www-form-urlencoded',
    '--data-binary', '@-', LOGIN_URL,
  ], { stdio: ['pipe', 'pipe', 'inherit'] })
  let status = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { status += chunk })
  child.stdin.end(new URLSearchParams({ email: EMAIL, password }).toString())
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`线上登录自检请求失败（退出码 ${code}）。`))
      if (status.trim() !== '303') return reject(new Error(`线上登录自检未通过（HTTP ${status.trim() || '未知'}），请勿使用当前密码登录。`))
      resolve()
    })
  })
}

const password = await readHidden('请输入新的站内登录密码（至少 12 位）：')
const confirmation = await readHidden('请再次输入密码：')
if (password !== confirmation) throw new Error('两次输入的密码不一致。')
if (password.length < 12 || password.length > 256) throw new Error('密码长度必须为 12–256 位。')

const sessionSecret = randomBytes(32).toString('base64url')

for (const environment of ['production', 'preview']) {
  process.stdout.write(`正在配置 ${environment} 环境…\n`)
  await runWranglerSecret('AUTH_PASSWORD', password, environment)
  await runWranglerSecret('AUTH_SESSION_SECRET', sessionSecret, environment)
}

process.stdout.write('正在重新部署站点，使新密码立即生效…\n')
await runWranglerDeploy()
process.stdout.write('正在执行线上密码自检（不会显示或保存密码）…\n')
await verifyProductionLogin(password)
process.stdout.write('站内登录密码和会话密钥已加密保存并部署到 Cloudflare；明文密码未写入磁盘。\n')
process.stdout.write('线上登录自检通过，可以使用该密码登录。\n')
