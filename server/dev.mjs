import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { handleApi, MAX_REQUEST_BYTES, apiError } from './api.mjs';

const production = process.argv.includes('--production');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const webRoot = resolve('dist/client');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

async function staticResponse(url, method) {
  if (!production) return new Response('KIRA API is running. Open the Vite frontend on its configured port.', { status: 404 });
  if (!['GET', 'HEAD'].includes(method)) return new Response('Method not allowed', { status: 405 });
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch { return new Response('Bad path', { status: 400 }); }
  const file = resolve(webRoot, '.' + pathname);
  if (file !== webRoot && !file.startsWith(webRoot + sep)) return new Response('Not found', { status: 404 });
  let target = file;
  try { if (!(await stat(target)).isFile()) target = resolve(webRoot, 'index.html'); }
  catch { target = resolve(webRoot, 'index.html'); }
  try {
    const bytes = await readFile(target);
    return new Response(method === 'HEAD' ? null : bytes, {
      headers: { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': extname(target) === '.html' ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' }
    });
  } catch { return new Response('Build the app with npm run build first.', { status: 503 }); }
}

const server = http.createServer(async (incoming, outgoing) => {
  const controller = new AbortController();
  outgoing.on('close', () => { if (!outgoing.writableEnded) controller.abort(); });
  try {
    const forwardedProtocol = process.env.TRUST_PROXY === '1' ? String(incoming.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
    const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
    const url = new URL(incoming.url || '/', `${protocol}://${incoming.headers.host || 'localhost'}`);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of incoming) {
      bytes += chunk.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        outgoing.writeHead(413, { 'Content-Type': 'application/json' });
        outgoing.end(JSON.stringify({ error: { code: 'BODY_TOO_LARGE', message: 'The request is too large.', retryable: false } }));
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined && key.toLowerCase() !== 'x-kira-client-ip') headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    // Never trust a caller-supplied client IP in the standalone Node gateway.
    headers.set('x-kira-client-ip', incoming.socket.remoteAddress || 'local');
    if (process.env.TRUST_PROXY !== '1') {
      headers.delete('cf-connecting-ip');
      headers.delete('oai-authenticated-user-id');
    }
    const method = incoming.method || 'GET';
    const request = new Request(url, { method, headers, signal: controller.signal, ...(!['GET', 'HEAD'].includes(method) ? { body: Buffer.concat(chunks) } : {}) });
    const response = await handleApi(request, process.env, { clientIp: incoming.socket.remoteAddress || 'local' }) || await staticResponse(url, method);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!outgoing.headersSent) {
      const response = apiError('INTERNAL_ERROR', 'The KIRA server could not complete this request.', 500, true);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(await response.text());
    } else outgoing.end();
  }
});
server.listen(port, host, () => console.log(`KIRA ${production ? 'production app' : 'API'} listening on http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
