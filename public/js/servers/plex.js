// Plex.
// The library listing already has paths, sizes, resolution and codecs for every version.
// Only the per-version audio language needs the (slow, one-per-item) detail call, so
// enrich() is run only on items that turned out to be duplicates.
// A Plex multi-episode file appears as one episode item per episode, all sharing the file.

import { formatAudio } from '../format.js';
import { PAGE_SIZE, mapLimit } from './common.js';

const DETAIL_CONCURRENCY = 4;

export const plex = {
    type: 'plex',
    label: 'Plex',
    keyLabel: 'Plex token',
    keyPlaceholder: 'Plex Token',
    keyNoun: 'token',
    urlPlaceholder: 'Plex Server URL (e.g., plex.domain.com:32400)',

    // Backend only: how requests reach the server
    pathPrefix: '',
    allowedPaths: [/^\/library\/sections$/, /^\/library\/sections\/[\w-]+\/all$/, /^\/library\/metadata\/[\w-]+$/],
    authHeaders: token => ({ 'X-Plex-Token': token }),

    createClient: (get, signal) => plexClient(get, signal),
};

const PLEX_KINDS = {
    movies: { section: 'movie', type: 1 },
    tv: { section: 'show', type: 4 },
};
const PLEX_KIND_OF = Object.fromEntries(Object.entries(PLEX_KINDS).map(([kind, k]) => [k.section, kind]));

function plexClient(get, signal) {
    const listPage = (library, start, size, what) =>
        get(`/library/sections/${encodeURIComponent(library.id)}/all`, {
            type: PLEX_KINDS[library.kind].type,
            'X-Plex-Container-Start': start,
            'X-Plex-Container-Size': size,
        }, what);

    return {
        async listLibraries() {
            const data = await get('/library/sections', null, 'Listing libraries');
            return (data.MediaContainer.Directory || [])
                .filter(d => PLEX_KIND_OF[d.type])
                .map(d => ({ id: d.key, name: d.title, kind: PLEX_KIND_OF[d.type] }));
        },

        async countItems(library) {
            const data = await listPage(library, 0, 1, `Counting "${library.name}"`);
            return data.MediaContainer.totalSize ?? 0;
        },

        async listItems(library, onBatch = () => {}) {
            const items = [];
            for (let start = 0; ;) {
                const data = await listPage(library, start, PAGE_SIZE, `Listing "${library.name}"`);
                const page = data.MediaContainer.Metadata || [];
                items.push(...page.map(plexItem));
                onBatch(page.length);
                start += page.length;
                if (!page.length || start >= (data.MediaContainer.totalSize ?? 0)) break;
            }
            return items;
        },

        async enrich(items, onItem = () => {}) {
            await mapLimit(items, DETAIL_CONCURRENCY, async item => {
                try {
                    const data = await get(`/library/metadata/${encodeURIComponent(item.id)}`, null, `Details for "${item.title}"`);
                    const detail = data.MediaContainer.Metadata?.[0];
                    if (detail) item.files = plexItem(detail).files;
                } catch (err) {
                    if (err.name === 'AbortError') throw err;
                    console.warn(err.message); // keep the listing data for this item
                }
                onItem();
            }, signal);
        },
    };
}

const PLEX_CHANNELS = { 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1' };

function plexItem(meta) {
    const media = meta.Media || [];
    return {
        id: meta.ratingKey,
        title: meta.title,
        year: meta.year,
        path: media[0]?.Part?.[0]?.file,
        series: meta.grandparentTitle,
        seriesId: meta.grandparentRatingKey,
        season: meta.parentIndex,
        episode: meta.index,
        files: media.map(m => {
            const parts = m.Part || [];
            const streams = parts.flatMap(p => p.Stream || []);
            const video = streams.find(s => s.streamType === 1);
            const audio = streams.find(s => s.streamType === 2 && s.selected) || streams.find(s => s.streamType === 2);
            return {
                path: parts[0]?.file,
                size: parts.reduce((sum, p) => sum + (p.size || 0), 0),
                width: m.width || video?.width,
                height: m.height || video?.height,
                resolutionLabel: m.videoResolution,
                videoCodec: m.videoCodec || video?.codec,
                audio: formatAudio({
                    language: audio?.languageCode || audio?.language,
                    codec: audio?.codec || m.audioCodec,
                    channels: audio?.audioChannelLayout?.replace(/\(.*\)/, '') || PLEX_CHANNELS[m.audioChannels] || m.audioChannels,
                }),
            };
        }),
    };
}
