// Generated from src/services/satellite.ts.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HJ_CCD_SENSOR = void 0;
exports.isSupportedObservationPass = isSupportedObservationPass;
exports.normalizeObservationPass = normalizeObservationPass;
exports.HJ_CCD_SENSOR = 'CCD1–CCD4 (16 m，四相机拼接)';
function isSupportedObservationPass(pass) {
    if (!/^HJ/i.test(pass.satellite))
        return true;
    return /^HJ-?2B$/i.test(pass.satellite) && /CCD[1-4]?/i.test(pass.sensor);
}
function normalizeObservationPass(pass) {
    // Legacy payload name for the same four 16 m CCD cameras, not a different sensor.
    if (pass.satellite === 'HJ-2B' && pass.sensor === '16m WVC-2 (4-camera composite)') {
        return { ...pass, sensor: exports.HJ_CCD_SENSOR };
    }
    return pass;
}
