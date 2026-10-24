// GET /api/image?u=<image url>  -> proxies an image so the browser can copy/download it
export async function onRequestGet({ request, env }) {
  if (env.APP_PASSWORD && request.headers.get('x-app-password') !== env.APP_PASSWORD)
    return new Response('Unauthorized', { status: 401 });

  const u = new URL(request.url).searchParams.get('u');
  try {
    const target = new URL(u);
    if (!/^https?:$/.test(target.protocol)) throw 0;
    const r = await fetch(target, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; PostWriter/1.0)' },
      signal: AbortSignal.timeout(10000),
    });
    const type = r.headers.get('content-type') || '';
    const size = Number(r.headers.get('content-length') || 0);
    if (!r.ok || !type.startsWith('image/') || size > 8e6) throw 0;
    return new Response(r.body, { headers: { 'content-type': type, 'cache-control': 'private, max-age=3600' } });
  } catch {
    return new Response('Bad image', { status: 400 });
  }
}
