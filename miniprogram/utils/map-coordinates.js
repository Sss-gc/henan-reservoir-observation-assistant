// Map display only. Reservoir geometry, reference area and observation inputs stay WGS84.
const PI = Math.PI, A = 6378245, EE = 0.006693421622965943
function wgs84ToGcj02(longitude, latitude) {
  if (longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271) return { longitude, latitude }
  const x = longitude - 105, y = latitude - 35
  const wave = 2 / 3 * (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI))
  let latOffset = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x)) + wave
  latOffset += 2 / 3 * (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI))
  latOffset += 2 / 3 * (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30))
  let lonOffset = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x)) + wave
  lonOffset += 2 / 3 * (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI))
  lonOffset += 2 / 3 * (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI))
  const radians = latitude / 180 * PI, sin = Math.sin(radians), magic = 1 - EE * sin * sin
  return {
    longitude: longitude + lonOffset * 180 / (A / Math.sqrt(magic) * Math.cos(radians) * PI),
    latitude: latitude + latOffset * 180 / (A * (1 - EE) / magic ** 1.5 * PI),
  }
}
function bounds(points) {
  if (!points.length) return []
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
  for (const { longitude, latitude } of points) {
    west = Math.min(west, longitude); east = Math.max(east, longitude)
    south = Math.min(south, latitude); north = Math.max(north, latitude)
  }
  return [{ longitude: west, latitude: south }, { longitude: east, latitude: north }]
}
module.exports = { wgs84ToGcj02, bounds }
