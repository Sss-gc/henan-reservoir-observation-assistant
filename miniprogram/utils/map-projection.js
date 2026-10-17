const TILE_SIZE = 256
function project(longitude, latitude, zoom) {
  const size = TILE_SIZE * 2 ** zoom
  const sin = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180)
  return { x: (longitude + 180) / 360 * size, y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size }
}
function unproject(x, y, zoom) {
  const size = TILE_SIZE * 2 ** zoom
  return { longitude: x / size * 360 - 180, latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI }
}
function fit(points, width, height, padding = 28) {
  if (!points.length) return { longitude: 113.6, latitude: 34.7, zoom: 6 }
  const pixels = points.map((p) => project(p.longitude, p.latitude, 0))
  const minX = Math.min(...pixels.map((p) => p.x)), maxX = Math.max(...pixels.map((p) => p.x))
  const minY = Math.min(...pixels.map((p) => p.y)), maxY = Math.max(...pixels.map((p) => p.y))
  const scale = Math.min(
    Math.max(1, width - 2 * padding) / Math.max(0.00001, maxX - minX),
    Math.max(1, height - 2 * padding) / Math.max(0.00001, maxY - minY))
  const zoom = Math.max(4, Math.min(18, Math.floor(Math.log2(scale))))
  return { ...unproject((minX + maxX) / 2, (minY + maxY) / 2, 0), zoom }
}
module.exports = { project, unproject, fit, TILE_SIZE }
