// Duplicate detection, ignores, formatting and exports: pure functions, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyIgnores, effectiveYear, findDuplicateGroups, groupFileIds, EPISODES } from '../public/js/dedupe.js';
import { formatAudio, formatFileSize, formatResolution, formatTimeLeft } from '../public/js/format.js';
import { resultsAsCsv, resultsAsJson } from '../public/js/results.js';

const file = (path, width, size = 1) => ({ path, width, height: width ? Math.round(width * 9 / 16) : undefined, size });
const item = (id, title, year, ...files) => ({ id, title, year, path: files[0]?.path, files });
const ep = (id, series, season, episode, path, width, extra = {}) =>
    ({ id, title: `Episode ${episode}`, series, seriesId: extra.seriesId ?? series, season, episode, path, files: [file(path, width)], ...extra });

// ---------- Movies ----------

test('movies: separate items and stacked versions are both duplicates, best copy first', () => {
    const groups = findDuplicateGroups([
        item('a', 'Heat', 1995, file('/m/Heat (1995)/a.mkv', 1920)),
        item('b', 'Heat', 1995, file('/m/Heat (1995)/b.mkv', 3840)),
        item('c', 'Alien', 1979, file('/m/Alien (1979)/c.mkv', 1920), file('/m/Alien (1979)/d.mkv', 1280)),
        item('e', 'Memento', 2000, file('/m/Memento (2000)/e.mkv', 1920)),
    ]);
    assert.deepEqual(groups.map(g => [g.title, g.files.map(f => f.path.slice(-5))]),
        [['Alien', ['c.mkv', 'd.mkv']], ['Heat', ['b.mkv', 'a.mkv']]], 'sorted by title; highest resolution first');
});

test('movies: what is not a duplicate', () => {
    const same = file('/m/Heat (1995)/a.mkv', 1920);
    assert.equal(findDuplicateGroups([item('a', 'Heat', 1995, same), item('b', 'Heat', 1995, same)]).length, 0,
        'one file listed twice');
    assert.equal(findDuplicateGroups([
        item('a', 'Alien', 1979, file('/m/a.mkv', 1920)),
        item('b', 'Aliens', 1979, file('/m/b.mkv', 1920)),
        item('c', '', 1979, file('/m/c.mkv', 1920)),
        item('d', '  ', 1979, file('/m/d.mkv', 1920)),
    ]).length, 0, 'different or missing titles');
});

test('movies: a bracketed year in the path keeps remakes apart; numbers in titles are not years', () => {
    const groups = findDuplicateGroups([
        item('a', 'Dune', 2021, file('/m/Dune (1984)/a.mkv', 1920)),
        item('b', 'Dune', 2021, file('/m/Dune (2021)/b.mkv', 3840)),
    ]);
    assert.equal(groups.length, 0, 'remakes');

    const year = (path, metadataYear) => effectiveYear({ path, year: metadataYear });
    assert.equal(year('/m/Dune (1984)/a.mkv', 2021), 1984, 'bracketed year beats the metadata');
    assert.equal(year('/m/2001 A Space Odyssey (1968)/2001 A Space Odyssey (1968).mkv', 1968), 1968);
    assert.equal(year('/m/1917 (2019)/1917 (2019).mkv', 2019), 2019);
    assert.equal(year('/m/2001 A Space Odyssey/2001 A Space Odyssey.mkv', 1968), 1968, 'title number, no year in the path');
    assert.equal(year('/m/Death Race 2000/Death.Race.2000.mkv', 1975), 1975, 'a number mid-title');
    assert.equal(year('/m/2001.A.Space.Odyssey.1968.1080p.mkv', undefined), 1968, 'a loose year fills in a missing one');
    assert.equal(year('/m/1917/1917.mkv', undefined), undefined, "...but a title's leading number never does");
    assert.equal(year('/m/Movie [2019]/Movie.2160p.x264.mkv', undefined), 2019, 'resolutions and codecs are not years');

    // A copy named with the title's number first still matches one named the usual way
    assert.equal(findDuplicateGroups([
        item('c', '2001: A Space Odyssey', 1968, file('/m/2001 A Space Odyssey (1968)/c.mkv', 1920)),
        item('d', '2001: A Space Odyssey', 1968, file('/m/2001.A.Space.Odyssey.1968.mkv', 3840)),
    ]).length, 1);
});

test('movies: titles match regardless of case, accents and punctuation', () => {
    const groups = findDuplicateGroups([
        item('a', 'The Matrix', 1999, file('/m/a.mkv', 1920)),
        item('b', 'The matrix', 1999, file('/m/b.mkv', 1280)),
        item('c', 'The Matrix:', 1999, file('/m/c.mkv', 1280)),
        item('d', 'Amélie', 2001, file('/m/d.mkv', 1920)),
        item('e', 'Amelie', 2001, file('/m/e.mkv', 1920)),
        item('f', 'Spider-Man', 2002, file('/m/f.mkv', 1920)),
        item('g', 'Spider Man', 2002, file('/m/g.mkv', 1920)),
    ]);
    assert.deepEqual(groups.map(g => [g.title, g.files.length]), [['Amélie', 2], ['Spider-Man', 2], ['The Matrix', 3]],
        'the title shown is the first one seen');
});

// ---------- Episodes ----------

test('episodes: match on show ID + season + episode', () => {
    const groups = findDuplicateGroups([
        ep('a', 'The Office', 2, 5, '/tv/Office/S02/S02E05 720p.mkv', 1280),
        ep('b', 'The Office', 2, 5, '/tv/Office/S02/S02E05 1080p.mkv', 1920),
        ep('c', 'The Office', 2, 6, '/tv/Office/S02/S02E06.mkv', 1920),
        ep('d', 'The Office', 3, 5, '/tv/Office/S03/S03E05.mkv', 1920),
        // same name, different show
        ep('uk', 'The Office', 1, 1, '/tv/Office (UK)/S01E01.mkv', 1920, { seriesId: 'uk' }),
        ep('us', 'The Office', 1, 1, '/tv/Office (US)/S01E01.mkv', 1920, { seriesId: 'us' }),
    ], EPISODES);
    assert.equal(groups.length, 1);
    assert.deepEqual([groups[0].series, groups[0].season, groups[0].episode, groups[0].title], ['The Office', 2, 5, 'Episode 5']);
    assert.deepEqual(groups[0].files.map(f => f.itemId), ['b', 'a']);
});

test('episodes: a double-episode file overlaps only the episodes it covers', () => {
    const items = [
        ep('dbl', 'Lost', 1, 1, '/tv/Lost/S01E01-E02.mkv', 1920, { episodeEnd: 2, title: 'Pilot (1) & (2)' }),
        ep('e1', 'Lost', 1, 1, '/tv/Lost/S01E01.mkv', 1280, { title: 'Pilot (1)' }),
        ep('e3', 'Lost', 1, 3, '/tv/Lost/S01E03.mkv', 1920),
    ];
    const groups = findDuplicateGroups(items, EPISODES);
    assert.equal(groups.length, 1, 'E01 is duplicated; E02 exists only inside the double file');
    assert.equal(groups[0].episode, 1);
    assert.equal(groups[0].title, 'Pilot (1)', 'title comes from the single-episode file');
    assert.deepEqual(groups[0].files.map(f => f.note), ['S01E01–E02', undefined]);
    assert.equal(findDuplicateGroups([items[0]], EPISODES).length, 0, 'a double file alone is not a duplicate');
});

test('episodes: unidentified episodes are skipped; specials count; sorted by show, season, episode', () => {
    const two = (series, s, e) => [ep(`${series}${s}${e}a`, series, s, e, `/tv/${series}/${s}x${e}a.mkv`, 1920),
        ep(`${series}${s}${e}b`, series, s, e, `/tv/${series}/${s}x${e}b.mkv`, 1280)];
    const groups = findDuplicateGroups([
        ...two('Lost', 2, 1), ...two('Fargo', 1, 10), ...two('Lost', 0, 1), ...two('Fargo', 1, 2),
        ep('u1', 'Lost', 1, undefined, '/tv/Lost/unknown1.mkv', 1920),
        ep('u2', 'Lost', 1, undefined, '/tv/Lost/unknown2.mkv', 1920),
    ], EPISODES);
    assert.deepEqual(groups.map(g => `${g.series} ${g.season}x${g.episode}`), ['Fargo 1x2', 'Fargo 1x10', 'Lost 0x1', 'Lost 2x1']);
});

// ---------- Ignores ----------

test('ignored groups are hidden until a new copy appears', () => {
    const heat = [item('a', 'Heat', 1995, file('/m/Heat/a.mkv', 1920)), item('b', 'Heat', 1995, file('/m/Heat/b.mkv', 3840))];
    const alien = [item('c', 'Alien', 1979, file('/m/Alien/c.mkv', 1920)), item('d', 'Alien', 1979, file('/m/Alien/d.mkv', 1920))];
    const groups = findDuplicateGroups([...heat, ...alien]);
    const heatGroup = groups.find(g => g.title === 'Heat');
    const entries = [{ key: `movies:${heatGroup.key}`, paths: groupFileIds(heatGroup) }];

    const { shown, ignored } = applyIgnores(groups, entries, 'movies');
    assert.deepEqual(shown.map(g => g.title), ['Alien']);
    assert.deepEqual(ignored.map(g => g.title), ['Heat']);
    assert.deepEqual(groups.map(g => g.order), [0, 1], 'each group remembers its place');

    const withNewCopy = findDuplicateGroups([...heat, item('e', 'Heat', 1995, file('/m/Heat/e.mkv', 1280)), ...alien]);
    assert.deepEqual(applyIgnores(withNewCopy, entries, 'movies').shown.map(g => g.title), ['Alien', 'Heat'], 'a third copy brings it back');
    assert.equal(applyIgnores(groups, entries, 'tv').ignored.length, 0, 'keys are per library kind');
});

// ---------- Formatting and exports ----------

test('formatting', () => {
    assert.equal(formatFileSize(0), '0 B');
    assert.equal(formatFileSize(7.38 * 1024 ** 3), '7.38 GB');
    assert.equal(formatResolution({ width: 1920, height: 1080 }), '1920x1080');
    assert.equal(formatResolution({ resolutionLabel: '4k' }), '4k');
    assert.equal(formatResolution({}), 'Unknown');
    assert.equal(formatAudio({ language: 'eng', codec: 'eac3', channels: '5.1' }), 'eng EAC3 5.1');
    assert.equal(formatAudio({}), 'Unknown');
    assert.equal(formatTimeLeft(4.2), 'approximately 0:05 remaining', 'rounds up, never shows 0:00 early');
    assert.equal(formatTimeLeft(125), 'approximately 2:05 remaining');
    assert.equal(formatTimeLeft(3600 + 25 * 60), 'approximately 85:00 remaining', 'minutes keep counting past an hour');
});

test('exports: CSV is one quoted, Excel-safe row per file; JSON keeps the structure', () => {
    const title = 'Crouching Tiger, Hidden "Dragon"';
    const lib = {
        name: 'Films', kind: 'movies',
        groups: findDuplicateGroups([
            item('a', title, 2000, { ...file('/m/CT/a.mkv', 1920, 2 * 1024 ** 3), videoCodec: 'h264', audio: 'eng AC3 5.1' }),
            item('b', title, 2000, file('/m/CT/b.mkv', 1280, 1024 ** 3)),
        ]),
    };

    const csv = resultsAsCsv(lib);
    assert.ok(csv.startsWith('﻿'), 'byte-order mark');
    const lines = csv.slice(1).trimEnd().split('\r\n');
    assert.equal(lines[0], 'Title,Year,Size (bytes),Size,Resolution,Video,Audio,Note,Path');
    assert.equal(lines[1], `"Crouching Tiger, Hidden ""Dragon""",2000,${2 * 1024 ** 3},2 GB,1920x1080,H264,eng AC3 5.1,,/m/CT/a.mkv`);
    assert.equal(lines.length, 3);
    const tv = resultsAsCsv({ name: 'TV', kind: 'tv', groups: [{ series: 'Lost', season: 1, episode: 3, title: 'Tabula Rasa', files: [file('/tv/a.mkv', 1920)] }] });
    assert.match(tv, /^﻿Series,Season,Episode,Title,.*\r\nLost,1,3,Tabula Rasa,/s);

    const risky = resultsAsCsv({ name: 'x', kind: 'movies', groups: [{ title: '=HYPERLINK("http://evil.example")', year: 2000,
        files: [{ ...file('@SUM(1).mkv', 1920), audio: '+cmd', videoCodec: '-x' }] }] }).split('\r\n')[1];
    assert.equal(risky, `"'=HYPERLINK(""http://evil.example"")",2000,1,1 B,1920x1080,'-X,'+cmd,,'@SUM(1).mkv`,
        'cells Excel would run as formulas are written as text');

    const json = JSON.parse(resultsAsJson(lib));
    assert.equal(json.library, 'Films');
    assert.deepEqual(json.duplicates.map(d => [d.title, d.year, d.files.map(f => [f.path, f.sizeBytes, f.resolution])]),
        [[title, 2000, [['/m/CT/a.mkv', 2 * 1024 ** 3, '1920x1080'], ['/m/CT/b.mkv', 1024 ** 3, '1280x720']]]]);
});
