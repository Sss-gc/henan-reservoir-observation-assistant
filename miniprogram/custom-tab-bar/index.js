Component({
  data: {
    selected: -1,
    tabs: [
      { pagePath: 'pages/dashboard/dashboard', text: '水库观测' },
      { pagePath: 'pages/plan/plan', text: '实验方案' },
      { pagePath: 'pages/about/about', text: '数据说明' },
    ],
  },
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
