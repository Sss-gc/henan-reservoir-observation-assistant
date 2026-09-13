import { describe, expect, it } from 'vitest'
import { parseNmcForecast, RESERVOIR_STATIONS } from './nmc'

const block = (date: string, day: string, night: string) => `<div class="weather pull-left"><div class=weatherWrap><div class=date>${date}<br>周一</div><div class=desc>${day}</div><div class=tmp>30℃</div><div class=desc>${night}</div></div></div>`

describe('NMC text forecast parser', () => {
  it('extracts seven dates and day/night conditions without retaining HTML', () => {
    const html = `发布时间：12-30 08:00<div id=day7>${[
      block('12/30', '晴', '多云'), block('12/31', '阴', '小雨'), block('01/01', '雨夹雪', '小雪'),
      block('01/02', '多云', '晴'), block('01/03', '雾', '阴'), block('01/04', '晴', '晴'), block('01/05', '多云', '阴'),
    ].join('')}</div>`
    const result = parseNmcForecast(html, new Date('2026-12-30T01:00:00Z'))
    expect(result.forecast).toHaveLength(7)
    expect(result.forecast[0]).toEqual({ date: '2026-12-30', dayCondition: '晴', nightCondition: '多云' })
    expect(result.forecast[2].date).toBe('2027-01-01')
    expect(result.publishedAt).toBe('2026-12-30T08:00:00+08:00')
  })

  it('rejects incomplete or blocked pages and maps every reservoir once', () => {
    expect(() => parseNmcForecast('<title>中央气象台-404错误页面</title>')).toThrow()
    expect(new Set(RESERVOIR_STATIONS.map((item) => item.reservoirId)).size).toBe(25)
  })

  it('marks an already elapsed daytime slot without rejecting the daily cache', () => {
    const html = `发布时间：09-13 20:00<div id=day7>${[
      block('09/13', '&nbsp;', '晴'), block('09/14', '晴', '多云'), block('09/15', '阴', '阴'),
      block('09/16', '晴', '晴'), block('09/17', '多云', '阴'), block('09/18', '小雨', '小雨'), block('09/19', '晴', '多云'),
    ].join('')}</div>`
    expect(parseNmcForecast(html, new Date('2026-09-13T12:00:00Z')).forecast[0].dayCondition).toBe('时段已过')
  })
})
