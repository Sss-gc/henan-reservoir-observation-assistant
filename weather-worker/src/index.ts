import {
  buildWeatherSnapshot, RESERVOIR_STATIONS, WEATHER_SNAPSHOT_KEY,
} from './nmc'

export async function refreshWeather(env: Env, now = new Date()) {
  const previous = await env.WEATHER_KV.get<import('./nmc').WeatherSnapshot>(WEATHER_SNAPSHOT_KEY, 'json')
  const snapshot = await buildWeatherSnapshot((milliseconds) => scheduler.wait(milliseconds), now, previous)
  await env.WEATHER_KV.put(WEATHER_SNAPSHOT_KEY, JSON.stringify(snapshot))
  console.log(JSON.stringify({
    event: 'weather_refresh_complete', reservoirs: 25,
    updatedReservoirs: 25 - snapshot.staleReservoirIds.length,
    staleReservoirs: snapshot.staleReservoirIds.length,
    stations: new Set(RESERVOIR_STATIONS.map((item) => item.slug)).size,
    generatedAt: snapshot.generatedAt,
  }))
  return snapshot
}

export default {
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await refreshWeather(env)
  },
}
