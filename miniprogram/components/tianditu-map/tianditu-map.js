const { project, unproject, fit } = require('../../utils/map-projection')
const { downloadTile } = require('../../utils/network')
Component({
  properties: { mapData: { type: Object, value: null, observer() { if (this._canvas) this.fitCurrent() } } },
  data: { tiles: [], error: '', loading: false },
  lifetimes: {
    ready() {
      this._cache = new Map(); this._generation = 0; this._alive = true
      this.createSelectorQuery().select('#boundary-canvas').fields({ node: true, size: true, rect: true }).exec((result) => {
        if (!this._alive || !result[0]?.node) return
        const view = result[0]
        this._canvas = view.node; this._width = view.width; this._height = view.height; this._rect = view
        const ratio = wx.getWindowInfo().pixelRatio
        this._canvas.width = view.width * ratio; this._canvas.height = view.height * ratio
        this._ctx = this._canvas.getContext('2d'); this._ctx.scale(ratio, ratio)
        this.fitCurrent()
      })
    },
    detached() { this._alive = false; this._generation++ },
  },
  methods: {
    fitCurrent() {
      const map = this.properties.mapData
      if (!this._canvas || !map) return
      this._view = fit(map.rings.flat().map(([longitude, latitude]) => ({ longitude, latitude })), this._width, this._height)
      this.render(true)
    },
    overview() {
      if (!this._canvas || !this.properties.mapData) return
      this._view = fit(this.properties.mapData.markers, this._width, this._height)
      this.render(true)
    },
    zoomIn() { this.changeZoom(1) }, zoomOut() { this.changeZoom(-1) },
    changeZoom(delta) { if (this._view) { this._view.zoom = Math.max(4, Math.min(18, this._view.zoom + delta)); this.render(true) } },
    screenPoint(longitude, latitude) {
      const center = project(this._view.longitude, this._view.latitude, this._view.zoom)
      const point = project(longitude, latitude, this._view.zoom)
      return { x: point.x - center.x + this._width / 2, y: point.y - center.y + this._height / 2 }
    },
    drawBoundary() {
      const ctx = this._ctx, map = this.properties.mapData
      if (!ctx || !map || !this._view) return
      ctx.clearRect(0, 0, this._width, this._height)
      ctx.strokeStyle = '#10b7a5'; ctx.lineWidth = 2
      for (const ring of map.rings) {
        ctx.beginPath()
        ring.forEach(([lon, lat], index) => { const p = this.screenPoint(lon, lat); if (index) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y) })
        ctx.stroke()
      }
      for (const marker of map.markers) {
        const p = this.screenPoint(marker.longitude, marker.latitude), selected = marker.id === map.selectedId
        if (p.x < -10 || p.y < -10 || p.x > this._width + 10 || p.y > this._height + 10) continue
        ctx.beginPath(); ctx.arc(p.x, p.y, selected ? 7 : 4, 0, Math.PI * 2)
        ctx.fillStyle = selected ? '#10b7a5' : '#3897c2'; ctx.fill()
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke()
        if (selected) {
          ctx.font = '12px sans-serif'; const width = ctx.measureText(marker.name).width + 12
          const x = Math.min(this._width - width, Math.max(0, p.x - width / 2)), y = Math.max(2, p.y - 30)
          ctx.fillStyle = '#e7faf6'; ctx.fillRect(x, y, width, 20)
          ctx.fillStyle = '#123442'; ctx.fillText(marker.name, x + 6, y + 14)
        }
      }
    },
    render(load) {
      if (!this._view || !this._alive) return
      const { zoom } = this._view, center = project(this._view.longitude, this._view.latitude, zoom)
      const left = center.x - this._width / 2, top = center.y - this._height / 2, tiles = []
      for (const layer of ['vec', 'cva']) for (let y = Math.floor(top / 256); y <= Math.floor((top + this._height) / 256); y++) {
        for (let x = Math.floor(left / 256); x <= Math.floor((left + this._width) / 256); x++) {
          if (x < 0 || y < 0 || x >= 2 ** zoom || y >= 2 ** zoom) continue
          const key = `${layer}/${zoom}/${x}/${y}`
          tiles.push({ key, layer, z: zoom, x, y, left: Math.round(x * 256 - left), top: Math.round(y * 256 - top), path: this._cache.get(key)?.path || '' })
        }
      }
      this.setData({ tiles }); this.drawBoundary()
      if (load) this.loadTiles(tiles)
    },
    async loadTiles(tiles) {
      const generation = ++this._generation, tasks = tiles.filter((t) => !t.path)
      this.setData({ error: '', loading: !!tasks.length })
      let index = 0, error = ''
      const worker = async () => {
        while (index < tasks.length && this._alive && generation === this._generation) {
          const tile = tasks[index++]
          try {
            let entry = this._cache.get(tile.key)
            if (!entry) {
              entry = {}; entry.promise = downloadTile(tile.layer, tile.z, tile.x, tile.y).then((path) => { entry.path = path; return path })
              this._cache.set(tile.key, entry)
            }
            await entry.promise
            if (this._alive && generation === this._generation) this.render(false)
          } catch (failure) { this._cache.delete(tile.key); error = failure.message }
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, tasks.length) }, worker))
      if (!this._alive || generation !== this._generation) return
      this.setData({ loading: false, error })
      const visible = new Set(tiles.map((t) => t.key))
      for (const [key, entry] of this._cache) {
        if (this._cache.size <= 96) break
        if (!visible.has(key) && entry.path) {
          wx.getFileSystemManager().unlink({ filePath: entry.path, fail() {} }); this._cache.delete(key)
        }
      }
    },
    retry() { this.render(true) },
    point(touch) { return { x: touch.x ?? (touch.clientX - this._rect.left), y: touch.y ?? (touch.clientY - this._rect.top) } },
    touchStart(event) {
      if (!this._view) return
      const points = event.touches.map((t) => this.point(t))
      this._gesture = { points, view: { ...this._view }, moved: false }
    },
    touchMove(event) {
      const start = this._gesture
      if (!start || !this._view) return
      const points = event.touches.map((t) => this.point(t))
      if (points.length !== start.points.length) { this.touchStart(event); return }
      const center = project(start.view.longitude, start.view.latitude, start.view.zoom)
      if (points.length === 1) {
        const dx = points[0].x - start.points[0].x, dy = points[0].y - start.points[0].y
        start.moved = start.moved || Math.abs(dx) + Math.abs(dy) > 6
        this._view = { ...unproject(center.x - dx, center.y - dy, start.view.zoom), zoom: start.view.zoom }
      } else if (points.length >= 2) {
        const distance = (ps) => Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y)
        const delta = Math.round(Math.log2(distance(points) / Math.max(1, distance(start.points))))
        this._view = { ...start.view, zoom: Math.max(4, Math.min(18, start.view.zoom + delta)) }; start.moved = true
      }
      if (!this._lastDraw || Date.now() - this._lastDraw > 24) { this._lastDraw = Date.now(); this.render(false) }
    },
    touchEnd(event) {
      const start = this._gesture
      if (!start) return
      if (event.touches.length) { this.touchStart(event); return }
      if (!start.moved && start.points.length === 1) {
        const point = start.points[0]
        const marker = [...this.properties.mapData.markers].sort((a, b) => Number(b.id === this.properties.mapData.selectedId) - Number(a.id === this.properties.mapData.selectedId))
          .find((m) => { const p = this.screenPoint(m.longitude, m.latitude); return Math.hypot(p.x - point.x, p.y - point.y) < 18 })
        if (marker) this.triggerEvent('select', { reservoirId: marker.id })
      }
      this._gesture = null; this.render(true)
    },
    touchCancel() { this._gesture = null; this.render(true) },
  },
})
