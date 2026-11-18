// Requests to Jellyfin, Emby and Plex, made from the container. This is the only code that
// handles API keys: the browser asks the backend for a path, and the backend adds the key
// using the server's own rules (public/js/servers/<server>.js).

import { SERVERS, SERVER_TYPES, ServerError, normalizeServerUrl } from '../public/js/servers/index.js';

export { SERVER_TYPES };

// The proxy forwards only the read-only calls the scanner makes (each server's allowedPaths),
// so it can't be used to reach anything else on the media server, or on the network.
export const isAllowedPath = (serverType, path) => SERVERS[serverType]?.allowedPaths.some(re => re.test(path)) ?? false;

export class UnreachableError extends Error {
    constructor(origin) {
        super(`could not reach ${origin} (wrong URL, or server down)`);
        this.origin = origin;
    }
}

// SECURITY: redirects are never followed. A redirect would carry the key header to wherever
// it points (fetch only drops Authorization, not X-Emby-Token or X-Plex-Token), so a server,
// or anything pretending to be one, could collect it. The usual innocent cause is a reverse
// proxy sending http:// to https://, so the error says which address to use instead.
export class RedirectError extends Error {
    constructor(location) {
        super(`the media server redirected to ${location || 'another address'}; use that address as the server URL`);
    }
}

// Throws for anything that isn't a plain http(s) URL
export function serverBaseUrl(serverUrl) {
    // normalizeServerUrl() adds http:// when there's no scheme; any other scheme is refused
    if (typeof serverUrl !== 'string' || /^(?!https?:)[a-z][a-z\d+.-]*:\/\//i.test(serverUrl.trim())) {
        throw new TypeError('Invalid server URL');
    }
    const base = normalizeServerUrl(serverUrl);
    let url;
    try { url = new URL(base); } catch { throw new TypeError('Invalid server URL'); }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) throw new TypeError('Invalid server URL');
    return base;
}

// params: a plain object or URLSearchParams. Resolves to the fetch Response.
export async function upstreamFetch({ serverType, serverUrl, apiKey }, path, params, signal) {
    const server = SERVERS[serverType];
    if (!server) throw new TypeError(`Unknown server type: ${serverType}`);
    const url = new URL(`${serverBaseUrl(serverUrl)}${server.pathPrefix}${path}`);
    for (const [k, v] of params instanceof URLSearchParams ? params : Object.entries(params || {})) {
        url.searchParams.set(k, v);
    }
    const headers = { Accept: 'application/json', ...server.authHeaders(apiKey) };
    let response;
    try {
        response = await fetch(url, { headers, signal, redirect: 'manual' });
    } catch (err) {
        if (err.name === 'AbortError' || err.name === 'TimeoutError') throw err;
        throw new UnreachableError(url.origin);
    }
    if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        let location = response.headers.get('location');
        try { location = location && new URL(location, url).origin; } catch { location = null; }
        throw new RedirectError(location);
    }
    return response;
}

// A transport for createClient() that calls the media server directly. The backend's
// proxy uses upstreamFetch(); this is for code (and tests) that run server-side.
export function directTransport(server, signal) {
    return {
        signal,
        async get(path, params, what) {
            let response;
            try {
                response = await upstreamFetch(server, path, params, signal);
            } catch (err) {
                if (err instanceof UnreachableError || err instanceof RedirectError) throw new Error(`${what} failed — ${err.message}`);
                throw err;
            }
            if (!response.ok) throw new ServerError(response.status, what);
            return response.json();
        },
    };
}
