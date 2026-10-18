function prepareTabPage() {
  wx.setBackgroundColor({
    backgroundColor: '#06141d', backgroundColorTop: '#06141d', backgroundColorBottom: '#06141d',
  })
}
function showTab(page, index) {
  const bar = typeof page.getTabBar === 'function' ? page.getTabBar() : null
  if (bar && bar.data.selected !== index) bar.setData({ selected: index })
}
module.exports = { showTab, prepareTabPage }
