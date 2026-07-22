import { sendJSON } from '../routes/helpers.js';
export function createRouter(routes) {
    return async (req, res) => {
        res.setHeader('X-Powered-By', 'OpenAB Webhook');
        const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        const { pathname } = url;
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        for (const route of routes) {
            const methods = Array.isArray(route.method) ? route.method : [route.method];
            if (!methods.includes(req.method))
                continue;
            const params = route.match(pathname);
            if (!params)
                continue;
            if (route.guard) {
                const actor = await route.guard(req, res);
                if (actor === null || actor === undefined)
                    return;
            }
            try {
                await route.handler(req, res, params, url);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                sendJSON(res, 500, { error: message || 'Internal server error' });
            }
            return;
        }
        sendJSON(res, 404, { error: 'Not found' });
    };
}
export function exactPath(path) {
    return (pathname) => (pathname === path ? {} : null);
}
export function regexPath(pattern) {
    return (pathname) => {
        const m = pathname.match(pattern);
        return m?.groups || (m ? {} : null);
    };
}
//# sourceMappingURL=router.js.map