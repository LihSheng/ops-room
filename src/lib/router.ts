import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJSON } from '../routes/helpers.js';

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  url: URL,
) => Promise<void>;

export interface RouteEntry {
  method: string | string[];
  match: (pathname: string) => Record<string, string> | null;
  guard?: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>;
  handler: RouteHandler;
}

const routeExtensions: RouteEntry[] = [];

export function registerRouteExtension(route: RouteEntry): void {
  if (!route || typeof route.match !== 'function' || typeof route.handler !== 'function') {
    throw new Error('invalid_route_extension');
  }
  if (routeExtensions.includes(route)) return;
  routeExtensions.push(route);
}

export function resetRouteExtensionsForTests(): void {
  routeExtensions.length = 0;
}

export function createRouter(routes: RouteEntry[]) {
  const routeTable = [...routeExtensions, ...routes];
  return async (
    req: IncomingMessage,
    res: ServerResponse,
  ) => {
    res.setHeader('X-Powered-By', 'OpenAB Webhook');

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    for (const route of routeTable) {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (!methods.includes(req.method!)) continue;

      const params = route.match(pathname);
      if (!params) continue;

      if (route.guard) {
        const actor = await route.guard(req, res);
        if (actor === null || actor === undefined) return;
      }

      try {
        await route.handler(req, res, params, url);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        sendJSON(res, 500, { error: message || 'Internal server error' });
      }
      return;
    }

    sendJSON(res, 404, { error: 'Not found' });
  };
}

export function exactPath(path: string) {
  return (pathname: string) => (pathname === path ? {} : null);
}

export function regexPath(pattern: RegExp) {
  return (pathname: string) => {
    const m = pathname.match(pattern);
    return m?.groups || (m ? {} : null);
  };
}
