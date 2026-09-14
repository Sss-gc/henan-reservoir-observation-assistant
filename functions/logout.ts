import { expiredSessionCookie, isSameOriginFormPost, secureDynamicHeaders } from './_auth'

export const onRequestPost: PagesFunction<Env> = async ({ request }) => {
  if (!isSameOriginFormPost(request)) {
    return Response.json({ error: 'INVALID_ORIGIN' }, { status: 403, headers: secureDynamicHeaders() })
  }
  return new Response(null, {
    status: 204,
    headers: secureDynamicHeaders(new Headers({ 'Set-Cookie': expiredSessionCookie() })),
  })
}
