import { requestHasValidSession, secureDynamicHeaders } from './_auth'

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  const isPublicFavicon = ['/favicon.png', '/favicon.ico'].includes(url.pathname) &&
    (context.request.method === 'GET' || context.request.method === 'HEAD')
  if (url.pathname === '/login' || isPublicFavicon ||
      (url.pathname === '/api/session' && context.request.method === 'POST')) return context.next()

  if (!await requestHasValidSession(context.request, context.env)) {
    if ((context.request.method === 'GET' || context.request.method === 'HEAD') &&
        (context.request.headers.get('Accept') ?? '').includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: secureDynamicHeaders(new Headers({ Location: `${url.origin}/login` })),
      })
    }
    return Response.json(
      { error: 'UNAUTHORIZED', message: '请先登录' },
      { status: 401, headers: { 'Cache-Control': 'private, no-store', 'WWW-Authenticate': 'Cookie' } },
    )
  }

  const response = await context.next()
  const protectedResponse = new Response(response.body, response)
  const canCache = (context.request.method === 'GET' || context.request.method === 'HEAD') &&
    (response.status === 200 || response.status === 304)
  const contentType = response.headers.get('Content-Type') ?? ''
  // Only versioned code is fresh without revalidation. Data must still pass
  // authentication and ETag revalidation so daily updates are visible on reopen.
  const isVersionedAsset = /^\/assets\/[^/]+-[\w-]{8}\.(js|css)$/.test(url.pathname) &&
    (response.status === 304 || /^(application\/javascript|text\/(javascript|css))\b/i.test(contentType))
  const isObservationData = /^\/data\/[^/]+\.(json|geojson)$/.test(url.pathname) &&
    (response.status === 304 || /^application\/(json|geo\+json)\b/i.test(contentType))
  protectedResponse.headers.set('Cache-Control', canCache && isVersionedAsset
    ? 'private, max-age=31536000, immutable'
    : canCache && isObservationData
      ? 'private, no-cache'
      : 'private, no-store, max-age=0')
  protectedResponse.headers.append('Vary', 'Cookie')
  protectedResponse.headers.append('Vary', 'Authorization')
  return protectedResponse
}
