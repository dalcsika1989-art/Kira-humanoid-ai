import { handleApi } from './api.mjs';
import { STATIC_ASSETS } from 'kira:assets';

/** Standalone Worker entrypoint. scripts/build-server.mjs embeds Vite output. */
export default {
  async fetch(request, env, context) {
    const apiResponse = await handleApi(request, env, context);
    if (apiResponse) return apiResponse;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response('Invalid path', { status: 400 }); }
    const direct = Object.hasOwn(STATIC_ASSETS, pathname);
    const isDocument = request.headers.get('accept')?.includes('text/html') || pathname === '/';
    const asset = direct ? STATIC_ASSETS[pathname] : isDocument ? STATIC_ASSETS['/index.html'] : undefined;
    if (!asset) return new Response('Not found', { status: 404 });
    const headers = {
      'Content-Type': asset.type, ETag: asset.etag,
      'Cache-Control': direct && pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    };
    if (request.headers.get('if-none-match') === asset.etag) return new Response(null, { status: 304, headers });
    const body = request.method === 'HEAD' ? null : Uint8Array.from(atob(asset.data), value => value.charCodeAt(0));
    return new Response(body, { headers });
  },
};
