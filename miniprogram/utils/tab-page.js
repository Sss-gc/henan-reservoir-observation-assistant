function showTab(page, index) {
  const bar = typeof page.getTabBar === 'function' ? page.getTabBar() : null
  if (bar) bar.setData({ selected: index })
  page.setData({ tabActive: true })
}
function hideTab(page) { page.setData({ tabActive: false }) }
module.exports = { showTab, hideTab }
