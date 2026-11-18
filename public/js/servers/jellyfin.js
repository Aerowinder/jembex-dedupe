// Jellyfin. Jellyfin 12 dropped legacy auth (?api_key=, X-Emby-Token) and the /emby route
// prefix, so it gets the standard Authorization header on bare routes.

import { APP_VERSION } from '../version.js';
import { MEDIA_BROWSER_PATHS, mediaBrowserClient } from './mediabrowser.js';

export const jellyfin = {
    type: 'jellyfin',
    label: 'Jellyfin',
    keyLabel: 'API key',
    keyPlaceholder: 'API Key',
    keyNoun: 'key',
    urlPlaceholder: 'Server URL (e.g., server.domain.com:8096)',

    // Backend only: how requests reach the server
    pathPrefix: '',
    allowedPaths: MEDIA_BROWSER_PATHS,
    authHeaders: apiKey => ({
        Authorization: `MediaBrowser Client="Jembex Dedupe", Device="Web", ` +
            `DeviceId="jembex-dedupe", Version="${APP_VERSION}", Token="${apiKey}"`,
    }),

    createClient: get => mediaBrowserClient(get),
};
