import { validateApiRequest, operationFor } from './api-schema';
import { randomUUID } from 'node:crypto';
import { runUpstreamContext, dependencyHealth, upstreamMetrics } from './upstream';
import { conversionMetrics } from './media/conversions';
import { stateDatabase } from './state/database';
import { shutdownConversions } from './media/conversions';
import Fastify from 'fastify';
import { Readable } from 'node:stream';
import { HttpRequest, HttpResponse } from './http';
import { runRequest } from './request-context';
import { resolvePeer } from './identity';
import { authenticate } from './authenticate';
import { routes } from './routes';
import { JellyfinClient } from './lib/jellyfin';
import { getServerConfig } from './lib/config';
import { withJellyfinSession } from './lib/jellyfin-session';
import { withParentalControls } from './lib/parental-controls';
import openapi from '../contract/openapi.json';

type Handler = (request: HttpRequest, context: { params: Promise<Record<string, string | string[]>> }) => Promise<Response> | Response;
export function createApp() {
  // Disable automatic request logs: URLs may contain signed playback credentials.
  const app = Fastify({ logger: false, exposeHeadRoutes: false, bodyLimit: 50 * 1024 * 1024, requestTimeout: 60000 });
  const apiMetrics = { requests: 0, errors: 0, totalDurationMs: 0 };
  app.addHook('onRequest', async (request, reply) => { reply.header('x-request-id', randomUUID()); apiMetrics.requests++; (request as unknown as { started: number }).started = Date.now(); });
  app.addHook('onResponse', async (request, reply) => { apiMetrics.totalDurationMs += Date.now() - (request as unknown as { started: number }).started; if (reply.statusCode >= 500) apiMetrics.errors++; });
  const trustedProxies = (process.env.HOMESTREAM_TRUSTED_PROXIES || '').split(',').map(ip => ip.trim()).filter(Boolean);
  const allowProxyPairing = process.env.HOMESTREAM_ALLOW_PROXY_PAIRING === 'true';
  // Validate proxy configuration before listening.
  resolvePeer('127.0.0.1', new Headers(), trustedProxies);
  app.addHook('preClose', async () => { shutdownConversions(); });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  app.get('/health/live', async () => ({ status: 'ok', service: 'homestream-backend' }));
  app.get('/health/dependencies', async () => ({ dependencies: dependencyHealth() }));
  app.get('/health/metrics', async () => ({ api: apiMetrics, upstream: upstreamMetrics(), conversions: conversionMetrics() }));
  app.get('/health/ready', async (_request, reply) => {
    try { stateDatabase(); getServerConfig(); return { status: 'ready', apiVersion: 1 }; }
    catch { return reply.code(503).send({ status: 'unavailable' }); }
  });
  app.get('/openapi.json', async () => openapi);

  const catalogLinks = withJellyfinSession(withParentalControls(async (_request: HttpRequest) => {
    const jellyfin = new JellyfinClient();
    if (!jellyfin.isConfigured()) return HttpResponse.json({ items: [] });
    const [movies, series] = await Promise.all([jellyfin.getLatestMedia('Movie', 30), jellyfin.getLatestMedia('Series', 30)]);
    return HttpResponse.json({ items: [...movies, ...series] });
  }));

  function register(path: string, methods: string[], service: Record<string, unknown>, legacyPath = path) {
    for (const method of methods.includes('GET') && !methods.includes('HEAD') ? [...methods, 'HEAD'] : methods) app.route({
      method: method as 'GET', url: path,
      handler: async (incoming, reply) => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const peer = resolvePeer(incoming.raw.socket.remoteAddress || '', headers, trustedProxies, allowProxyPairing);
        headers.set('x-request-id',String(reply.getHeader('x-request-id')));
        headers.delete('x-homestream-socket'); headers.delete('x-homestream-proof');
        const controller = new AbortController();
        const onClose = () => { if (!reply.raw.writableFinished) controller.abort(); };
        incoming.raw.once('aborted', () => controller.abort());
        reply.raw.once('close', onClose);
        const host = headers.get('host') || 'localhost';
        const origin = process.env.HOMESTREAM_EXTERNAL_URL || `${incoming.protocol}://${host}`;
        const url = new URL(incoming.raw.url || '/', origin);
        // Canonical v1 endpoints execute the same services and policy as legacy routes.
        if (path.startsWith('/api/v1/')) url.pathname = url.pathname.replace(/^\/api\/v1\//, '/api/');
        const request = new HttpRequest(url, {
          method: incoming.method, headers, signal: controller.signal,
          body: ['GET', 'HEAD'].includes(incoming.method) ? undefined : incoming.body ? new Uint8Array(incoming.body as Buffer).buffer : undefined,
        });
        try {
          const response = await runUpstreamContext(() => runRequest(request, peer, async () => {
            const authorized = await authenticate(request);
            if (authorized instanceof HttpResponse) return authorized;
            const nativeProtected = authorized.nextUrl.pathname.startsWith('/api/mobile/v1/') && !operationFor(authorized.nextUrl.pathname,authorized.method)?.public;
            const invalid = nativeProtected ? undefined : await validateApiRequest(authorized);
            if (invalid) return invalid;
            const params = { ...incoming.params as Record<string, string | string[]> };
            if (typeof params['*'] === 'string') params.path = params['*'].split('/');
            const handler = service[incoming.method === 'HEAD' && !service.HEAD ? 'GET' : incoming.method] as Handler;
            // Use effective request context after authorization rewrites.
            return runRequest(authorized, peer, () => handler(authorized, { params: Promise.resolve(params) }));
          }));
          reply.code(response.status);
          for (const [name, value] of response.headers) if (name !== 'set-cookie') reply.header(name, value);
          const cookies = response.headers.getSetCookie();
          if (cookies.length) reply.header('set-cookie', cookies);
          if (!response.headers.has('cache-control')) reply.header('cache-control', 'no-store');
          reply.header('x-content-type-options', 'nosniff');
          if (incoming.method === 'HEAD') { await response.body?.cancel(); return reply.send(); }
          return reply.send(response.body ? Readable.fromWeb(response.body as import('node:stream/web').ReadableStream) : null);
        } catch (error) {
          // Do not log upstream error objects: they can include tokens or URLs.
          console.error('API request failed', { method: incoming.method, route: legacyPath, type: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, requestId: reply.getHeader('x-request-id') });
          return reply.code(500).header('cache-control', 'no-store').send({ error: 'API request failed' });
        }
      },
    });
  }
  for (const route of routes) {
    register(route.path, route.methods, route.service);
    if (!route.path.startsWith('/api/mobile/')) register(route.path.replace('/api/', '/api/v1/'), route.methods, route.service, route.path);
  }
  register('/api/catalog-links', ['GET'], { GET: catalogLinks });
  register('/api/v1/catalog-links', ['GET'], { GET: catalogLinks });
  return app;
}
