// The API, run as a real process (see helpers.js) in front of a fake Jellyfin.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { startServer } from './helpers.js';

const KEY = 'jf-secret';
let app, API, configDir, jellyfin, jellyfinUrl;
const jellyfinLog = [];

before(async () => {
    // Fake Jellyfin: header auth only
    jellyfin = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        jellyfinLog.push({ path: url.pathname, query: url.searchParams, headers: req.headers });
        const send = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body ?? {}));
        };
        if (!(req.headers.authorization || '').includes(`Token="${KEY}"`)) return send(401);
        if (url.pathname === '/Library/VirtualFolders') return send(200, [{ Name: 'Movies', CollectionType: 'movies', ItemId: 'lib1' }]);
        if (url.pathname === '/Items') return send(200, { Items: [], TotalRecordCount: Number(url.searchParams.get('Limit')) });
        send(404);
    });
    await new Promise(resolve => jellyfin.listen(0, '127.0.0.1', resolve));
    jellyfinUrl = `http://127.0.0.1:${jellyfin.address().port}`;

    // A 2.0.x install: one saved server per type folder
    app = await startServer(async dir => {
        await mkdir(path.join(dir, 'emby'), { recursive: true });
        await writeFile(path.join(dir, 'emby', '10.0.0.9_8096_.json'),
            JSON.stringify({ serverType: 'emby', serverUrl: 'http://10.0.0.9:8096/', apiKey: 'old' }));
        // left behind by a save that was interrupted
        await writeFile(path.join(dir, 'emby_10.0.0.9_8096.json.tmp-1-abc'), '{"half');
    });
    API = app.url;
    configDir = app.configDir;
});

after(async () => {
    await app.stop();
    jellyfin.close();
});

const json = (method, url, body) => fetch(`${API}${url}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
});
const post = (type, body) => json('POST', `/api/configs/${type}`, body);
const media = (route, server) => fetch(`${API}/api/media${route}`, {
    headers: Object.fromEntries(Object.entries({
        'X-Server-Type': server.type, 'X-Server-Url': server.url, 'X-Server-Key': server.key,
    }).filter(([, v]) => v !== undefined)),
});

test('startup: 2.0.x saved servers move out of their type folders; interrupted saves are cleared', async () => {
    const files = await readdir(configDir);
    assert.deepEqual(files, ['emby_10.0.0.9_8096.json'], 'type folder and temp file removed, file named from its URL');
    const list = await (await fetch(`${API}/api/configs/emby`)).json();
    assert.deepEqual(list.map(c => [c.serverUrl, c.hasKey]), [['http://10.0.0.9:8096/', true]]);
});

test('save, list and delete a server: files sit flat in serverconfig/, keys never come back', async () => {
    const saved = await (await post('jellyfin', { serverUrl: '10.0.0.5:8096/', apiKey: 'k' })).json();
    assert.equal(saved.filename, 'jellyfin_10.0.0.5_8096.json');
    assert.equal(saved.config, undefined, 'the save response has no key either');
    assert.equal(JSON.parse(await readFile(path.join(configDir, saved.filename), 'utf8')).apiKey, 'k');
    assert.equal((await stat(path.join(configDir, saved.filename))).mode & 0o777, 0o600, 'readable by the app only');

    const list = await (await fetch(`${API}/api/configs/jellyfin`)).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].apiKey, undefined);
    assert.equal(list[0].hasKey, true);
    assert.equal(list[0].serverUrl, 'http://10.0.0.5:8096');
    assert.equal(JSON.stringify(list).includes('"k"'), false);

    await writeFile(path.join(configDir, 'jellyfin_broken.json'), '{nope');
    assert.equal((await (await fetch(`${API}/api/configs/jellyfin`)).json()).length, 1, 'a corrupt file is skipped');

    assert.equal((await json('DELETE', `/api/configs/jellyfin/${saved.filename}`)).status, 200);
    assert.equal((await json('DELETE', `/api/configs/jellyfin/${saved.filename}`)).status, 404);
    assert.deepEqual(await (await fetch(`${API}/api/configs/jellyfin`)).json(), []);
});

test('saving: http:// and https:// get separate files; an older file for the same address is replaced', async () => {
    const plain = await (await post('plex', { serverUrl: 'http://10.0.0.7:32400', apiKey: 'a' })).json();
    const secure = await (await post('plex', { serverUrl: 'https://10.0.0.7:32400', apiKey: 'b' })).json();
    assert.deepEqual([plain.filename, secure.filename], ['plex_10.0.0.7_32400.json', 'plex_https_10.0.0.7_32400.json']);

    // e.g. from 2.0.x, saved with a trailing slash; added by hand just now, so not yet cached
    await writeFile(path.join(configDir, 'plex_old-name.json'), JSON.stringify({ serverType: 'plex', serverUrl: 'http://10.0.0.8:32400/', apiKey: 'old' }));
    await post('plex', { serverUrl: '10.0.0.8:32400', apiKey: 'new' });
    const files = (await readdir(configDir)).filter(f => f.startsWith('plex_'));
    assert.ok(!files.includes('plex_old-name.json'), 'the older file is gone');
    const list = await (await fetch(`${API}/api/configs/plex`)).json();
    assert.equal(list.filter(c => c.serverUrl === 'http://10.0.0.8:32400').length, 1, 'listed once');
});

test('listens on IPv6 as well as IPv4', async t => {
    const result = await new Promise(resolve => {
        const socket = net.connect({ host: '::1', port: app.port }, () => { socket.end(); resolve('connected'); });
        socket.on('error', err => resolve(err.code));
    });
    if (['EADDRNOTAVAIL', 'ENETUNREACH', 'EAFNOSUPPORT'].includes(result)) return t.skip('no IPv6 on this machine');
    assert.equal(result, 'connected');
});

test('bad input is rejected', async () => {
    assert.equal((await post('jellyfin')).status, 400, 'no body');
    assert.equal((await post('jellyfin', { serverUrl: 'x' })).status, 400, 'no key');
    assert.equal((await post('jellyfin', { serverUrl: 'http://exa mple', apiKey: 'k' })).status, 400, 'bad URL');
    assert.equal((await post('jellyfin', { serverUrl: 'ftp://nas', apiKey: 'k' })).status, 400, 'not http(s)');
    assert.equal((await fetch(`${API}/api/configs/..%2F..%2Fetc`)).status, 400, 'bad server type');
    assert.equal((await json('DELETE', '/api/configs/jellyfin/..%2F..%2Fserver.js')).status, 400, 'path traversal');
    assert.equal((await json('DELETE', '/api/configs/plex/jellyfin_broken.json')).status, 400, "another type's file");
    assert.equal((await json('DELETE', '/api/configs/jellyfin/jellyfin_x.ignored.json')).status, 400, 'an ignore list');
});

test('proxy: the saved key is used when none is typed; a typed key wins; the query is forwarded', async () => {
    await post('jellyfin', { serverUrl: jellyfinUrl, apiKey: KEY });
    const response = await media('/Library/VirtualFolders', { type: 'jellyfin', url: jellyfinUrl });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map(f => f.Name), ['Movies']);
    assert.ok(jellyfinLog.at(-1).headers.authorization.includes(`Token="${KEY}"`));

    const ok = await media('/Items?ParentId=lib1&Limit=7', { type: 'jellyfin', url: jellyfinUrl });
    assert.equal((await ok.json()).TotalRecordCount, 7);
    assert.equal(jellyfinLog.at(-1).query.get('ParentId'), 'lib1');

    const typed = await media('/Items', { type: 'jellyfin', url: jellyfinUrl, key: 'typed' });
    assert.equal(typed.status, 502);
    assert.deepEqual(await typed.json(), { error: 'media server returned HTTP 401', upstreamStatus: 401 });
});

test('proxy: only scanner requests, only to http(s) servers; unreachable servers are reported', async () => {
    const before = jellyfinLog.length;
    assert.equal((await media('/Users', { type: 'jellyfin', url: jellyfinUrl })).status, 404, 'not a scanner path');
    assert.equal((await media('/Items/abc/Delete', { type: 'jellyfin', url: jellyfinUrl })).status, 404);
    assert.equal((await media('/Items', { type: 'nope', url: jellyfinUrl })).status, 400);
    assert.equal((await media('/Items', { type: 'jellyfin', url: 'file:///etc/passwd', key: 'k' })).status, 400);
    assert.equal((await media('/Items', { type: 'jellyfin', url: 'gopher://x', key: 'k' })).status, 400);
    assert.equal((await media('/Items', { type: 'jellyfin', url: 'http://10.9.9.9:1' })).status, 400, 'no key and nothing saved');
    assert.equal(jellyfinLog.length, before, 'none of these reached the media server');

    const unreachable = await media('/Items', { type: 'jellyfin', url: 'http://127.0.0.1:1', key: 'k' });
    assert.equal(unreachable.status, 502);
    assert.match((await unreachable.json()).error, /could not reach http:\/\/127\.0\.0\.1:1/);
});

test('ignore list: add, replace, list, restore', async () => {
    const url = `/api/ignored/jellyfin`;
    const list = async () => (await (await fetch(`${API}${url}?serverUrl=${encodeURIComponent(jellyfinUrl)}`)).json()).entries;
    assert.deepEqual(await list(), []);

    const add = (key, paths) => json('POST', url, { serverUrl: jellyfinUrl, key, label: key, paths });
    assert.equal((await add('movies:Heat_1995', ['/a', '/b'])).status, 200);
    assert.equal((await add('movies:Heat_1995', ['/a', '/c'])).status, 200);
    await Promise.all([add('movies:Alien_1979', ['/x']), add('tv:9|1|3', ['/y'])]);
    const entries = await list();
    assert.deepEqual(entries.map(e => [e.key, e.paths]).sort(),
        [['movies:Alien_1979', ['/x']], ['movies:Heat_1995', ['/a', '/c']], ['tv:9|1|3', ['/y']]], 'replaced, and parallel adds both kept');

    assert.equal((await json('DELETE', url, { serverUrl: jellyfinUrl, key: 'movies:Heat_1995' })).status, 200);
    assert.deepEqual((await list()).map(e => e.key).sort(), ['movies:Alien_1979', 'tv:9|1|3']);

    const files = await readdir(configDir);
    assert.ok(files.includes(`jellyfin_127.0.0.1_${new URL(jellyfinUrl).port}.ignored.json`), 'stored next to the saved server');
    assert.equal((await json('POST', url, { serverUrl: jellyfinUrl, key: 'k' })).status, 400, 'paths required');
    assert.equal((await json('POST', '/api/ignored/jellyfin', { serverUrl: 'javascript:x', key: 'k', paths: [] })).status, 400);
});

test('the UI is served; server code and saved configs are not', async () => {
    const page = await fetch(`${API}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>/);
    const script = await fetch(`${API}/js/app.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('cache-control'), 'no-cache', 'updates take effect immediately');
    assert.equal(script.headers.get('x-content-type-options'), 'nosniff');
    for (const p of ['/server.js', '/lib/upstream.js', '/package.json', '/serverconfig/emby_10.0.0.9_8096.json', '/emby_10.0.0.9_8096.json']) {
        assert.equal((await fetch(`${API}${p}`)).status, 404, p);
    }
    assert.equal((await json('DELETE', '/api/delete-file')).status, 404, 'removed endpoints stay removed');
});
