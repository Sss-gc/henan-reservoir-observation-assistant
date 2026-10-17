const { apiBase } = require('../config')
const SESSION_KEY = 'observer:session'
let session = null

function getSession() {
  if (!session) session = wx.getStorageSync(SESSION_KEY) || null
  if (session && session.expiresAt <= Date.now()) clearSession()
  return session
}
function clearSession() { session = null; wx.removeStorageSync(SESSION_KEY) }
function headers() {
  const value = getSession()
  return value ? { Authorization: `Bearer ${value.token}` } : {}
}
function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    wx.request({ url: apiBase + path, method: options.method || 'GET', data: options.data,
      timeout: 20000, header: { ...headers(), Accept: 'application/json', 'Content-Type': 'application/json' },
      success(response) {
        if (response.statusCode === 401 && path !== '/api/session') {
          clearSession()
          const error = new Error('登录已过期，请重新登录'); error.unauthorized = true; reject(error); return
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(response.data?.error || `网站接口返回 HTTP ${response.statusCode}`)); return
        }
        resolve(response.data)
      }, fail() { reject(new Error('无法连接网站接口，请检查网络及小程序合法域名配置')) },
    })
  })
}
async function login(email, password) {
  const result = await request('/api/session', { method: 'POST', data: { email, password } })
  if (typeof result.token !== 'string' || !(result.expiresAt > Date.now())) throw new Error('登录响应无效')
  session = { token: result.token, expiresAt: result.expiresAt }
  wx.setStorageSync(SESSION_KEY, session)
}
function requireLogin() {
  if (getSession()) return true
  wx.reLaunch({ url: '/pages/login/login' }); return false
}
function downloadTile(layer, z, x, y) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({ url: `${apiBase}/api/map-tile?layer=${layer}&z=${z}&x=${x}&y=${y}`,
      header: headers(), timeout: 20000,
      success(response) {
        if (response.statusCode === 200) resolve(response.tempFilePath)
        else {
          if (response.statusCode === 401) clearSession()
          reject(new Error(response.statusCode === 401 ? '登录已过期，请重新登录' : response.statusCode === 503 ? '天地图服务端key尚未配置' : '天地图加载失败，请检查网络或服务许可'))
        }
      }, fail() { reject(new Error('天地图连接失败，请检查 downloadFile 合法域名配置')) },
    })
  })
}
module.exports = { apiBase, getSession, clearSession, request, login, requireLogin, downloadTile }
