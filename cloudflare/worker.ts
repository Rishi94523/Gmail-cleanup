interface Env { ASSETS: { fetch: typeof fetch } }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return Response.json({ name: 'inboxclean', stage: 'public-product-preview', gmailConnected: false });
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return Response.json({ error: 'Public Gmail automation is in development. This deployment is an interactive product preview.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    const response = await env.ASSETS.fetch(request);
    const secured = new Response(response.body, response);
    secured.headers.set('X-Content-Type-Options', 'nosniff');
    secured.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    secured.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    secured.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return secured;
  }
};
