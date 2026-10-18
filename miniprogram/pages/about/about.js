const { meta } = require('../../utils/data')
const data = require('../../utils/data')
const { showTab, prepareTabPage } = require('../../utils/tab-page')

Page({
  data: { meta },
  onLoad() { prepareTabPage() },
  onShow() { showTab(this, 2); this.setData({ meta: { ...data.meta } }) },
})
