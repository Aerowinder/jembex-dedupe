// Jellyfin and Emby: Jellyfin is a fork of Emby, and the calls a scan makes are the same on
// both. What differs (login header, Emby's /emby prefix, labels) is in jellyfin.js and emby.js.

import { formatAudio } from '../format.js';
import { PAGE_SIZE } from './common.js';

// The only requests the backend forwards for these servers
export const MEDIA_BROWSER_PATHS = [/^\/Library\/VirtualFolders$/, /^\/Items$/];

const MB_KINDS = {
    movies: { collection: 'movies', itemType: 'Movie' },
    tv: { collection: 'tvshows', itemType: 'Episode' },
};
const MB_KIND_OF = Object.fromEntries(Object.entries(MB_KINDS).map(([kind, k]) => [k.collection, kind]));

export function mediaBrowserClient(get) {
    const itemQuery = (library, start, limit) => ({
        ParentId: library.id,
        Recursive: 'true',
        IncludeItemTypes: MB_KINDS[library.kind].itemType,
        Fields: 'Path,MediaSources,MediaStreams',
        StartIndex: start,
        Limit: limit,
    });

    return {
        // Every movie and TV library, each tagged with its kind
        async listLibraries() {
            const folders = await get('/Library/VirtualFolders', null, 'Listing libraries');
            return folders
                .filter(f => MB_KIND_OF[f.CollectionType])
                .map(f => ({ id: f.ItemId, name: f.Name, kind: MB_KIND_OF[f.CollectionType] }));
        },

        async countItems(library) {
            // Limit=1, not 0: some servers read 0 as "no limit"
            const { Fields, ...query } = itemQuery(library, 0, 1);
            const page = await get('/Items', query, `Counting "${library.name}"`);
            return page.TotalRecordCount ?? 0;
        },

        async listItems(library, onBatch = () => {}) {
            const items = [];
            for (let start = 0; ;) {
                const page = await get('/Items', itemQuery(library, start, PAGE_SIZE), `Listing "${library.name}"`);
                const batch = page.Items || [];
                items.push(...batch.map(mediaBrowserItem));
                onBatch(batch.length);
                // Advance by what came back: servers may return fewer than Limit
                start += batch.length;
                if (!batch.length || start >= (page.TotalRecordCount ?? 0)) break;
            }
            return items;
        },
    };
}

function mediaBrowserItem(item) {
    const sources = item.MediaSources?.length
        ? item.MediaSources
        : [{ Path: item.Path, Size: 0, MediaStreams: item.MediaStreams }];

    return {
        id: item.Id,
        title: item.Name,
        year: item.ProductionYear,
        path: item.Path,
        series: item.SeriesName,
        seriesId: item.SeriesId,
        season: item.ParentIndexNumber,
        episode: item.IndexNumber,
        episodeEnd: item.IndexNumberEnd,
        files: sources.map(source => {
            // Each version carries its own streams; fall back to the item's only for a single version
            const streams = source.MediaStreams?.length ? source.MediaStreams
                : sources.length === 1 ? (item.MediaStreams || []) : [];
            const video = streams.find(s => s.Type === 'Video');
            const audio = streams.find(s => s.Type === 'Audio' && s.IsDefault) || streams.find(s => s.Type === 'Audio');
            return {
                path: source.Path || item.Path,
                size: source.Size || 0,
                width: video?.Width,
                height: video?.Height,
                videoCodec: video?.Codec,
                audio: formatAudio({ language: audio?.Language, codec: audio?.Codec, channels: audio?.ChannelLayout }),
            };
        }),
    };
}
