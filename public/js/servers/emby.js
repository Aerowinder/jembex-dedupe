// Emby. Routes live under /emby, and the key goes in a header so it stays out of server and
// proxy logs.

import { MEDIA_BROWSER_PATHS, mediaBrowserClient } from './mediabrowser.js';

export const emby = {
    type: 'emby',
    label: 'Emby',
    keyLabel: 'API key',
    keyPlaceholder: 'API Key',
    keyNoun: 'key',
    urlPlaceholder: 'Server URL (e.g., server.domain.com:8096)',

    // Backend only: how requests reach the server
    pathPrefix: '/emby',
    allowedPaths: MEDIA_BROWSER_PATHS,
    authHeaders: apiKey => ({ 'X-Emby-Token': apiKey }),

    createClient: get => mediaBrowserClient(get),
};
