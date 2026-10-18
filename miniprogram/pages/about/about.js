const { meta } = require('../../utils/data')
const data = require('../../utils/data')
const { showTab, hideTab } = require('../../utils/tab-page')

Page({
  data: { meta, tabActive: false },
  onShow() { showTab(this, 2); this.setData({ meta: { ...data.meta } }) },
  onHide() { hideTab(this) },
})
