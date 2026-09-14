import {
  createSessionToken, isSameOriginFormPost, rateLimitKey, requestHasValidSession,
  secureDynamicHeaders, sessionCookie, verifyPassword,
} from './_auth'

const MAX_ATTEMPTS = 5
const ATTEMPT_WINDOW_SECONDS = 15 * 60
const MAX_FORM_BYTES = 8_192

async function readForm(request: Request) {
  if (!(request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    throw new Error('INVALID_FORM_TYPE')
  }
  const reader = request.body?.getReader()
  if (!reader) return new URLSearchParams()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_FORM_BYTES) {
      await reader.cancel()
      throw new Error('FORM_TOO_LARGE')
    }
    chunks.push(value)
  }
  const body = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new URLSearchParams(new TextDecoder().decode(body))
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character] ?? character)
}

function loginPage(email: string, message = '', status = 200) {
  const headers = secureDynamicHeaders(new Headers({ 'Content-Type': 'text/html; charset=utf-8' }))
  const error = message ? `<div class="error" role="alert">${escapeHtml(message)}</div>` : ''
  return new Response(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>登录｜星地同步实验助手</title>
  <style>
    :root{color-scheme:dark;font-family:"Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;background:#06141d;color:#e5f2f7}*{box-sizing:border-box}body{margin:0;min-width:320px;min-height:100vh;background:radial-gradient(circle at 20% 15%,rgba(45,212,191,.11),transparent 32%),radial-gradient(circle at 86% 82%,rgba(56,189,248,.09),transparent 28%),#06141d}.page{min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(430px,100%);padding:34px;border:1px solid rgba(148,184,204,.17);border-radius:20px;background:linear-gradient(145deg,rgba(13,38,52,.98),rgba(7,25,35,.98));box-shadow:0 28px 80px rgba(0,0,0,.42)}.mark{width:54px;height:54px;display:grid;place-items:center;border-radius:16px;background:linear-gradient(145deg,#5eead4,#14b8a6);box-shadow:0 12px 32px rgba(45,212,191,.22);color:#052019;font-size:27px}.eyebrow{margin:22px 0 5px;color:#2dd4bf;font:700 10px/1.4 ui-sans-serif;letter-spacing:.18em}.card h1{margin:0;font-size:25px}.intro{margin:10px 0 25px;color:#83a5b6;font-size:13px;line-height:1.7}.field{display:block;margin-top:15px;color:#a9c0ca;font-size:12px}.field span{display:block;margin-bottom:7px}.field input{width:100%;height:48px;padding:0 14px;border:1px solid rgba(148,184,204,.2);border-radius:10px;outline:0;background:#071b26;color:#edf8fa;font-size:14px}.field input:focus{border-color:#2dd4bf;box-shadow:0 0 0 3px rgba(45,212,191,.1)}button{width:100%;height:48px;margin-top:22px;border:0;border-radius:10px;background:linear-gradient(135deg,#2dd4bf,#14b8a6);color:#052019;font-weight:700;cursor:pointer;box-shadow:0 10px 28px rgba(45,212,191,.16)}button:hover{filter:brightness(1.06)}.error{margin:0 0 14px;padding:10px 12px;border:1px solid rgba(248,113,113,.3);border-radius:9px;background:rgba(248,113,113,.08);color:#fecaca;font-size:12px;line-height:1.5}.privacy{margin:18px 0 0;color:#5f8293;text-align:center;font-size:10px;line-height:1.6}@media(max-width:520px){.card{padding:26px 21px;border-radius:16px}}
  </style>
</head>
<body><main class="page"><section class="card" aria-labelledby="title">
  <div class="mark" aria-hidden="true">◈</div>
  <p class="eyebrow">HENAN RESERVOIR FIELD LAB</p>
  <h1 id="title">星地同步实验助手</h1>
  <p class="intro">这是私人访问页面。请输入已配置的邮箱和密码继续。</p>
  ${error}
  <form method="post" action="/login">
    <label class="field"><span>邮箱</span><input name="email" type="email" value="${escapeHtml(email)}" autocomplete="username" inputmode="email" required autofocus></label>
    <label class="field"><span>密码</span><input name="password" type="password" autocomplete="current-password" required></label>
    <button type="submit">登录实验助手</button>
  </form>
  <p class="privacy">凭据仅通过 HTTPS 发送到本站的 Cloudflare Pages Function，不会写入浏览器脚本或项目源码。</p>
</section></main></body></html>`, { status, headers })
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  if (await requestHasValidSession(context.request, context.env)) {
    return new Response(null, {
      status: 302,
      headers: secureDynamicHeaders(new Headers({ Location: new URL('/', context.request.url).toString() })),
    })
  }
  return loginPage('')
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  if (!isSameOriginFormPost(context.request)) return loginPage('', '请求来源无效，请刷新页面后重试。', 403)
  const contentLength = Number(context.request.headers.get('Content-Length') ?? 0)
  if (contentLength > MAX_FORM_BYTES) return loginPage('', '提交内容过大。', 413)
  if (!context.env.AUTH_PASSWORD || !context.env.AUTH_SESSION_SECRET || !context.env.AUTH_EMAIL) {
    return loginPage('', '登录服务尚未完成配置，请稍后重试。', 503)
  }

  try {
    const key = await rateLimitKey(context.request, context.env.AUTH_SESSION_SECRET)
    const attempts = Number(await context.env.WEATHER_KV.get(key) ?? 0)
    if (attempts >= MAX_ATTEMPTS) {
      const response = loginPage('', '尝试次数过多，请在 15 分钟后重试。', 429)
      response.headers.set('Retry-After', String(ATTEMPT_WINDOW_SECONDS))
      return response
    }

    const form = await readForm(context.request)
    const email = (form.get('email') ?? '').trim().toLowerCase().slice(0, 254)
    const password = (form.get('password') ?? '').slice(0, 256)
    const expectedEmail = context.env.AUTH_EMAIL.trim().toLowerCase()
    const passwordValid = await verifyPassword(password, context.env.AUTH_PASSWORD)
    if (email !== expectedEmail || !passwordValid) {
      await context.env.WEATHER_KV.put(key, String(attempts + 1), { expirationTtl: ATTEMPT_WINDOW_SECONDS })
      return loginPage(email, '邮箱或密码不正确。', 401)
    }

    await context.env.WEATHER_KV.delete(key)
    const token = await createSessionToken(expectedEmail, context.env.AUTH_SESSION_SECRET)
    const headers = secureDynamicHeaders(new Headers({ Location: '/', 'Set-Cookie': sessionCookie(token) }))
    return new Response(null, { status: 303, headers })
  } catch (error) {
    if (error instanceof Error && error.message === 'FORM_TOO_LARGE') return loginPage('', '提交内容过大。', 413)
    if (error instanceof Error && error.message === 'INVALID_FORM_TYPE') return loginPage('', '提交格式无效。', 415)
    console.error(JSON.stringify({ event: 'login_error', error: error instanceof Error ? error.message : String(error) }))
    return loginPage('', '登录服务暂时不可用，请稍后重试。', 503)
  }
}
