// A small HTTP layer on node:http, in place of a framework: JSON responses, JSON request
// bodies, routing, and static files. Each security-sensitive rule is marked SECURITY, and
// test/http.test.js attacks each one.

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

// ---------- Responses ----------

export function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-store',
    });
    res.end(data);
}

export function sendText(res, status, text) {
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
    });
    res.end(text);
}

// ---------- Requests ----------

// SECURITY: parse the path against a fixed origin. Only origin-form targets ("/path?query")
// are accepted: "http://other/..." or "*" are refused, and "//evil.com/x" stays a path on
// this server instead of becoming a URL for another host. The Host header is never used.
export function parseTarget(target) {
    if (typeof target !== 'string' || !target.startsWith('/')) throw new HttpError(400, 'Bad request');
    return new URL(`http://localhost${target}`);
}

export const MAX_BODY_BYTES = 64 * 1024;

// SECURITY: JSON objects only, and at most MAX_BODY_BYTES. Requiring the JSON content type
// also blocks cross-site form posts: an HTML form can only send form or plain-text bodies,
// and a cross-site fetch with a JSON body needs a CORS preflight this server never approves.
export async function readJson(req) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'Expected a JSON body');
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        // Content-Length can be missing (chunked) or wrong, so count as well
        if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
        chunks.push(chunk);
    }
    let body;
    try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new HttpError(400, 'Invalid JSON');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Expected a JSON object');
    return body;
}

// ---------- Routing ----------
// A route is [method, pattern, handler]. Patterns are literal segments and :params (decoded);
// a final "*" matches the rest of the path, still URL-encoded, as params.rest.

function matchPattern(pattern, pathname) {
    const want = pattern.split('/');
    const got = pathname.split('/');
    const params = {};
    for (let i = 0; i < want.length; i++) {
        if (want[i] === '*') {
            params.rest = `/${got.slice(i).join('/')}`;
            return params;
        }
        if (i >= got.length) return null;
        if (want[i].startsWith(':')) {
            if (!got[i]) return null;
            try {
                params[want[i].slice(1)] = decodeURIComponent(got[i]);
            } catch {
                throw new HttpError(400, 'Malformed URL');
            }
        } else if (want[i] !== got[i]) {
            return null;
        }
    }
    return got.length === want.length ? params : null;
}

// { handler, params } for a match; { allowed } when only the method is wrong; null otherwise
export function matchRoute(routes, method, pathname) {
    const allowed = new Set();
    for (const [routeMethod, pattern, handler] of routes) {
        const params = matchPattern(pattern, pathname);
        if (!params) continue;
        if (routeMethod === method) return { handler, params };
        allowed.add(routeMethod);
    }
    return allowed.size ? { allowed: [...allowed] } : null;
}

// ---------- Static files ----------

// SECURITY: only these file types are ever served; anything else under the root is a 404
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};

// Serves a GET or HEAD for pathname (as in the URL, still encoded) from root, which must be
// a real path (no symlinks in it). Resolves to false when there is no such file to serve.
export async function serveStatic(req, res, root, pathname, cacheControl) {
    let relative;
    try {
        relative = decodeURIComponent(pathname);
    } catch {
        throw new HttpError(400, 'Malformed URL');
    }
    if (relative.endsWith('/')) relative += 'index.html';

    // SECURITY: no "..", hidden files (.git, .env), empty segments, backslashes or NUL bytes,
    // checked after decoding so "%2e%2e" and "%2f" can't sneak past
    const segments = relative.split('/').slice(1);
    if (segments.some(s => !s || s.startsWith('.') || /[\\\0]/.test(s))) return false;
    const type = CONTENT_TYPES[path.extname(relative).toLowerCase()];
    if (!type) return false;

    let file;
    let info;
    try {
        // SECURITY: resolve symlinks, then make sure the real file is still inside the root
        file = await realpath(path.join(root, ...segments));
        if (!file.startsWith(root + path.sep)) return false;
        info = await stat(file);
    } catch {
        return false;
    }
    if (!info.isFile()) return false;

    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const headers = {
        'Content-Type': type,
        'Cache-Control': cacheControl(relative),
        ETag: etag,
        'Last-Modified': info.mtime.toUTCString(),
    };
    const known = (req.headers['if-none-match'] || '').split(',').map(tag => tag.trim());
    if (known.includes(etag) || known.includes('*')) {
        res.writeHead(304, headers);
        res.end();
        return true;
    }
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (req.method === 'HEAD') {
        res.end();
        return true;
    }
    await pipeline(createReadStream(file), res).catch(() => { /* the browser went away */ });
    return true;
}
