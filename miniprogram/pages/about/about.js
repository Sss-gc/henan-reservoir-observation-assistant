const { meta } = require('../../utils/data')
const data = require('../../utils/data')
const { showTab } = require('../../utils/tab-page')

Page({
  data: { meta },
  onShow() { showTab(this, 2); this.setData({ meta: { ...data.meta } }) },
})
