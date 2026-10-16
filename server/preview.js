import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };
export function createPreview({ directory = 'web/dist', port = Number(process.env.PORT || 8080), host = '0.0.0.0' } = {}) {
  const root = resolve(directory);
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!['GET', 'HEAD'].includes(req.method)) return json(405, { error: 'Method not allowed.' });
      if (['/healthz', '/api/health'].includes(url.pathname)) return json(200, { name: 'gmail-cleanup', stage: 'public-product-preview', gmailEnabled: false });
      if (/^\/(api|auth)(\/|$)/.test(url.pathname)) return json(503, { error: 'Public Gmail integration is in development. This preview does not access or modify email.' });
      const pathname = decodeURIComponent(url.pathname);
      if (pathname !== '/' && !pathname.startsWith('/assets/')) return json(404, { error: 'Not found.' });
      const file = resolve(root, pathname === '/' ? 'index.html' : `.${pathname}`);
      if (!file.startsWith(`${root}${sep}`)) return json(404, { error: 'Not found.' });
      const type = types[extname(file)]; if (!type) return json(404, { error: 'Not found.' });
      const content = await readFile(file);
      if (pathname.startsWith('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.writeHead(200, { 'Content-Type': type }); res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { return json(error.code === 'ENOENT' ? 404 : 400, { error: error.code === 'ENOENT' ? 'Not found.' : 'Invalid request.' }); }
  });
  return { server, start() { server.listen(port, host, () => console.log(`Gmail-cleanup product preview listening on port ${port}`)); }, close() { return new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createPreview(); app.start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
