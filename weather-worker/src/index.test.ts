import { describe, expect, it } from 'vitest'
import { ensureStaticWeatherRefresh, hasCurrentStaticWeather } from './index'
import { buildWeatherSnapshot, parseNmcForecast, RESERVOIR_STATIONS, type WeatherSnapshot } from './nmc'

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
    expect(new Set(RESERVOIR_STATIONS.map((item) => item.reservoirId)).size).toBe(26)
  })

  it('marks an already elapsed daytime slot without rejecting the daily cache', () => {
    const html = `发布时间：09-13 20:00<div id=day7>${[
      block('09/13', '&nbsp;', '晴'), block('09/14', '晴', '多云'), block('09/15', '阴', '阴'),
      block('09/16', '晴', '晴'), block('09/17', '多云', '阴'), block('09/18', '小雨', '小雨'), block('09/19', '晴', '多云'),
    ].join('')}</div>`
    expect(parseNmcForecast(html, new Date('2026-09-13T12:00:00Z')).forecast[0].dayCondition).toBe('时段已过')
  })

  it('updates successful stations while retaining the previous value for one failed station', async () => {
    const previousDay = { date: '2026-09-13', dayCondition: '晴', nightCondition: '晴' }
    const previous = {
      schemaVersion: 'nmc-text-v1', source: '中央气象台', generatedAt: '2026-09-13T01:00:00.000Z',
      staleReservoirIds: [],
      reservoirs: {
        HN_RSV_001: {
          reservoirId: 'HN_RSV_001', stationName: '安阳', sourceUrl: 'https://www.nmc.cn/old',
          publishedAt: '2026-09-13T08:00:00+08:00', fetchedAt: '2026-09-13T01:00:00.000Z',
          forecast: [previousDay],
        },
        HN_RSV_026: {
          reservoirId: 'HN_RSV_026', stationName: '安阳', sourceUrl: 'https://www.nmc.cn/old',
          publishedAt: '2026-09-13T08:00:00+08:00', fetchedAt: '2026-09-13T01:00:00.000Z',
          forecast: [previousDay],
        },
      },
    } satisfies WeatherSnapshot
    const html = `发布时间：09-14 08:00<div id=day7>${[
      block('09/14', '多云', '晴'), block('09/15', '晴', '晴'), block('09/16', '阴', '小雨'),
      block('09/17', '晴', '晴'), block('09/18', '多云', '阴'), block('09/19', '小雨', '小雨'),
      block('09/20', '晴', '多云'),
    ].join('')}</div>`
    const redirects: Array<RequestRedirect | undefined> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      redirects.push(init?.redirect)
      return String(input).endsWith('/anyang.html')
        ? new Response('upstream error', { status: 500 })
        : new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } })
    }) as typeof fetch

    const snapshot = await buildWeatherSnapshot(async () => {}, new Date('2026-09-14T01:00:00Z'), previous, fetcher)
    expect(Object.keys(snapshot.reservoirs)).toHaveLength(26)
    expect(snapshot.staleReservoirIds).toEqual(['HN_RSV_001', 'HN_RSV_026'])
    expect(snapshot.reservoirs.HN_RSV_001.forecast).toEqual([previousDay])
    expect(snapshot.reservoirs.HN_RSV_001.fetchedAt).toBe('2026-09-13T01:00:00.000Z')
    expect(snapshot.reservoirs.HN_RSV_002.forecast[0].date).toBe('2026-09-14')
    expect(snapshot.reservoirs.HN_RSV_002.fetchedAt).toBe('2026-09-14T01:00:00.000Z')
    expect(snapshot.reservoirs.HN_RSV_021.sourceUrl).toBe('https://www.nmc.cn/publish/forecast/AHA/xinyang.html')
    expect(snapshot.reservoirs.HN_RSV_024.sourceUrl).toBe('https://www.nmc.cn/publish/forecast/AHA/zuochuan2.html')
    expect(redirects).toHaveLength(22)
    expect(new Set(redirects)).toEqual(new Set(['manual']))
  })
})

const staticWeather = (publishedAt = '2026-10-20T08:00:00+08:00') => ({
  pipeline: 'miniprogram-static-independent-v1', source: '中央气象台', generatedAt: '2026-10-20T00:05:00Z',
  items: Object.fromEntries(Array.from({ length: RESERVOIR_STATIONS.length }, (_, index) => [String(index), {
    fetchedAt: '2026-10-20T00:05:00Z', publishedAt,
    days: Array.from({ length: 7 }, (_, day) => ({ date: `2026-10-${String(20 + day).padStart(2, '0')}` })),
  }])),
})

describe('independent mini-program refresh watchdog', () => {
  const now = new Date('2026-10-20T00:10:00Z')

  it('recognizes only a complete current reservoir weather batch', () => {
    expect(hasCurrentStaticWeather(staticWeather(), now)).toBe(true)
    expect(hasCurrentStaticWeather(staticWeather('2026-10-19T20:00:00+08:00'), now)).toBe(false)
    expect(hasCurrentStaticWeather({ ...staticWeather(), items: {} }, now)).toBe(false)
  })

  it('does not dispatch when GitHub Pages already has current weather', async () => {
    const calls: string[] = []
    const fetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return Response.json(staticWeather())
    }) as typeof fetch
    await expect(ensureStaticWeatherRefresh({} as Env, now, fetcher)).resolves.toBe('already-current')
    expect(calls).toHaveLength(1)
  })

  it('dispatches the workflow with the encrypted token when weather is stale', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init })
      return calls.length === 1 ? Response.json(staticWeather('2026-10-19T20:00:00+08:00')) : new Response(null, { status: 204 })
    }) as typeof fetch
    await expect(ensureStaticWeatherRefresh({ GITHUB_WORKFLOW_TOKEN: 'test-token' } as Env, now, fetcher)).resolves.toBe('dispatched')
    expect(calls).toHaveLength(2)
    expect(calls[1].init?.method).toBe('POST')
    expect(new Headers(calls[1].init?.headers).get('Authorization')).toBe('Bearer test-token')
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ ref: 'main' })
  })

  it('reports missing credentials or a rejected GitHub dispatch', async () => {
    const stale = (async () => Response.json(staticWeather('2026-10-19T20:00:00+08:00'))) as typeof fetch
    await expect(ensureStaticWeatherRefresh({} as Env, now, stale)).rejects.toThrow('GITHUB_WORKFLOW_TOKEN')
    let call = 0
    const rejected = (async () => ++call === 1
      ? Response.json(staticWeather('2026-10-19T20:00:00+08:00'))
      : new Response('forbidden', { status: 403 })) as typeof fetch
    await expect(ensureStaticWeatherRefresh({ GITHUB_WORKFLOW_TOKEN: 'bad-token' } as Env, now, rejected)).rejects.toThrow('HTTP 403')
  })
})
