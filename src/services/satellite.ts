import type { SatellitePass } from '../types'

export const HJ_CCD_SENSOR = 'CCD1–CCD4 (16 m，四相机拼接)'

export function isSupportedObservationPass(pass: Pick<SatellitePass, 'satellite' | 'sensor'>) {
  if (!/^HJ/i.test(pass.satellite)) return true
  return /^HJ-?2B$/i.test(pass.satellite) && /CCD[1-4]?/i.test(pass.sensor)
}

export function normalizeObservationPass(pass: SatellitePass): SatellitePass {
  // Legacy payload name for the same four 16 m CCD cameras, not a different sensor.
  if (pass.satellite === 'HJ-2B' && pass.sensor === '16m WVC-2 (4-camera composite)') {
    return { ...pass, sensor: HJ_CCD_SENSOR }
  }
  return pass
}
