// Shared by every server: errors, URL clean-up, the browser's transport, and paging helpers.
//
// A transport carries a client's requests: { signal, get(path, params, what) → JSON }.
// In the browser it's proxyTransport(), which goes through this app's backend so the API
// key never has to be in the browser; server-side code uses directTransport() from
// lib/upstream.js. Aborting the signal cancels the scan: in-flight requests are dropped
// and every client method rejects with an AbortError.

export const PAGE_SIZE = 500;

export class ServerError extends Error {
    constructor(status, what) {
        const hint = status === 401 || status === 403 ? ' — check your API key / token' : '';
        super(`${what} failed (HTTP ${status})${hint}`);
        this.status = status;
    }
}

export function normalizeServerUrl(raw) {
    let url = (raw || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
    return url;
}

// server: { serverType, serverUrl, apiKey? }. Without apiKey, the backend uses the key
// saved for that server URL.
export function proxyTransport({ serverType, serverUrl, apiKey }, signal) {
    return {
        signal,
        async get(path, params, what) {
            const query = new URLSearchParams(params || {}).toString();
            const headers = { Accept: 'application/json', 'X-Server-Type': serverType, 'X-Server-Url': serverUrl };
            if (apiKey) headers['X-Server-Key'] = apiKey;
            let response;
            try {
                response = await fetch(`/api/media${path}${query ? `?${query}` : ''}`, { headers, signal });
            } catch (err) {
                if (err.name === 'AbortError') throw err;
                throw new Error(`${what} failed — lost connection to the Jembex Dedupe container`);
            }
            if (response.ok) return response.json();
            const body = await response.json().catch(() => ({}));
            if (body.upstreamStatus) throw new ServerError(body.upstreamStatus, what);
            throw new Error(`${what} failed — ${body.error || `HTTP ${response.status}`}`);
        },
    };
}

export async function mapLimit(values, limit, fn, signal) {
    const queue = [...values];
    const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) {
            signal?.throwIfAborted();
            await fn(queue.shift());
        }
    });
    await Promise.all(workers);
}
