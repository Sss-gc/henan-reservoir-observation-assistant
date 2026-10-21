import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import type {
  ReservoirCollection, SamplingReferenceLayouts, SamplingReservoir, SamplingScopeCollection,
} from '../types'
import {
  buildOviKml, buildSamplingPlan, createGeometry, createSamplingReservoir, getSamplingSchemes,
  moveSamplingPoint, pointInGeometry,
} from './sampling'
import type { SamplingPlan, SamplingScheme } from './sampling'

const require = createRequire(new URL('../../miniprogram/package.json', import.meta.url))
const mini = require('./utils/sampling.js') as {
  buildSamplingPlan: (reservoir: SamplingReservoir, request?: number | { schemeId: 'sync' | 'shore'; count?: number }) => SamplingPlan
  buildOviKml: typeof buildOviKml
  moveSamplingPoint: typeof moveSamplingPoint
  getSamplingSchemes: (reservoir: SamplingReservoir) => SamplingScheme[]
}
const miniReservoirs = require('./data/reservoirs.js') as SamplingReservoir[]
const miniBasins = require('./data/basins.js') as { getBasin: (id: string) => { name: string } }
const miniReferences = require('./data/sampling-reference.js') as SamplingReferenceLayouts
function readData<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../../public/data/${name}`, import.meta.url), 'utf8')) as T
}
const references = readData<SamplingReferenceLayouts>('sampling-reference.json')
const scopes = readData<SamplingScopeCollection>('reservoir-sampling-scopes.geojson')
const reservoirs = readData<ReservoirCollection>('reservoirs.geojson').features.map((feature) =>
  createSamplingReservoir(feature, scopes.features.find((scope) => scope.properties.id === feature.properties.id)!))
const miniById = new Map(miniReservoirs.map((reservoir) => [
  reservoir.id, { ...reservoir, basin: miniBasins.getBasin(reservoir.id).name },
]))

describe('web and mini program sampling parity', () => {
  it('uses the complete mini program reservoir and historical-reference data', () => {
    expect(reservoirs).toHaveLength(26)
    expect(references).toEqual(miniReferences)
    for (const reservoir of reservoirs) {
      expect(reservoir, reservoir.id).toEqual(miniById.get(reservoir.id))
    }
  })

  describe.each(reservoirs)('$name_cn ($id)', (reservoir) => {
    it('offers the same recommended scheme counts', () => {
      expect(getSamplingSchemes(reservoir, references)).toEqual(mini.getSamplingSchemes(miniById.get(reservoir.id)!))
    })

    it.each(['sync', 'shore'] as const)('matches the default %s plan and exported KML', (schemeId) => {
      const plan = buildSamplingPlan(reservoir, references, { schemeId })
      expect(plan).toEqual(mini.buildSamplingPlan(miniById.get(reservoir.id)!, { schemeId }))
      expect(plan.points.map((point) => point.name)).toEqual(
        Array.from({ length: plan.count }, (_, index) => String(index + 1).padStart(2, '0')),
      )
      const kml = buildOviKml(reservoir, plan)
      expect(kml).toBe(mini.buildOviKml(miniById.get(reservoir.id)!, plan))
      const document = new DOMParser().parseFromString(kml, 'application/xml')
      const placemarks = Array.from(document.getElementsByTagName('Placemark'))
      expect(placemarks).toHaveLength(plan.count)
      expect(placemarks.map((placemark) => placemark.getElementsByTagName('coordinates')[0].textContent)).toEqual(
        plan.points.map((point) => `${point.longitude.toFixed(8)},${point.latitude.toFixed(8)},0`),
      )
      if (plan.source !== 'reference' || reservoir.scope_retained_pct < 99.95) {
        const geometry = createGeometry(reservoir)
        for (const point of plan.points) {
          expect(pointInGeometry(geometry.project([point.longitude, point.latitude]), geometry)).toBe(true)
        }
      }
      if (plan.source === 'generated') {
        expect(plan.minimumShoreDistanceM).toBeGreaterThanOrEqual(plan.shorelineBufferM - 1)
      } else if (schemeId === 'shore') {
        expect(plan.accessVerificationRequired).toBe(true)
        expect(plan.points.every((point) => point.shoreDistanceKm >= 0.01 && point.shoreDistanceKm <= 0.2)).toBe(true)
      }
    })

    it.each(['sync', 'shore'] as const)('clamps custom %s counts to 6–50 with identical points', (schemeId) => {
      for (const [requestedCount, expectedCount] of [[1, 6], [51, 50]]) {
        const request = { schemeId, count: requestedCount }
        const plan = buildSamplingPlan(reservoir, references, request)
        expect(plan.count).toBe(expectedCount)
        expect(plan).toEqual(mini.buildSamplingPlan(miniById.get(reservoir.id)!, request))
      }
    })
  })

  it('preserves source reference coordinates and filters them to the Henan sampling area', () => {
    const guxian = reservoirs.find((reservoir) => reservoir.id === 'HN_RSV_010')!
    const guxianPlan = buildSamplingPlan(guxian, references)
    expect(guxianPlan.source).toBe('reference')
    expect(guxianPlan.points[0].longitude).toBe(111.2791872)
    expect(guxianPlan.referenceBasis).toBe('用户提供的 GX.kml 点位')
    const danjiangkou = reservoirs.find((reservoir) => reservoir.id === 'HN_RSV_024')!
    const extendedReferences = { ...references, [danjiangkou.id]: {
      ...references[danjiangkou.id],
      points: [...references[danjiangkou.id].points, { name: 'outside-scope', longitude: 111, latitude: 32 }],
    } }
    const danjiangkouPlan = buildSamplingPlan(danjiangkou, extendedReferences)
    expect(danjiangkouPlan.source).toBe('reference')
    expect(danjiangkouPlan.referenceYear).toBe(2023)
    expect(danjiangkouPlan.count).toBe(references[danjiangkou.id].points.length)
    expect(danjiangkouPlan.points.some((point) => point.longitude === 111 && point.latitude === 32)).toBe(false)
    expect(danjiangkouPlan.scopeRetainedPct).toBeLessThan(99.95)
  })

  it('moves a point inside the reservoir, recalculates metrics, and exports the adjusted coordinates identically', () => {
    const reservoir = reservoirs.find((item) => item.id === 'HN_RSV_007')!
    const originalPlan = buildSamplingPlan(reservoir, references)
    const original = originalPlan.points[0]
    const longitude = original.longitude + 0.00001
    const latitude = original.latitude + 0.00001
    const moved = moveSamplingPoint(reservoir, originalPlan, original.id, longitude, latitude)
    const miniMoved = mini.moveSamplingPoint(miniById.get(reservoir.id)!, originalPlan, original.id, longitude, latitude)
    expect(moved).toEqual(miniMoved)
    expect(moved.points[0]).toMatchObject({ longitude, latitude, manuallyAdjusted: true })
    expect(moved.manualAdjustmentCount).toBe(1)
    expect(moved).not.toBe(originalPlan)
    expect(moved.points).not.toBe(originalPlan.points)
    expect(buildOviKml(reservoir, moved)).toContain(`${longitude.toFixed(8)},${latitude.toFixed(8)},0`)
    expect(buildOviKml(reservoir, moved)).toContain('1个点位已手动调整')
    expect(() => moveSamplingPoint(reservoir, originalPlan, original.id, 100, 20))
      .toThrow('点位必须保留在河南库区水面范围内')
  })
})
