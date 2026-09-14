import { requestHasValidSession, secureDynamicHeaders } from './_auth'

export const onRequest: PagesFunction<Env> = async (context) => {
  const url = new URL(context.request.url)
  if (url.pathname === '/login') return context.next()

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
  protectedResponse.headers.set('Cache-Control', 'private, no-store, max-age=0')
  protectedResponse.headers.append('Vary', 'Cookie')
  return protectedResponse
}
