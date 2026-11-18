// The supported media servers. Each file in this folder describes one server completely:
// how to list and read its libraries (used in the browser), how requests reach it (login
// header, URL prefix, allowed paths: used only by the backend, never with a key in the
// browser), and the labels the form shows. Every client returns libraries as
// { id, name, kind } and items in the shape documented in dedupe.js, so detection and
// display never care which server they came from.
//
// Adding a server: write <name>.js exporting the same fields, and list it here.

import { emby } from './emby.js';
import { jellyfin } from './jellyfin.js';
import { plex } from './plex.js';

export const SERVERS = { jellyfin, emby, plex };
export const SERVER_TYPES = Object.keys(SERVERS);

export { ServerError, normalizeServerUrl, proxyTransport } from './common.js';

export function createClient(serverType, transport) {
    const server = SERVERS[serverType];
    if (!server) throw new Error(`Unknown server type: ${serverType}`);
    return server.createClient((path, params, what) => transport.get(path, params, what), transport.signal);
}
