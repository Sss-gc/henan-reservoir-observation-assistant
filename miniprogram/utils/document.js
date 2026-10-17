const network = require('./network')

async function downloadPlan(scope, reservoirId) {
  const document = await network.getPlanDocument(scope, reservoirId)
  if (!document || typeof document.fileName !== 'string' || /[\\/:*?"<>|]/.test(document.fileName) ||
      !document.fileName.endsWith('.docx') || !document.content || document.content.byteLength < 4 ||
      new Uint8Array(document.content)[0] !== 0x50 || new Uint8Array(document.content)[1] !== 0x4b) {
    throw new Error('Word文件返回格式无效，请稍后重试')
  }
  const filePath = `${wx.env.USER_DATA_PATH}/${document.fileName}`
  try {
    await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({
      filePath, data: document.content, success: resolve, fail: reject,
    }))
  } catch (error) { throw new Error('Word保存失败：' + (error.errMsg || error.message || '请检查手机存储空间')) }
  try {
    await new Promise((resolve, reject) => wx.openDocument({ filePath, fileType: 'docx', showMenu: true, success: resolve, fail: reject }))
  } catch (error) { throw new Error('Word打开失败：' + (error.errMsg || error.message || '请重试')) }
  return filePath
}
module.exports = { downloadPlan }
