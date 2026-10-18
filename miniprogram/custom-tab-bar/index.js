const { tabBar } = require('../app.json')

Component({
  data: { selected: -1, tabs: tabBar.list },
  lifetimes: { attached() { this.syncSelection() } },
  pageLifetimes: { show() { this.syncSelection() } },
  methods: {
    syncSelection() {
      const pages = getCurrentPages()
      const route = pages[pages.length - 1]?.route
      this.setData({ selected: this.data.tabs.findIndex((tab) => tab.pagePath === route) })
    },
    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index)
      if (index === this.data.selected || this._switching || !this.data.tabs[index]) return
      this._switching = true
      wx.switchTab({
        url: '/' + this.data.tabs[index].pagePath,
        fail: () => wx.showToast({ title: '切换失败，请重试', icon: 'none' }),
        complete: () => { this._switching = false },
      })
    },
  },
})
