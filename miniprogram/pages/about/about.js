const { meta } = require('../../utils/data')
const data = require('../../utils/data')

Page({
  data: { meta },
  onShow() { this.setData({ meta: { ...data.meta } }) },
})
