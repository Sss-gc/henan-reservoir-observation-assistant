const { wgs84ToGcj02, bounds } = require('../../utils/map-coordinates')
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
