// These helpers belong to this component. Keep display conversion independent of data loading.
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
Component({
  properties: { mapData: { type: Object, value: null, observer() { if (this._ready) this.updateMap() } } },
  data: { longitude: 113.6, latitude: 33.8, scale: 9, markers: [], polyline: [] },
  lifetimes: {
    ready() {
      this._context = wx.createMapContext('native-map', this)
      this._ready = true; this.updateMap()
    },
    detached() { this._ready = false },
  },
  methods: {
    updateMap() {
      const map = this.properties.mapData
      if (!map || !this._ready) return
      this._markerIds = {}
      const markers = map.markers.map((marker, index) => {
        const selected = marker.id === map.selectedId, id = index + 1
        this._markerIds[id] = marker.id
        return { id, ...wgs84ToGcj02(marker.longitude, marker.latitude),
          iconPath: selected ? '/assets/marker-selected.png' : '/assets/marker.png',
          width: selected ? 30 : 22, height: selected ? 38 : 28,
          ...(selected ? { callout: { content: marker.name, display: 'ALWAYS', padding: 6,
            fontSize: 12, color: '#123442', bgColor: '#E7FAF6', borderRadius: 4 } } : {}),
        }
      })
      const polyline = map.rings.filter((ring) => ring.length > 1).map((ring) => ({
        points: ring.map(([lon, lat]) => wgs84ToGcj02(lon, lat)), color: '#10B7A5', width: 2,
      }))
      const selected = markers.find((marker) => this._markerIds[marker.id] === map.selectedId)
      this._currentBounds = bounds(polyline.flatMap((line) => line.points))
      this._allBounds = bounds(markers)
      this.setData({ markers, polyline, ...(selected ? { longitude: selected.longitude, latitude: selected.latitude } : {}) }, () => this.fitCurrent())
    },
    fitCurrent() { if (this._ready && this._currentBounds.length) this._context.includePoints({ points: this._currentBounds, padding: [24, 24, 24, 24] }) },
    overview() { if (this._ready && this._allBounds.length) this._context.includePoints({ points: this._allBounds, padding: [24, 24, 24, 24] }) },
    onMarkerTap(event) {
      const reservoirId = this._markerIds[event.detail.markerId]
      if (reservoirId) this.triggerEvent('select', { reservoirId })
    },
    zoomIn() { this.changeZoom(1) },
    zoomOut() { this.changeZoom(-1) },
    changeZoom(delta) {
      if (this._ready) this._context.getScale({ success: ({ scale }) => {
        if (this._ready) this.setData({ scale: Math.max(4, Math.min(18, scale + delta)) })
      } })
    },
  },
})
