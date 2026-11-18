// Duplicate detection. Pure functions: no DOM, no network, so they run under node:test.
//
// Every server client produces the same item shape:
//   { id, title, year, path, files: [{ path, size, width, height, resolutionLabel, videoCodec, audio }] }
// plus, for episodes: { series, seriesId, season, episode, episodeEnd }
//
// An item with several files is one the server has stacked as versions; separate items that
// share a key are duplicates the server didn't stack. Both cases count.
//
// A "kind" decides what makes two items the same thing: keysOf(item) returns one entry per
// thing the item is (a movie is one thing; a double-episode file is two episodes).

import { pixelCount } from './format.js';

// Years in folder and file names. A bracketed year, "(1968)" or "[1968]", is a clear signal.
// A loose year counts only after a separator, never as the first word of a name, so titles
// that start with a number ("2001 A Space Odyssey", "1917") aren't mistaken for years.
const BRACKETED_YEAR = /[([](\d{4})[)\]]/g;
const LOOSE_YEAR = /[\s._-](\d{4})(?=[\s._-]|$)/g;

// A bracketed year in the folder or file name beats the metadata year when they disagree: it
// keeps remakes apart when the server has matched both to the same film. Loose years are
// weaker ("Death Race 2000" is a 1975 film), so they only fill in a missing metadata year.
// When the metadata year appears anywhere in the path, the two agree and it stands.
export function effectiveYear(item) {
    if (!item.path) return item.year;
    const names = item.path.split(/[\\/]/);
    const thisYear = new Date().getFullYear();
    const yearsIn = pattern => names
        .flatMap(name => [...name.matchAll(pattern)].map(m => Number(m[1])))
        .filter(y => y >= 1900 && y <= thisYear);
    const bracketed = yearsIn(BRACKETED_YEAR);
    const loose = yearsIn(LOOSE_YEAR);
    if (bracketed.includes(item.year) || loose.includes(item.year)) return item.year;
    // the one nearest the file wins: the file name's year over the folder's
    if (bracketed.length) return bracketed.at(-1);
    return item.year ?? loose.at(-1);
}

// Titles compare without case, accents or punctuation: "The Matrix" = "The matrix",
// "Amélie" = "Amelie", "Spider-Man" = "Spider Man". The title shown is the first one seen.
export const titleKey = title => title
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

export const episodeCode = (season, episode) =>
    `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;

export const MOVIES = {
    keysOf(item) {
        const title = item.title?.trim();
        if (!title) return [];
        const year = effectiveYear(item);
        return [{ key: `${titleKey(title) || title}_${year ?? 'unknown'}`, title, year, sort: [title, year || 0] }];
    },
};

export const EPISODES = {
    keysOf(item) {
        const { series, season, episode } = item;
        // Unidentified episodes have no number; matching them on title would only guess
        if (!series?.trim() || !Number.isInteger(season) || !Number.isInteger(episode)) return [];
        const last = Number.isInteger(item.episodeEnd) && item.episodeEnd > episode ? item.episodeEnd : episode;
        const show = item.seriesId || titleKey(series) || series.trim();
        const note = last > episode ? `${episodeCode(season, episode)}–E${String(last).padStart(2, '0')}` : undefined;
        const keys = [];
        for (let ep = episode; ep <= last; ep++) {
            keys.push({
                key: `${show}|${season}|${ep}`,
                series: series.trim(),
                season,
                episode: ep,
                // a multi-episode file's title belongs to its first episode only
                title: ep === episode && !note ? item.title?.trim() : undefined,
                note,
                sort: [series.trim(), season, ep],
            });
        }
        return keys;
    },
};

function compareSort(a, b) {
    for (let i = 0; i < a.length; i++) {
        const diff = typeof a[i] === 'string'
            ? a[i].localeCompare(b[i], undefined, { sensitivity: 'base' })
            : (a[i] || 0) - (b[i] || 0);
        if (diff) return diff;
    }
    return 0;
}

export function findDuplicateGroups(items, kind = MOVIES) {
    const groups = new Map();

    for (const item of items) {
        for (const { key, note, sort, ...info } of kind.keysOf(item)) {
            let group = groups.get(key);
            if (!group) {
                group = { key, ...info, sort, files: [], paths: new Set() };
                groups.set(key, group);
            }
            if (!group.title && info.title) group.title = info.title;
            for (const file of item.files) {
                // Servers can list one file twice (as an item and as another item's version)
                const id = file.path || `${item.id}:${group.files.length}`;
                if (group.paths.has(id)) continue;
                group.paths.add(id);
                group.files.push(note ? { ...file, itemId: item.id, note } : { ...file, itemId: item.id });
            }
        }
    }

    return [...groups.values()]
        .filter(g => g.files.length > 1)
        .sort((a, b) => compareSort(a.sort, b.sort))
        .map(({ paths, sort, ...g }) => ({
            ...g,
            files: g.files.sort((a, b) => pixelCount(b) - pixelCount(a) || (b.size || 0) - (a.size || 0)),
        }));
}

// ---------- Ignored duplicates ----------
// An ignore entry ({ key, paths }) remembers the copies a group had when it was ignored. The
// group stays hidden only while every copy is one of those, so a new copy brings it back.

export const groupFileIds = group => group.files.map(f => f.path || `item:${f.itemId}`);

// kind is the library kind ('movies' or 'tv'), so a movie and an episode never share a key.
// Each group gets ignoreKey (what to store) and order (its place in the full list).
export function applyIgnores(groups, entries, kind) {
    const byKey = new Map((entries || []).map(entry => [entry.key, entry]));
    const shown = [];
    const ignored = [];
    groups.forEach((group, order) => {
        group.order = order;
        group.ignoreKey = `${kind}:${group.key}`;
        const entry = byKey.get(group.ignoreKey);
        const hidden = Array.isArray(entry?.paths) && groupFileIds(group).every(id => entry.paths.includes(id));
        (hidden ? ignored : shown).push(group);
    });
    return { shown, ignored };
}
