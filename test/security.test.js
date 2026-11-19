// Attacks on the running server: path tricks sent byte-for-byte, other websites using the
// API through a visitor's browser, leaks through errors and logs, and a hostile media server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { get, rawRequest, startServer } from './helpers.js';

const SAVED_KEY = 'SAVED-KEY-0123456789';
let app, hostile, hostileUrl;
const hostileLog = [];

before(async () => {
    // A "media server" that answers badly: HTML instead of JSON, and redirects
    hostile = http.createServer((req, res) => {
        hostileLog.push({ url: req.url, headers: req.headers });
        if (req.url.startsWith('/emby/Items')) {
            // to a path on itself, so a followed redirect would show up in the log
            res.writeHead(302, { Location: `${hostileUrl}/collect` });
            return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<script>alert(1)</script>');
    });
    await new Promise(resolve => hostile.listen(0, '127.0.0.1', resolve));
    hostileUrl = `http://127.0.0.1:${hostile.address().port}`;

    app = await startServer(async configDir => {
        await mkdir(configDir, { recursive: true });
        await writeFile(path.join(configDir, 'jellyfin_saved.json'),
            JSON.stringify({ serverType: 'jellyfin', serverUrl: 'http://10.1.2.3:8096', apiKey: SAVED_KEY }));
        // A directory where a config file should be: deleting it fails inside the server
        await mkdir(path.join(configDir, 'jellyfin_broken.json'));
    });
});
after(async () => {
    await app.stop();
    hostile.close();
});

const api = (method, route, { body, headers = {} } = {}) => fetch(`${app.url}${route}`, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
});

test('path tricks never reach server code, saved configs, or anything outside public/', async () => {
    const targets = [
        '/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/%2e%2e%2fserver.js', '/.%2e/server.js',
        '/js/..%2f..%2fserver.js', '/..%5cserver.js', '/js/%2e%2e%5c%2e%2e%5cserver.js', '/..;/server.js',
        '/lib/upstream.js', '/package.json', '/test/helpers.js', '/entrypoint.sh',
        '/../config/jellyfin_saved.json', '/..%2fconfig%2fjellyfin_saved.json', '/config/jellyfin_saved.json',
        '/../../../../../../etc/passwd', '/..%2f..%2f..%2f..%2f..%2fetc%2fpasswd', '//etc/passwd', '/%2fetc%2fpasswd',
        '/index.html%00', '/index.html%00.js', '/%E0%A4%A',
    ];
    for (const target of targets) {
        const { status, body } = await get(app.port, target);
        assert.ok(status === 404 || status === 400, `${target}: HTTP ${status}`);
        assert.doesNotMatch(body, /import |apiKey|SAVED-KEY|root:/, `${target} leaked content`);
    }

    // Request lines that aren't a plain path
    assert.equal((await get(app.port, `http://127.0.0.1:${app.port}/../server.js`)).status, 400, 'absolute URL');
    assert.equal((await get(app.port, '*')).status, 400);
    const protocolRelative = await get(app.port, '//evil.example/');
    assert.equal(protocolRelative.status, 404);
    assert.equal(protocolRelative.headers.location, undefined, 'never redirects to another host');

    const page = await get(app.port, '/');
    assert.equal(page.status, 200, 'the page itself still works');
});

test('other websites cannot use the API through a visitor\'s browser', async () => {
    for (const site of ['cross-site', 'same-site']) {
        const headers = { 'Sec-Fetch-Site': site };
        assert.equal((await api('GET', '/api/configs/jellyfin', { headers })).status, 403, `${site} read`);
        assert.equal((await api('POST', '/api/configs/jellyfin', { headers, body: { serverUrl: 'http://x', apiKey: 'k' } })).status, 403);
        assert.equal((await api('GET', '/api/media/Items', { headers: { ...headers, 'X-Server-Type': 'jellyfin', 'X-Server-Url': 'http://10.1.2.3:8096' } })).status, 403,
            'no scanning with the saved key');
        assert.equal((await api('DELETE', '/api/ignored/jellyfin', { headers, body: { serverUrl: 'http://x', key: 'k' } })).status, 403);
    }
    assert.equal((await api('GET', '/api/configs/jellyfin', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200, 'the app itself');
    assert.equal((await api('GET', '/api/configs/jellyfin', { headers: { 'Sec-Fetch-Site': 'none' } })).status, 200, 'typed into the address bar');

    // Older browsers without Sec-Fetch-Site: a cross-site form can only post form or text bodies
    const form = await fetch(`${app.url}/api/configs/jellyfin`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ serverUrl: 'http://evil', apiKey: 'k' }),
    });
    assert.equal(form.status, 415);
    assert.ok(!(await readdir(app.configDir)).some(f => f.includes('evil')), 'nothing saved');

    // ...and a JSON post needs a CORS preflight, which is never approved
    const preflight = await fetch(`${app.url}/api/configs/jellyfin`, {
        method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
});

test('every response carries the security headers', async () => {
    const responses = [
        await fetch(`${app.url}/`), await fetch(`${app.url}/js/app.js`), await fetch(`${app.url}/nope.html`),
        await api('GET', '/api/configs/jellyfin'), await api('PUT', '/api/configs/jellyfin'), await api('GET', '/api/nope'),
    ];
    for (const r of responses) {
        assert.match(r.headers.get('content-security-policy'), /default-src 'self'.*frame-ancestors 'self'/, r.url);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff', r.url);
        assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN', r.url);
        assert.equal(r.headers.get('access-control-allow-origin'), null, r.url);
    }
    assert.equal(responses[4].status, 405);
    assert.equal(responses[4].headers.get('allow'), 'GET, POST');
});

test('oversized bodies are refused without hurting the server', async () => {
    const big = JSON.stringify({ serverUrl: 'http://x', apiKey: 'k'.repeat(200_000) });
    const declared = await rawRequest(app.port, `POST /api/configs/jellyfin HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${big.length}\r\n\r\n${big}`);
    assert.equal(declared.status, 413);
    const chunked = await rawRequest(app.port, `POST /api/configs/jellyfin HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n` +
        `Transfer-Encoding: chunked\r\n\r\n${big.length.toString(16)}\r\n${big}\r\n0\r\n\r\n`);
    assert.equal(chunked.status, 413, 'no length declared');
    assert.equal((await fetch(`${app.url}/health`)).status, 200, 'still up');
});

test('keys and internals never show up in responses or logs', async () => {
    const typedKey = 'TYPED-KEY-9876543210';
    const responses = [
        await api('GET', '/api/configs/jellyfin'),
        await api('GET', '/api/media/Items?ParentId=QUERY-SECRET', { headers: { 'X-Server-Type': 'jellyfin', 'X-Server-Url': 'http://10.1.2.3:8096' } }),
        await api('GET', '/api/media/Items?ParentId=QUERY-SECRET', { headers: { 'X-Server-Type': 'jellyfin', 'X-Server-Url': 'http://127.0.0.1:1', 'X-Server-Key': typedKey } }),
        await api('POST', '/api/configs/jellyfin', { body: { serverUrl: 42, apiKey: typedKey } }),
        await api('GET', `/api/ignored/jellyfin?serverUrl=${encodeURIComponent('http://10.1.2.3:8096')}`),
    ];
    for (const r of responses) {
        const text = await r.text();
        assert.ok(!text.includes(SAVED_KEY) && !text.includes(typedKey), `${r.url} leaked a key: ${text}`);
    }
    assert.equal(responses[3].status, 400, 'wrong types are a 400, not a crash');

    // A failure inside the server: generic message, details only in the log
    const failure = await api('DELETE', '/api/configs/jellyfin/jellyfin_broken.json');
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { error: 'Internal error' });

    const logs = app.logs();
    assert.match(logs, /GET \/api\/media\/Items/, 'requests are logged');
    for (const secret of [SAVED_KEY, typedKey, 'QUERY-SECRET']) assert.ok(!logs.includes(secret), `the log contains ${secret}`);
});

test('ALLOWED_HOSTS: requests addressed to other host names are refused (DNS rebinding)', async () => {
    const hostRequest = (port, host) => rawRequest(port, `GET / HTTP/1.1\r\n${host === null ? '' : `Host: ${host}\r\n`}Connection: close\r\n\r\n`);
    assert.equal((await hostRequest(app.port, 'evil.example')).status, 200, 'without the setting, any host name works');

    const strict = await startServer(undefined, { ALLOWED_HOSTS: 'NAS.lan, 192.168.1.10:3369' });
    try {
        const allowed = ['nas.lan', 'nas.lan:3369', 'NAS.LAN.', '192.168.1.10', '192.168.1.10:80', '127.0.0.1', 'localhost:3369', '[::1]:3369'];
        for (const host of allowed) assert.equal((await hostRequest(strict.port, host)).status, 200, host);
        const refused = ['evil.example', 'nas.lan.evil.example', 'evil.example@nas.lan', 'nas.lan/x', '192.168.1.11', '[::2]', '', null];
        for (const host of refused) {
            const res = await hostRequest(strict.port, host);
            // Node itself refuses a missing Host header with 400 before the app sees it
            assert.ok(res.status === 403 || res.status === 400, `${host}: HTTP ${res.status}`);
        }
        // (fetch() can't set Host, so this is sent raw)
        const api = await rawRequest(strict.port, 'GET /api/configs/jellyfin HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
        assert.equal(api.status, 403, 'the API too');
        assert.equal((await fetch(`${strict.url}/health`)).status, 200, 'the health check (loopback) still works');
    } finally {
        await strict.stop();
    }
});

test('a hostile media server: answers are always served as JSON, redirects are never followed', async () => {
    const html = await api('GET', '/api/media/Library/VirtualFolders', { headers: { 'X-Server-Type': 'jellyfin', 'X-Server-Url': hostileUrl, 'X-Server-Key': 'k' } });
    assert.equal(html.headers.get('content-type'), 'application/json; charset=utf-8', 'the browser never treats it as a page');

    const before = hostileLog.length;
    const redirected = await api('GET', '/api/media/Items', { headers: { 'X-Server-Type': 'emby', 'X-Server-Url': hostileUrl, 'X-Server-Key': 'emby-key' } });
    assert.equal(redirected.status, 502);
    assert.match((await redirected.json()).error, new RegExp(`redirected to ${hostileUrl.replaceAll('.', '\\.')}; use that address`));
    assert.equal(hostileLog.length, before + 1, 'one request, not followed');
    assert.ok(!hostileLog.some(r => r.url.startsWith('/collect')), 'the key never went to the redirect target');
});
