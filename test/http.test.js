// lib/http.js on its own: static files from a planted folder, request bodies, URL parsing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { HttpError, MAX_BODY_BYTES, matchRoute, parseTarget, readJson, serveStatic } from '../lib/http.js';

let dir, root;

// root/ is the website; next to it, outside, are files that must never be served
before(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), 'jembex-static-')));
    root = path.join(dir, 'public');
    await mkdir(path.join(root, 'js'), { recursive: true });
    await writeFile(path.join(root, 'index.html'), '<h1>home</h1>');
    await writeFile(path.join(root, 'js', 'app.js'), 'export {};');
    await writeFile(path.join(root, '.env'), 'SECRET=1');                 // hidden file
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config.js'), 'secret');     // inside a hidden folder
    await writeFile(path.join(root, 'notes.json'), '{"secret":1}');     // a type that isn't served
    await writeFile(path.join(dir, 'outside.js'), 'secret');
    await writeFile(path.join(dir, 'public-evil.js'), 'secret');         // shares the root's name as a prefix
    await symlink(path.join(dir, 'outside.js'), path.join(root, 'escape.js'));
    await symlink(dir, path.join(root, 'up'));
    await symlink(path.join(root, 'js', 'app.js'), path.join(root, 'alias.js'));
});
after(() => rm(dir, { recursive: true, force: true }));

// A response stand-in that records what was sent
function fakeResponse() {
    const chunks = [];
    const res = new Writable({ write(chunk, enc, done) { chunks.push(chunk); done(); } });
    res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
    res.text = () => Buffer.concat(chunks).toString();
    return res;
}

async function serve(pathname, { method = 'GET', headers = {} } = {}) {
    const res = fakeResponse();
    const served = await serveStatic({ method, headers }, res, root, pathname, () => 'no-cache');
    return { served, status: res.status, headers: res.headers, body: res.text() };
}

test('static: serves files inside the root, with type, caching and 304s', async () => {
    const page = await serve('/');
    assert.deepEqual([page.status, page.body, page.headers['Content-Type']], [200, '<h1>home</h1>', 'text/html; charset=utf-8']);
    const script = await serve('/js/app.js');
    assert.equal(script.headers['Content-Type'], 'text/javascript; charset=utf-8');
    assert.equal(script.headers['Content-Length'], 10);

    const again = await serve('/js/app.js', { headers: { 'if-none-match': script.headers.ETag } });
    assert.deepEqual([again.status, again.body], [304, ''], 'unchanged file: 304, no body');
    const head = await serve('/js/app.js', { method: 'HEAD' });
    assert.deepEqual([head.status, head.body], [200, ''], 'HEAD: headers only');
    assert.equal((await serve('/alias.js')).body, 'export {};', 'a symlink to a file inside the root is fine');
    assert.equal((await serve('/up/public/index.html')).body, '<h1>home</h1>', 'out and back in again: still the same file');
});

test('static: nothing outside the root, hidden, or of another type is ever served', async () => {
    const refused = [
        '/../outside.js', '/..%2foutside.js', '/%2e%2e/outside.js', '/%2E%2E%2Foutside.js', '/js/..%2f..%2foutside.js',
        '/..%5coutside.js', '/js/%5c..%5c..%5coutside.js', '/%2e%2e%5coutside.js',
        '/../public-evil.js', '/escape.js', '/up/outside.js', '/up/public-evil.js',
        '/.env', '/%2eenv', '/.git/config.js', '/js/../.env',
        '/notes.json', '/index.html%00.js', '/js', '/js/', '//index.html', '/js//app.js',
    ];
    for (const pathname of refused) {
        const result = await serve(pathname);
        assert.equal(result.served, false, `${pathname} was served: ${result.body}`);
    }
    await assert.rejects(serve('/%E0%A4%A'), { status: 400 }, 'malformed escapes are a 400');
});

test('request targets: only paths on this server', () => {
    assert.equal(parseTarget('/a/b?x=1').pathname, '/a/b');
    assert.equal(parseTarget('//evil.com/x').host, 'localhost', '"//host/path" stays a path here');
    assert.equal(parseTarget('/@evil.com').host, 'localhost');
    for (const target of ['http://evil.com/', '*', 'evil.com', '']) {
        assert.throws(() => parseTarget(target), { status: 400 }, target);
    }
});

test('routing: params are decoded, the rest of the path is not; wrong method is told apart', () => {
    const routes = [['GET', '/api/files/:type/:file', 'a'], ['GET', '/api/media/*', 'b'], ['DELETE', '/api/files/:type/:file', 'c']];
    assert.deepEqual(matchRoute(routes, 'GET', '/api/files/x/a%20b.json'), { handler: 'a', params: { type: 'x', file: 'a b.json' } });
    assert.deepEqual(matchRoute(routes, 'GET', '/api/media/Items%2F..'), { handler: 'b', params: { rest: '/Items%2F..' } });
    assert.deepEqual(matchRoute(routes, 'PUT', '/api/files/x/y'), { allowed: ['GET', 'DELETE'] });
    assert.equal(matchRoute(routes, 'GET', '/api/files/x'), null);
    assert.equal(matchRoute(routes, 'GET', '/api/files/x/y/z'), null, 'no extra segments');
    assert.throws(() => matchRoute(routes, 'GET', '/api/files/x/%E0%A4%A'), { status: 400 });
});

test('request bodies: JSON objects only, size-limited', async () => {
    const request = (body, headers = { 'content-type': 'application/json' }) =>
        Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { headers });
    assert.deepEqual(await readJson(request('{"a":1}')), { a: 1 });
    assert.deepEqual(await readJson(request('{"a":1}', { 'content-type': 'Application/JSON; charset=utf-8' })), { a: 1 });

    const fails = [
        [request('{"a":1}', {}), 415, 'no content type'],
        [request('a=1', { 'content-type': 'application/x-www-form-urlencoded' }), 415, 'a form post'],
        [request('{"a":1}', { 'content-type': 'text/plain' }), 415, 'a plain-text post (the other kind a form can send)'],
        [request(undefined), 400, 'empty'],
        [request('{nope'), 400, 'not JSON'],
        [request('null'), 400, 'JSON, but not an object'],
        [request('[1]'), 400, 'an array'],
        [request('"x"'), 400, 'a string'],
        [request('{}', { 'content-type': 'application/json', 'content-length': String(MAX_BODY_BYTES + 1) }), 413, 'declared too large'],
        [request(`{"a":"${'x'.repeat(MAX_BODY_BYTES)}"}`), 413, 'too large, no length declared'],
    ];
    for (const [req, status, why] of fails) {
        await assert.rejects(readJson(req), err => err instanceof HttpError && err.status === status, why);
    }
});
