const BASINS = [
  { name: '黄河流域', shortName: '黄', color: '#d08770', ids: ['HN_RSV_002', 'HN_RSV_010', 'HN_RSV_011', 'HN_RSV_016', 'HN_RSV_017'] },
  { name: '淮河流域', shortName: '淮', color: '#88c0d0', ids: ['HN_RSV_003', 'HN_RSV_004', 'HN_RSV_005', 'HN_RSV_008', 'HN_RSV_009', 'HN_RSV_013', 'HN_RSV_014', 'HN_RSV_015', 'HN_RSV_018', 'HN_RSV_019', 'HN_RSV_020', 'HN_RSV_021', 'HN_RSV_022', 'HN_RSV_023', 'HN_RSV_025'] },
  { name: '长江流域', shortName: '长', color: '#a3be8c', ids: ['HN_RSV_006', 'HN_RSV_012', 'HN_RSV_024'] },
  { name: '海河流域', shortName: '海', color: '#b48ead', ids: ['HN_RSV_001', 'HN_RSV_007', 'HN_RSV_026'] },
]

const BASIN_BY_ID = Object.fromEntries(BASINS.flatMap((basin) => basin.ids.map((id) => [id, basin])))

function getBasin(id) { return BASIN_BY_ID[id] || null }

module.exports = { BASINS, getBasin }
