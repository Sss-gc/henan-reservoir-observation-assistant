const { serviceBaseUrl } = require('../config')
function request(path, options = {}) {
  if (!/^https:\/\/[a-zA-Z0-9.-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(serviceBaseUrl)) return Promise.reject(new Error('独立静态服务尚未部署'))
  return new Promise((resolve, reject) => wx.request({
    url: serviceBaseUrl + path, method: 'GET', timeout: 20000,
    responseType: options.binary ? 'arraybuffer' : 'text',
    header: { Accept: options.binary ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/json' },
    success(response) {
      let body = response.data
      if (!options.binary && typeof body === 'string') {
        try { body = JSON.parse(body) } catch { return reject(new Error('静态服务返回格式无效，请稍后重试')) }
      }
      if (response.statusCode !== 200) return reject(new Error(body?.error?.message || `静态服务返回HTTP ${response.statusCode}`))
      resolve(body)
    },
    fail(error) { reject(new Error('连接失败：' + (error.errMsg || '请检查网络及合法域名设置'))) },
  }))
}
async function getPlanDocument(scope, reservoirId) {
  const id = scope === 'all' ? 'all' : scope === 'current' && /^HN_RSV_\d{3}$/.test(reservoirId) ? reservoirId : null
  if (!id) throw new Error('请选择当前水库或全部水库')
  const manifest = await request('/data/manifest.json')
  if (manifest?.pipeline !== 'miniprogram-static-independent-v1') throw new Error('独立静态文件清单无效')
  const document = manifest.documents?.[id]
  if (!document || document.path !== `/documents/${id}.docx` || typeof document.fileName !== 'string') throw new Error('该Word方案尚未生成')
  const content = await request(document.path, { binary: true })
  if (!content || content.byteLength !== document.bytes) throw new Error('Word下载不完整，请重试')
  return { fileName: document.fileName, content }
}
module.exports = { getPlanDocument,
  getOrbits: () => request('/data/orbits.json'), getWeather: () => request('/data/weather.json') }
