// The whole app in one process, on plain node:http (lib/http.js): serves the UI from public/,
// keeps saved servers and ignore lists in serverconfig/ (in the working directory:
// /app/serverconfig in the image), and proxies the scanner's requests to Jellyfin, Emby and Plex.
//
// API keys stay here. A saved key is never sent back to the browser: the browser names the
// server (type + URL) and the proxy adds the saved key itself.
//
// serverconfig/<type>_<host>_<port>.json           saved server (URL + API key)
// serverconfig/<type>_<host>_<port>.ignored.json   duplicates the user chose to ignore
// e.g. jellyfin_10.0.0.5_8096.json, or jellyfin_https_media.example.com.json for https://

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { normalizeServerUrl } from './public/js/servers/index.js';
import { HttpError, matchRoute, parseTarget, readJson, sendJson, sendText, serveStatic } from './lib/http.js';
import { RedirectError, SERVER_TYPES, UnreachableError, isAllowedPath, serverBaseUrl, upstreamFetch } from './lib/upstream.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const SERVERCONFIG = path.resolve('serverconfig');
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

// ---------- Saved servers ----------

const IGNORED_SUFFIX = '.ignored.json';
const TEMP_MARK = '.tmp-';

// jellyfin_10.0.0.5_8096 for http://, jellyfin_https_10.0.0.5_8096 for https://, so the two
// never share a file
function serverFileStem(serverType, serverUrl) {
    const url = normalizeServerUrl(serverUrl);
    const scheme = /^https:/i.test(url) ? 'https_' : '';
    return `${serverType}_${scheme}${url.replace(/^https?:\/\//i, '').replace(/[^a-zA-Z0-9.-]/g, '_')}`;
}
const isConfigFile = (serverType, filename) =>
    filename.startsWith(`${serverType}_`) && filename.endsWith('.json') && !filename.endsWith(IGNORED_SUFFIX);

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

// Reject unknown server types, and filenames that aren't one of that type's saved servers
// (which also rules out anything that could leave the config folder)
function checkParams({ serverType, filename }) {
    if (!SERVER_TYPES.includes(serverType)) throw new HttpError(400, 'Invalid server type');
    if (filename !== undefined && (filename !== path.basename(filename) || !isConfigFile(serverType, filename))) {
        throw new HttpError(400, 'Invalid config filename');
    }
}

// Every saved server, keys included: for use here only, never sent as-is
async function readAllSavedServers() {
    const files = (await readdir(SERVERCONFIG).catch(() => [])).filter(f => SERVER_TYPES.some(type => isConfigFile(type, f)));
    const configs = [];
    for (const filename of files) {
        try {
            const config = JSON.parse(await readFile(path.join(SERVERCONFIG, filename), 'utf8'));
            if (config && typeof config === 'object') configs.push({ ...config, filename });
        } catch (err) {
            console.warn(`Skipping unreadable config ${filename}: ${err.message}`);
        }
    }
    return configs;
}

// Saved servers are read on every proxied request (a Plex scan makes one per duplicate), so
// they're cached briefly. The app's own changes clear the cache; edits made by hand show up
// within a few seconds.
const SAVED_CACHE_MS = 3000;
let savedCache = null; // { at, configs: Promise }
const forgetSavedServers = () => { savedCache = null; };

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
    sendJson(res, 200, configs.map(({ filename, serverType, serverUrl, savedAt, apiKey }) => ({
        filename,
        displayName: serverUrl || filename.replace(/\.json$/, ''),
        serverType,
        serverUrl,
        savedAt,
        hasKey: Boolean(apiKey),
    })));
}

async function saveConfig({ req, res, params }) {
    checkParams(params);
    const { serverUrl, apiKey } = await readJson(req);
    if (typeof serverUrl !== 'string' || typeof apiKey !== 'string' || !serverUrl || !apiKey) {
        throw new HttpError(400, 'Server URL and API key are required');
    }
    try {
        serverBaseUrl(serverUrl);
    } catch (err) {
        throw new HttpError(400, err.message);
    }
    const { serverType } = params;
    const filename = `${serverFileStem(serverType, serverUrl)}.json`;
    const config = { serverType, serverUrl: normalizeServerUrl(serverUrl), apiKey, savedAt: new Date().toISOString() };
    // An older file for the same address (named another way by an earlier version) is
    // replaced. Read fresh, not from the cache, so a file added by hand a moment ago counts.
    forgetSavedServers();
    const stale = (await readSavedServers(serverType)).filter(c => c.filename !== filename
        && typeof c.serverUrl === 'string' && normalizeServerUrl(c.serverUrl) === config.serverUrl);
    await writeFileSafely(path.join(SERVERCONFIG, filename), JSON.stringify(config, null, 2));
    await Promise.all(stale.map(c => rm(path.join(SERVERCONFIG, c.filename), { force: true })));
    forgetSavedServers();
    sendJson(res, 200, { message: 'Config saved', filename });
}

async function deleteConfig({ res, params }) {
    checkParams(params);
    try {
        // The server's ignore list stays, in case it's saved again
        await rm(path.join(SERVERCONFIG, params.filename));
    } catch (err) {
        if (err.code === 'ENOENT') throw new HttpError(404, 'Config not found');
        throw err;
    } finally {
        forgetSavedServers();
    }
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
    try {
        serverBaseUrl(serverUrl);
    } catch (err) {
        throw new HttpError(400, err.message);
    }

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
// One file per server, saved or not: { entries: [{ key, label, paths, ignoredAt }] }

const ignoreFile = (serverType, serverUrl) => path.join(SERVERCONFIG, `${serverFileStem(serverType, serverUrl)}${IGNORED_SUFFIX}`);

async function readIgnored(file) {
    try {
        const { entries } = JSON.parse(await readFile(file, 'utf8'));
        return Array.isArray(entries) ? entries.filter(e => e && typeof e.key === 'string') : [];
    } catch (err) {
        if (err.code !== 'ENOENT') console.warn(`Unreadable ignore list ${file}: ${err.message}`);
        return [];
    }
}

// Changes run one at a time, so two quick clicks can't overwrite each other
let ignoreQueue = Promise.resolve();
function updateIgnored(file, change) {
    const run = ignoreQueue.then(async () => {
        const entries = change(await readIgnored(file));
        await writeFileSafely(file, JSON.stringify({ entries }, null, 2));
        return entries;
    });
    ignoreQueue = run.catch(() => {});
    return run;
}

function ignoreFileFor(serverType, serverUrl) {
    try {
        serverBaseUrl(serverUrl);
    } catch {
        throw new HttpError(400, 'Invalid server URL');
    }
    return ignoreFile(serverType, serverUrl);
}

async function listIgnored({ res, url, params }) {
    checkParams(params);
    const file = ignoreFileFor(params.serverType, url.searchParams.get('serverUrl'));
    sendJson(res, 200, { entries: await readIgnored(file) });
}

async function addIgnored({ req, res, params }) {
    checkParams(params);
    const { serverUrl, key, label, paths } = await readJson(req);
    const file = ignoreFileFor(params.serverType, serverUrl);
    if (typeof key !== 'string' || !key || !Array.isArray(paths) || !paths.every(p => typeof p === 'string')) {
        throw new HttpError(400, 'key and paths are required');
    }
    const entry = { key, label: String(label || key), paths, ignoredAt: new Date().toISOString() };
    await updateIgnored(file, entries => [...entries.filter(e => e.key !== key), entry]);
    sendJson(res, 200, { message: 'Ignored', entry });
}

async function removeIgnored({ req, res, params }) {
    checkParams(params);
    const { serverUrl, key } = await readJson(req);
    const file = ignoreFileFor(params.serverType, serverUrl);
    if (typeof key !== 'string' || !key) throw new HttpError(400, 'key is required');
    await updateIgnored(file, entries => entries.filter(e => e.key !== key));
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

// Up to 2.0.x, saved servers lived in serverconfig/<type>/<host>_<port>.json
async function migrateOldLayout() {
    for (const type of SERVER_TYPES) {
        const dir = path.join(SERVERCONFIG, type);
        const files = await readdir(dir).catch(() => null);
        if (!files) continue;
        for (const file of files.filter(f => f.endsWith('.json'))) {
            // Name it the way a save would now, so saving the server again updates this file
            let target = path.join(SERVERCONFIG, `${type}_${file}`);
            try {
                const { serverUrl } = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
                if (serverUrl) target = path.join(SERVERCONFIG, `${serverFileStem(type, serverUrl)}.json`);
            } catch { /* unreadable: keep its name */ }
            if (await readFile(target).then(() => true, () => false)) {
                console.warn(`Not moving ${type}/${file}: ${path.basename(target)} already exists`);
                continue;
            }
            await rename(path.join(dir, file), target);
            console.log(`Moved ${type}/${file} to ${path.basename(target)}`);
        }
        await rmdir(dir).catch(() => { /* not empty: leave it */ });
    }
}

// A write interrupted by a crash leaves only its temp file; the real file is intact
async function removeTempFiles() {
    for (const file of await readdir(SERVERCONFIG)) {
        if (file.includes(TEMP_MARK)) await rm(path.join(SERVERCONFIG, file), { force: true });
    }
}

await mkdir(SERVERCONFIG, { recursive: true });
await removeTempFiles();
await migrateOldLayout();
server.on('error', err => {
    console.error(`Failed to start server on port ${PORT}: ${err.message}`);
    if (err.code === 'EACCES') console.error('Ports below 1024 need extra permissions here; set PORT to 1024 or above and map that port instead.');
    process.exit(1);
});
// No address: IPv6 and IPv4 both (just IPv4 where IPv6 is off), so "localhost" works either way
server.listen(PORT, () => {
    const hosts = ALLOWED_HOSTS.size ? `, allowed hosts: ${[...ALLOWED_HOSTS].join(', ')}` : '';
    console.log(`Jembex Dedupe on port ${PORT}, configs in ${SERVERCONFIG}${hosts}`);
});

// As the container's main process, node gets no default handling for these: exit promptly on
// `docker stop` instead of waiting to be killed. Writes are atomic, so none is left half-done.
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
