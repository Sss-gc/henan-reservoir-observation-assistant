Component({
  data: {
    selected: -1,
    hidden: false,
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
      const selected = this.data.tabs.findIndex((tab) => tab.pagePath === route)
      if (selected !== this.data.selected) this.setData({ selected })
    },
    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index)
      if (index === this.data.selected || this._switching || !this.data.tabs[index]) return
      const previous = this.data.selected
      this._switching = true
      this.setData({ selected: index })
      wx.switchTab({
        url: '/' + this.data.tabs[index].pagePath,
        fail: () => {
          this.setData({ selected: previous })
          wx.showToast({ title: '切换失败，请重试', icon: 'none' })
        },
        complete: () => { this._switching = false },
      })
    },
  },
})
