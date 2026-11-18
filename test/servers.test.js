// Each server's client against a small fake server that enforces that API's rules. Requests
// carry the auth the backend's proxy adds (directTransport), so this covers both halves.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createClient as createBrowserClient } from '../public/js/servers/index.js';
import { directTransport } from '../lib/upstream.js';
import { findDuplicateGroups, EPISODES } from '../public/js/dedupe.js';

const KEY = 'secret-key';
const servers = [];

const createClient = (serverType, serverUrl, apiKey, { signal } = {}) =>
    createBrowserClient(serverType, directTransport({ serverType, serverUrl, apiKey }, signal));

async function fakeServer(handler) {
    const log = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        log.push({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers });
        const send = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(body === undefined ? '' : JSON.stringify(body));
        };
        handler(url, req, send);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return { url: `http://127.0.0.1:${server.address().port}`, log };
}
after(() => servers.forEach(s => s.close()));

// ---------- Jellyfin / Emby ----------

const mbSource = (path, width, codec, audio) => ({
    Path: path, Size: 1e9,
    MediaStreams: [{ Type: 'Video', Width: width, Height: width * 9 / 16, Codec: codec },
        { Type: 'Audio', Language: 'eng', Codec: audio, ChannelLayout: '5.1', IsDefault: true }],
});

const movies = [
    // stacked versions with different streams on one item
    { Id: 'heat', Name: 'Heat', ProductionYear: 1995, Path: '/m/Heat (1995)/a.mkv',
        MediaSources: [mbSource('/m/Heat (1995)/a.mkv', 3840, 'hevc', 'truehd'), mbSource('/m/Heat (1995)/b.mkv', 1920, 'h264', 'ac3')] },
    // separate items
    { Id: 'al1', Name: 'Alien', ProductionYear: 1979, Path: '/m/Alien (1979)/1.mkv', MediaSources: [mbSource('/m/Alien (1979)/1.mkv', 1920, 'h264', 'dts')] },
    { Id: 'al2', Name: 'Alien', ProductionYear: 1979, Path: '/m/Alien (1979)/2.mkv', MediaSources: [mbSource('/m/Alien (1979)/2.mkv', 1920, 'h264', 'dts')] },
    ...Array.from({ length: 7 }, (_, i) => ({ Id: `u${i}`, Name: `Unique ${i}`, ProductionYear: 2000, Path: `/m/u${i}.mkv`,
        MediaSources: [mbSource(`/m/u${i}.mkv`, 1280, 'h264', 'aac')] })),
];

const episodes = [
    { Id: 'e1', Name: 'Pilot', SeriesName: 'Lost', SeriesId: 's1', ParentIndexNumber: 1, IndexNumber: 1, Path: '/tv/Lost/S01E01.mkv', MediaSources: [mbSource('/tv/Lost/S01E01.mkv', 1920, 'h264', 'ac3')] },
    { Id: 'e2', Name: 'Pilot', SeriesName: 'Lost', SeriesId: 's1', ParentIndexNumber: 1, IndexNumber: 1, Path: '/tv/Lost/S01E01 4k.mkv', MediaSources: [mbSource('/tv/Lost/S01E01 4k.mkv', 3840, 'hevc', 'eac3')] },
    { Id: 'e3', Name: 'Ep 2', SeriesName: 'Lost', SeriesId: 's1', ParentIndexNumber: 1, IndexNumber: 2, Path: '/tv/Lost/S01E02.mkv', MediaSources: [mbSource('/tv/Lost/S01E02.mkv', 1920, 'h264', 'ac3')] },
];

// Serves movies or episodes by IncludeItemTypes, capping pages at pageSize
const mediaBrowserServer = ({ prefix = '', auth, pageSize = 500 }) => fakeServer((url, req, send) => {
    if (!url.pathname.startsWith(prefix)) return send(404);
    if (!auth(url, req)) return send(401);
    const route = url.pathname.slice(prefix.length);
    if (route === '/Library/VirtualFolders') {
        return send(200, [{ Name: 'Movies', CollectionType: 'movies', ItemId: 'lib1' }, { Name: 'Shows', CollectionType: 'tvshows', ItemId: 'lib2' },
            { Name: 'Music', CollectionType: 'music', ItemId: 'lib3' }]);
    }
    if (route === '/Items') {
        const list = url.searchParams.get('IncludeItemTypes') === 'Episode' ? episodes : movies;
        const start = Number(url.searchParams.get('StartIndex'));
        const limit = Math.min(Number(url.searchParams.get('Limit')), pageSize);
        return send(200, { Items: list.slice(start, start + limit), TotalRecordCount: list.length });
    }
    send(404);
});

test('Jellyfin 12: header auth on bare routes; movies and TV, counted, paged, with progress', async () => {
    const jf = await mediaBrowserServer({
        // legacy ?api_key= is ignored by Jellyfin 12; only the Authorization header counts
        auth: (url, req) => (req.headers.authorization || '').includes(`Token="${KEY}"`),
        pageSize: 4,
    });
    const client = createClient('jellyfin', jf.url + '/', KEY);
    const [moviesLib, tvLib, ...others] = await client.listLibraries();
    assert.deepEqual([moviesLib, tvLib], [{ id: 'lib1', name: 'Movies', kind: 'movies' }, { id: 'lib2', name: 'Shows', kind: 'tv' }]);
    assert.equal(others.length, 0, 'music libraries are left out');

    assert.equal(await client.countItems(moviesLib), movies.length);
    const countCall = jf.log.find(r => r.path === '/Items');
    assert.equal(countCall.query.get('Limit'), '1', 'count asks for 1 item, never 0');
    assert.equal(countCall.query.has('Fields'), false);

    const batches = [];
    const items = await client.listItems(moviesLib, n => batches.push(n));
    assert.deepEqual(batches, [4, 4, 2], 'keeps paging, one progress callback per page');
    assert.equal(items.length, movies.length);
    assert.ok(jf.log.every(r => r.method === 'GET' && !r.query.has('api_key') && !r.path.startsWith('/emby')));
    assert.deepEqual(jf.log.at(-1).query.get('Fields').split(','), ['Path', 'MediaSources', 'MediaStreams']);

    const groups = findDuplicateGroups(items);
    assert.deepEqual(groups.map(g => [g.title, g.files.length]), [['Alien', 2], ['Heat', 2]]);
    assert.deepEqual(groups[1].files.map(f => [f.videoCodec, f.audio]), [['hevc', 'eng TRUEHD 5.1'], ['h264', 'eng AC3 5.1']],
        'each version reports its own streams');

    const tvGroups = findDuplicateGroups(await client.listItems(tvLib), EPISODES);
    assert.deepEqual(tvGroups.map(g => [g.series, g.season, g.episode, g.files.length]), [['Lost', 1, 1, 2]]);
});

test('Emby: /emby prefix, key in the X-Emby-Token header (never the URL)', async () => {
    const emby = await mediaBrowserServer({ prefix: '/emby', auth: (url, req) => req.headers['x-emby-token'] === KEY });
    const client = createClient('emby', emby.url, KEY);
    const [library] = await client.listLibraries();
    assert.equal(findDuplicateGroups(await client.listItems(library)).length, 2);
    assert.ok(emby.log.every(r => !r.query.has('api_key')));
});

// ---------- Plex ----------

test('Plex: movies and TV from the listing; per-item details only for duplicates', async () => {
    const movieMedia = (id, file, width, videoCodec, audioCodec, channels) => ({
        id, width, height: width * 9 / 16, videoResolution: width >= 3840 ? '4k' : '1080', videoCodec, audioCodec, audioChannels: channels,
        Part: [{ file, size: 2e9 }],
    });
    const episodeMedia = (file, width) => ({ width, height: width * 9 / 16, videoCodec: 'h264', audioCodec: 'aac', audioChannels: 2, Part: [{ file, size: 1e9 }] });
    const sections = {
        1: { type: '1', items: [
            { ratingKey: '1', title: 'Heat', year: 1995, Media: [movieMedia(11, '/m/Heat/a.mkv', 3840, 'hevc', 'truehd', 8), movieMedia(12, '/m/Heat/b.mkv', 1920, 'h264', 'ac3', 6)] },
            { ratingKey: '2', title: 'Alien', year: 1979, Media: [movieMedia(21, '/m/Alien/1.mkv', 1920, 'h264', 'dts', 6)] },
            { ratingKey: '3', title: 'Alien', year: 1979, Media: [movieMedia(31, '/m/Alien/2.mkv', 1920, 'h264', 'dts', 6)] },
            { ratingKey: '4', title: 'Memento', year: 2000, Media: [movieMedia(41, '/m/Memento.mkv', 1920, 'h264', 'aac', 2)] },
        ] },
        2: { type: '4', items: [
            // Plex lists a double-episode file once per episode it holds: not a duplicate on its own
            { ratingKey: '5', title: 'Pilot (1)', grandparentTitle: 'Lost', grandparentRatingKey: '9', parentIndex: 1, index: 1, Media: [episodeMedia('/tv/Lost/S01E01-E02.mkv', 1920)] },
            { ratingKey: '6', title: 'Pilot (2)', grandparentTitle: 'Lost', grandparentRatingKey: '9', parentIndex: 1, index: 2, Media: [episodeMedia('/tv/Lost/S01E01-E02.mkv', 1920)] },
            { ratingKey: '7', title: 'Tabula Rasa', grandparentTitle: 'Lost', grandparentRatingKey: '9', parentIndex: 1, index: 3,
                Media: [episodeMedia('/tv/Lost/S01E03.mkv', 1920), episodeMedia('/tv/Lost/S01E03 720p.mkv', 1280)] },
        ] },
    };
    const plex = await fakeServer((url, req, send) => {
        if (req.headers['x-plex-token'] !== KEY) return send(401);
        if (url.pathname === '/library/sections') {
            return send(200, { MediaContainer: { Directory: [{ key: '1', title: 'Films', type: 'movie' }, { key: '2', title: 'TV', type: 'show' },
                { key: '3', title: 'Music', type: 'artist' }] } });
        }
        const section = sections[/^\/library\/sections\/(\d+)\/all$/.exec(url.pathname)?.[1]];
        if (section) {
            if (url.searchParams.get('type') !== section.type) return send(400);
            const start = Number(url.searchParams.get('X-Plex-Container-Start'));
            const size = Math.min(Number(url.searchParams.get('X-Plex-Container-Size')), 2); // server caps pages at 2
            const page = section.items.slice(start, start + size);
            return send(200, { MediaContainer: { size: page.length, totalSize: section.items.length, Metadata: page } });
        }
        const detail = /^\/library\/metadata\/(\d+)$/.exec(url.pathname);
        const meta = detail && structuredClone(sections[1].items.find(m => m.ratingKey === detail[1]));
        if (meta) {
            for (const m of meta.Media) {
                m.Part[0].Stream = [{ streamType: 1, codec: m.videoCodec }, { streamType: 2, codec: m.audioCodec, languageCode: 'eng', audioChannelLayout: '5.1(side)', selected: true }];
            }
            return send(200, { MediaContainer: { Metadata: [meta] } });
        }
        send(404);
    });

    const client = createClient('plex', plex.url, KEY);
    const libraries = await client.listLibraries();
    assert.deepEqual(libraries, [{ id: '1', name: 'Films', kind: 'movies' }, { id: '2', name: 'TV', kind: 'tv' }]);
    const [films, tv] = libraries;

    const items = await client.listItems(films);
    assert.equal(items.length, 4, 'all pages read');
    let groups = findDuplicateGroups(items);
    assert.deepEqual(groups.map(g => [g.title, g.files.length]), [['Alien', 2], ['Heat', 2]]);
    assert.equal(groups[1].files[1].audio, 'AC3 5.1', 'listing data is usable before enrich');

    const ids = new Set(groups.flatMap(g => g.files.map(f => f.itemId)));
    let ticks = 0;
    await client.enrich([...items.filter(i => ids.has(i.id)), { id: '999', title: 'gone', files: [] }], () => ticks++);
    const detailCalls = plex.log.filter(r => r.path.startsWith('/library/metadata/')).map(r => r.path).sort();
    assert.deepEqual(detailCalls, ['/library/metadata/1', '/library/metadata/2', '/library/metadata/3', '/library/metadata/999'], 'Memento never fetched');
    assert.equal(ticks, 4, 'progress still ticks when a lookup fails');
    groups = findDuplicateGroups(items);
    assert.deepEqual(groups[1].files.map(f => [f.videoCodec, f.audio]), [['hevc', 'eng TRUEHD 5.1'], ['h264', 'eng AC3 5.1']]);

    assert.equal(await client.countItems(tv), 3);
    const tvGroups = findDuplicateGroups(await client.listItems(tv), EPISODES);
    assert.deepEqual(tvGroups.map(g => [g.episode, g.title, g.files.length]), [[3, 'Tabula Rasa', 2]]);
});

// ---------- Errors and cancel ----------

test('errors explain themselves: bad key, unreachable server', async () => {
    const jf = await mediaBrowserServer({ auth: () => false });
    await assert.rejects(createClient('jellyfin', jf.url, 'nope').listLibraries(), /Listing libraries failed \(HTTP 401\) — check your API key/);
    await assert.rejects(createClient('jellyfin', 'http://127.0.0.1:1', KEY).listLibraries(), /could not reach http:\/\/127\.0\.0\.1:1/);
});

test('cancel stops paging and Plex detail lookups, rejecting with AbortError', async () => {
    const pages = [];
    let lookups = 0;
    const slow = await fakeServer((url, req, send) => {
        if (url.pathname === '/Items') {
            pages.push(url.searchParams.get('StartIndex'));
            // a big library, 2 items per page
            return setTimeout(() => send(200, { Items: movies.slice(0, 2), TotalRecordCount: 1000 }), 30);
        }
        lookups++;
        setTimeout(() => send(200, { MediaContainer: { Metadata: [] } }), 30);
    });

    const listing = new AbortController();
    let batches = 0;
    const list = createClient('jellyfin', slow.url, KEY, { signal: listing.signal })
        .listItems({ id: 'lib1', name: 'Movies', kind: 'movies' }, () => { if (++batches === 2) listing.abort(); });
    await assert.rejects(list, { name: 'AbortError' });

    const details = new AbortController();
    const items = Array.from({ length: 40 }, (_, i) => ({ id: String(i), title: `t${i}`, files: [] }));
    let done = 0;
    const enrich = createClient('plex', slow.url, KEY, { signal: details.signal })
        .enrich(items, () => { if (++done === 4) details.abort(); });
    await assert.rejects(enrich, { name: 'AbortError' });

    await new Promise(r => setTimeout(r, 100));
    assert.ok(pages.length <= 3, `paging stopped (${pages.length} page requests)`);
    assert.ok(lookups < 12, `only a handful of the 40 lookups were sent (${lookups})`);
});
