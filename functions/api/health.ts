export const onRequestGet: PagesFunction = async () => new Response(JSON.stringify({
  status: 'ok', mode: 'cloudflare-static-observation-planner', version: '1.0.0', time_utc: new Date().toISOString(),
}), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
