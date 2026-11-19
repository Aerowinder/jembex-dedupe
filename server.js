// The whole app in one process, on plain node:http (lib/http.js): serves the UI from public/,
// keeps one file per server in CONFIG_DIR (/config in the image; ./config when run from
// a checkout), and proxies the scanner's requests to Jellyfin, Emby and Plex.
//
// API keys stay here. A saved key is never sent back to the browser: the browser names the
// server (type + URL) and the proxy adds the saved key itself.
//
// <CONFIG_DIR>/<type>_<host>_<port>.json   one file per server: URL, API key and ignored duplicates
// e.g. jellyfin_10.0.0.5_8096.json, or jellyfin_https_media.example.com.json for https://

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { normalizeServerUrl } from './public/js/servers/index.js';
import { HttpError, matchRoute, parseTarget, readJson, sendJson, sendText, serveStatic } from './lib/http.js';
import { RedirectError, SERVER_TYPES, UnreachableError, isAllowedPath, serverBaseUrl, upstreamFetch } from './lib/upstream.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const CONFIG_DIR = path.resolve(process.env.CONFIG_DIR || 'config');
const PUBLIC_DIR = await realpath(path.join(ROOT, 'public'));
const UPSTREAM_TIMEOUT_MS = 120_000;

// Optional (see README): the host names this app may be reached by, e.g. "nas.lan,192.168.1.10"
const hostKey = host => host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
const ALLOWED_HOSTS = new Set((process.env.ALLOWED_HOSTS || '').split(',')
    .map(entry => hostKey(entry.split(':').length === 2 ? entry.split(':')[0] : entry))
    .filter(Boolean));
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// On every response. The CSP allows only this app's own files: no inline code, no other sites.
const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; " +
        "form-action 'self'; frame-ancestors 'self'",
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
};

// Scripts, styles and the page are revalidated on every load, so an updated image takes
// effect immediately (unchanged files come back as a cheap 304)
const cacheControl = file => (/\.(js|css|html)$/.test(file) ? 'no-cache' : 'public, max-age=604800');

// ---------- Server files ----------
// One file per server: { serverType, serverUrl, apiKey, savedAt, ignored: [{ key, label, paths, ignoredAt }] }
// A server that isn't saved but has ignored duplicates has a file with no apiKey; it isn't
// listed as a saved server.

const TEMP_MARK = '.tmp-';

// jellyfin_10.0.0.5_8096 for http://, jellyfin_https_10.0.0.5_8096 for https://, so the two
// never share a file
function serverFileStem(serverType, serverUrl) {
    const url = normalizeServerUrl(serverUrl);
    const scheme = /^https:/i.test(url) ? 'https_' : '';
    return `${serverType}_${scheme}${url.replace(/^https?:\/\//i, '').replace(/[^a-zA-Z0-9.-]/g, '_')}`;
}
const serverFileName = (serverType, serverUrl) => `${serverFileStem(serverType, serverUrl)}.json`;
const isConfigFile = (serverType, filename) => filename.startsWith(`${serverType}_`) && filename.endsWith('.json');

// Writes go to a temp file that is then renamed over the target, so a crash or a stop
// mid-write never leaves a half-written file. Leftover temp files are removed at startup.
async function writeFileSafely(file, data) {
    const temp = `${file}${TEMP_MARK}${process.pid}-${randomUUID()}`;
    try {
        await writeFile(temp, data, { mode: 0o600 });
        await rename(temp, file);
    } catch (err) {
        await rm(temp, { force: true });
        throw err;
    }
}

// null if the file doesn't exist; an unreadable file counts as empty, with a warning
async function readServerFile(filename) {
    try {
        const data = JSON.parse(await readFile(path.join(CONFIG_DIR, filename), 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        console.warn(`Unreadable server file ${filename}: ${err.message}`);
        return {};
    }
}

const ignoredEntries = data => (Array.isArray(data?.ignored) ? data.ignored.filter(e => e && typeof e.key === 'string') : []);

// Every change to a server file goes through here, one at a time, so a save and two quick
// Ignore clicks can't overwrite each other. change(current or null) returns the new contents,
// or null to remove the file.
let writeQueue = Promise.resolve();
function updateServerFile(filename, change) {
    const run = writeQueue.then(async () => {
        const next = await change(await readServerFile(filename));
        const file = path.join(CONFIG_DIR, filename);
        if (next) await writeFileSafely(file, JSON.stringify(next, null, 2));
        else await rm(file, { force: true });
        forgetSavedServers();
        return next;
    });
    writeQueue = run.catch(() => {});
    return run;
}

// Reject unknown server types, and filenames that aren't one of that type's server files
// (which also rules out anything that could leave the config folder)
function checkParams({ serverType, filename }) {
    if (!SERVER_TYPES.includes(serverType)) throw new HttpError(400, 'Invalid server type');
    if (filename !== undefined && (filename !== path.basename(filename) || !isConfigFile(serverType, filename))) {
        throw new HttpError(400, 'Invalid config filename');
    }
}

function checkServerUrl(serverUrl) {
    try {
        serverBaseUrl(serverUrl);
    } catch (err) {
        throw new HttpError(400, err.message);
    }
}

// ---------- Saved servers ----------

// Every saved server (a file with a key), keys included: for use here only, never sent as-is
async function readAllSavedServers() {
    const files = (await readdir(CONFIG_DIR).catch(() => [])).filter(f => SERVER_TYPES.some(type => isConfigFile(type, f)));
    const configs = [];
    for (const filename of files) {
        const config = await readServerFile(filename);
        if (config?.apiKey) configs.push({ ...config, filename });
    }
    return configs;
}

// Saved servers are read on every proxied request (a Plex scan makes one per duplicate), so
// they're cached briefly. The app's own changes clear the cache; edits made by hand show up
// within a few seconds.
const SAVED_CACHE_MS = 3000;
let savedCache = null; // { at, configs: Promise }
function forgetSavedServers() { savedCache = null; }

async function readSavedServers(serverType) {
    if (!savedCache || Date.now() - savedCache.at > SAVED_CACHE_MS) {
        savedCache = { at: Date.now(), configs: readAllSavedServers() };
    }
    return (await savedCache.configs).filter(c => isConfigFile(serverType, c.filename));
}

async function findSavedServer(serverType, serverUrl) {
    const wanted = normalizeServerUrl(serverUrl);
    return (await readSavedServers(serverType)).find(c => typeof c.serverUrl === 'string' && normalizeServerUrl(c.serverUrl) === wanted);
}

async function listConfigs({ res, params }) {
    checkParams(params);
    const configs = await readSavedServers(params.serverType);
    sendJson(res, 200, configs.map(({ filename, serverType, serverUrl, savedAt }) => ({
        filename,
        displayName: serverUrl || filename.replace(/\.json$/, ''),
        serverType,
        serverUrl,
        savedAt,
        hasKey: true,
    })));
}

// Saving again replaces the URL and key, and keeps the ignore list
async function saveConfig({ req, res, params }) {
    checkParams(params);
    const { serverUrl, apiKey } = await readJson(req);
    if (typeof serverUrl !== 'string' || typeof apiKey !== 'string' || !serverUrl || !apiKey) {
        throw new HttpError(400, 'Server URL and API key are required');
    }
    checkServerUrl(serverUrl);
    const { serverType } = params;
    const filename = serverFileName(serverType, serverUrl);
    await updateServerFile(filename, current => ({
        serverType, serverUrl: normalizeServerUrl(serverUrl), apiKey, savedAt: new Date().toISOString(),
        ignored: ignoredEntries(current),
    }));
    sendJson(res, 200, { message: 'Config saved', filename });
}

// Removes the key. The ignore list stays, in case the server is saved again; with nothing
// ignored, the file goes.
async function deleteConfig({ res, params }) {
    checkParams(params);
    let found = false;
    await updateServerFile(params.filename, current => {
        found = Boolean(current?.apiKey);
        if (!current) return null;
        const ignored = ignoredEntries(current);
        return ignored.length ? { serverType: current.serverType, serverUrl: current.serverUrl, ignored } : null;
    });
    if (!found) throw new HttpError(404, 'Config not found');
    sendJson(res, 200, { message: 'Config deleted' });
}

// ---------- Media server proxy ----------
// GET /api/media/<path>?<query>, with the server in headers (kept out of access logs):
//   X-Server-Type, X-Server-Url, and X-Server-Key (optional: the saved key is used without it)
// Upstream errors come back as 502 { error, upstreamStatus }.

async function proxyMedia({ req, res, url, params }) {
    const serverType = req.headers['x-server-type'];
    const serverUrl = req.headers['x-server-url'];
    const upstreamPath = params.rest;

    if (!SERVER_TYPES.includes(serverType)) throw new HttpError(400, 'Invalid server type');
    if (!isAllowedPath(serverType, upstreamPath)) throw new HttpError(404, 'Not a scanner request');
    checkServerUrl(serverUrl);

    let apiKey = req.headers['x-server-key'];
    if (!apiKey) {
        apiKey = (await findSavedServer(serverType, serverUrl))?.apiKey;
        if (!apiKey) throw new HttpError(400, 'no API key given, and no saved server with this URL');
    }

    // Drop the upstream request if the browser cancels the scan
    const cancelled = new AbortController();
    res.on('close', () => cancelled.abort());
    const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);

    let upstream;
    try {
        upstream = await upstreamFetch({ serverType, serverUrl, apiKey }, upstreamPath, url.searchParams, signal);
    } catch (err) {
        if (cancelled.signal.aborted) return;
        if (err instanceof UnreachableError || err instanceof RedirectError) throw new HttpError(502, err.message);
        if (err.name === 'TimeoutError') throw new HttpError(504, 'the media server took too long to answer');
        throw err;
    }
    if (!upstream.ok) {
        await upstream.body?.cancel();
        return sendJson(res, 502, { error: `media server returned HTTP ${upstream.status}`, upstreamStatus: upstream.status });
    }
    // Always labelled JSON, whatever the media server said, and streamed rather than buffered
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    await pipeline(Readable.fromWeb(upstream.body), res).catch(() => { /* cancelled or cut off */ });
}

// ---------- Ignored duplicates ----------
// Kept in the server's file, saved or not

function ignoreFileFor(serverType, serverUrl) {
    try {
        serverBaseUrl(serverUrl);
    } catch {
        throw new HttpError(400, 'Invalid server URL');
    }
    return serverFileName(serverType, serverUrl);
}

function updateIgnored(serverType, serverUrl, change) {
    return updateServerFile(ignoreFileFor(serverType, serverUrl), current => {
        const ignored = change(ignoredEntries(current));
        if (current?.apiKey || ignored.length) return { ...current, serverType, serverUrl: current?.serverUrl || normalizeServerUrl(serverUrl), ignored };
        return null; // not saved, and nothing left to ignore
    });
}

async function listIgnored({ res, url, params }) {
    checkParams(params);
    const filename = ignoreFileFor(params.serverType, url.searchParams.get('serverUrl'));
    sendJson(res, 200, { entries: ignoredEntries(await readServerFile(filename)) });
}

async function addIgnored({ req, res, params }) {
    checkParams(params);
    const { serverUrl, key, label, paths } = await readJson(req);
    ignoreFileFor(params.serverType, serverUrl);
    if (typeof key !== 'string' || !key || !Array.isArray(paths) || !paths.every(p => typeof p === 'string')) {
        throw new HttpError(400, 'key and paths are required');
    }
    const entry = { key, label: String(label || key), paths, ignoredAt: new Date().toISOString() };
    await updateIgnored(params.serverType, serverUrl, entries => [...entries.filter(e => e.key !== key), entry]);
    sendJson(res, 200, { message: 'Ignored', entry });
}

async function removeIgnored({ req, res, params }) {
    checkParams(params);
    const { serverUrl, key } = await readJson(req);
    ignoreFileFor(params.serverType, serverUrl);
    if (typeof key !== 'string' || !key) throw new HttpError(400, 'key is required');
    await updateIgnored(params.serverType, serverUrl, entries => entries.filter(e => e.key !== key));
    sendJson(res, 200, { message: 'Restored' });
}

// ---------- Requests ----------

const ROUTES = [
    ['GET', '/api/configs/:serverType', listConfigs],
    ['POST', '/api/configs/:serverType', saveConfig],
    ['DELETE', '/api/configs/:serverType/:filename', deleteConfig],
    ['GET', '/api/media/*', proxyMedia],
    ['GET', '/api/ignored/:serverType', listIgnored],
    ['POST', '/api/ignored/:serverType', addIgnored],
    ['DELETE', '/api/ignored/:serverType', removeIgnored],
];

// SECURITY: browsers label every request with where it came from. Refuse API calls made by
// another site through the visitor's browser (to scan with saved keys, say, or change the
// ignore list). Requests typed into the address bar ("none") and non-browser clients (no
// header) are fine.
function refuseCrossSite(req) {
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') throw new HttpError(403, 'Cross-site requests are not allowed');
}

// SECURITY (optional): DNS rebinding lets a website point its own name at this server for a
// moment, so the browser counts the website's requests as same-site and the check above
// can't tell. With ALLOWED_HOSTS set, requests addressed to any other host name are refused.
// Loopback always works, so the container's health check does too.
function refuseUnknownHost(req) {
    if (!ALLOWED_HOSTS.size) return;
    const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d+)?$/i.exec(req.headers.host || '');
    const host = match && hostKey(match[1]);
    if (!host || !(ALLOWED_HOSTS.has(host) || LOOPBACK_HOSTS.has(host))) throw new HttpError(403, 'Host not allowed');
}

async function handle(req, res) {
    refuseUnknownHost(req);
    const url = parseTarget(req.url);
    // Path only: query strings and headers can carry server details
    if (url.pathname !== '/health') console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);

    if (url.pathname === '/health') return sendText(res, 200, 'healthy');

    if (url.pathname.startsWith('/api/')) {
        refuseCrossSite(req);
        const match = matchRoute(ROUTES, req.method, url.pathname);
        if (!match) throw new HttpError(404, 'Not found');
        if (!match.handler) {
            res.setHeader('Allow', match.allowed.join(', '));
            throw new HttpError(405, 'Method not allowed');
        }
        return match.handler({ req, res, url, params: match.params });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        throw new HttpError(405, 'Method not allowed');
    }
    if (!(await serveStatic(req, res, PUBLIC_DIR, url.pathname, cacheControl))) throw new HttpError(404, 'Not found');
}

const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    try {
        await handle(req, res);
    } catch (err) {
        if (res.headersSent) return res.destroy();
        if (err instanceof HttpError) {
            // The rest of an oversized body is never read, so don't reuse the connection
            if (err.status === 413) res.setHeader('Connection', 'close');
            return sendJson(res, err.status, { error: err.message });
        }
        // SECURITY: details go to the log, never to the browser
        console.error(`${req.method} ${req.url?.split('?')[0]} failed:`, err);
        sendJson(res, 500, { error: 'Internal error' });
    }
});

// ---------- Start ----------

// A write interrupted by a crash leaves only its temp file; the real file is intact
async function removeTempFiles() {
    for (const file of await readdir(CONFIG_DIR)) {
        if (file.includes(TEMP_MARK)) await rm(path.join(CONFIG_DIR, file), { force: true });
    }
}

await mkdir(CONFIG_DIR, { recursive: true });
await removeTempFiles();
server.on('error', err => {
    console.error(`Failed to start server on port ${PORT}: ${err.message}`);
    if (err.code === 'EACCES') console.error('Ports below 1024 need extra permissions here; set PORT to 1024 or above and map that port instead.');
    process.exit(1);
});
// No address: IPv6 and IPv4 both (just IPv4 where IPv6 is off), so "localhost" works either way
server.listen(PORT, () => {
    const hosts = ALLOWED_HOSTS.size ? `, allowed hosts: ${[...ALLOWED_HOSTS].join(', ')}` : '';
    console.log(`Jembex Dedupe on port ${PORT}, configs in ${CONFIG_DIR}${hosts}`);
});

// As the container's main process, node gets no default handling for these: exit promptly on
// `docker stop` instead of waiting to be killed. Writes are atomic, so none is left half-done.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
