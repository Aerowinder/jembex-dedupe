<p align="center">
  <img src="public/logo.svg" alt="" width="128">
</p>

# Jembex Dedupe

Find duplicate movies and TV episodes on **Jellyfin**, **Emby** and **Plex**.

Jembex Dedupe scans the libraries you choose and lists every title that exists more than once, with the size, resolution, video and audio codec, and path of each copy, so you can decide which ones to keep.

It is **read-only**: it never changes or deletes anything on your media server.

> Formerly **JellEmPlex Dedupe**. See the [changelog](CHANGELOG.md) for what's changed.

## Features

- **Jellyfin (including 12), Emby and Plex**
- **Movies and TV episodes**, scanned together or separately
- **Pick the libraries to scan** from a list of what's on your server, with item counts
- **Finds every kind of duplicate**: separate copies of a title, and copies the server has stacked as "versions" of one item
- **Progress bar with time remaining**, and a Cancel button
- **One table per library**: one row per file, grouped by title (and by show for TV)
- **Ignore** duplicates you keep on purpose (say, a 4K and a 1080p copy). They stay hidden until another copy turns up
- **Export** any library's duplicates as TXT, CSV (opens in Excel) or JSON
- **Saved servers**, so you don't have to re-enter URLs and keys. Saved keys are never sent back to the browser
- **Dark and light mode**; works on phones
- **Runs on amd64 and arm64** (Raspberry Pi, ARM NAS boxes)

## ⚠️ Security

API keys stay inside the container. A saved key is never sent back to the browser, and the page can't show it, so nobody can copy it from the page. An API key you type without saving is used for that session only and is not stored anywhere.

There is no login, though, so **anyone who can open the page can scan your saved servers** and see the list of duplicate files. They can't change anything: the app is read-only, and the container only forwards the few read-only requests a scan needs.

Other websites are kept out too. The API refuses requests your browser makes on another site's behalf, and the media server proxy never follows redirects, so a key can't be sent anywhere but the server you entered. One trick gets past the first check: *DNS rebinding*, where a website briefly points its own name at your server. To block that, set **`ALLOWED_HOSTS`** to the names and addresses you open the app by, such as `ALLOWED_HOSTS=nas.lan,192.168.1.10`. Requests addressed to anything else are then refused. `localhost` always works.

**Run it on a network you trust, and don't expose it to the internet.**

## Installation

The image is published to GitHub Container Registry:

```
ghcr.io/aerowinder/jembex-dedupe:latest
```

The app listens on port **80** inside the container. Saved servers and ignore lists live in **`/app/serverconfig`**; map it to a folder on the host so they survive updates. Each server gets its own file, named after the server type and address, such as `jellyfin_192.168.1.10_8096.json` (or `jellyfin_https_…` for an `https://` address), with its ignore list next to it in `jellyfin_192.168.1.10_8096.ignored.json`.

Optional: **`ALLOWED_HOSTS`**, a comma-separated list of the host names and IP addresses you open the app by (no ports). See [Security](#️-security).

The app doesn't run as root. At startup the container gives `/app/serverconfig` to user and group **1000** and runs as that user. To use a different owner, set **`PUID`** and **`PGID`** (on Unraid, `99` and `100` match the rest of appdata).

### Unraid

1. Go to the **Docker** tab → **Add Container**, and switch on **Advanced View** (top right) so the Icon URL and WebUI fields show.
2. Fill in:
   | Field | Value |
   |---|---|
   | Name | `Jembex-Dedupe` |
   | Repository | `ghcr.io/aerowinder/jembex-dedupe:latest` |
   | Icon URL | `https://raw.githubusercontent.com/Aerowinder/jembex-dedupe/main/public/logo.png` |
   | WebUI | `http://[IP]:[PORT:80]/` |
3. **Add another Port**: container port `80`, host port `3369` (or any free port).
4. **Add another Path**: container path `/app/serverconfig`, host path `/mnt/user/appdata/jembex-dedupe`.
5. **Add another Variable**: key `PUID`, value `99`. Then another: key `PGID`, value `100`.
6. Click **Apply**, then open the WebUI from the Docker tab.

**Coming from JellEmPlex Dedupe?** Edit the container and change **Repository** to `ghcr.io/aerowinder/jembex-dedupe:latest`; the old image name no longer gets updates. Fill in **Icon URL** and **WebUI** as above while you're there. Your saved servers carry over if `/app/serverconfig` is mapped. Files from older versions, kept in `emby/`, `jellyfin/` and `plex/` subfolders, are moved into the main folder automatically on first start.

### Docker Compose

```yaml
services:
  jembex-dedupe:
    image: ghcr.io/aerowinder/jembex-dedupe:latest
    container_name: jembex-dedupe
    ports:
      - "3369:80"
    environment:
      - PUID=1000
      - PGID=1000
    volumes:
      - ./serverconfig:/app/serverconfig
    restart: unless-stopped
```

### Docker run

```bash
docker run -d \
  --name jembex-dedupe \
  -p 3369:80 \
  -e PUID=1000 -e PGID=1000 \
  -v /path/to/serverconfig:/app/serverconfig \
  --restart unless-stopped \
  ghcr.io/aerowinder/jembex-dedupe:latest
```

Then open `http://<host>:3369`.

### Versions and updates

| Tag | Follows |
|---|---|
| `latest` | every change on `main` |
| `2` | the newest 2.x release |
| `2.0` | the newest 2.0.x release |
| `2.0.0` | exactly that release |

Use `latest` to always get the newest version, or a version tag to update only when you choose. On Unraid, **Check for Updates** in the Docker tab picks up new images.

## Before you scan: the container connects to your server

Scans are run **by the Jembex Dedupe container**, which talks to Jellyfin, Emby or Plex and passes the results to your browser. So:

- **The URL must be reachable from the container**, not from the device you're browsing on. A LAN address like `192.168.1.10:8096` usually works. `localhost` means the container itself, not the host, so use the host's IP address instead.
- Your browser never contacts the media server, so it doesn't matter whether you open the page over `http://` or `https://`, or which device you use.

## Getting an API key

### Jellyfin
**Dashboard → API Keys → +**, give it a name (e.g. "Jembex Dedupe"), and copy the key.

### Emby
**Settings → Advanced → API Keys → New API Key**, give it a name, and copy the key.

### Plex
Plex uses a token rather than an API key.

Open Plex's `Preferences.xml` and copy the value of `PlexOnlineToken`:

| System | Location |
|---|---|
| Unraid | `/mnt/user/appdata/plex/Library/Application Support/Plex Media Server/Preferences.xml` |
| Linux | `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml` |
| Windows | `%LOCALAPPDATA%\Plex Media Server\Preferences.xml` |
| macOS | `~/Library/Application Support/Plex Media Server/Preferences.xml` |

## Usage

1. Choose **Jellyfin**, **Emby** or **Plex**.
2. Enter the **server URL**, such as `192.168.1.100:8096` or `https://jellyfin.example.com`. `http://` is assumed if you leave it out.
3. Paste the **API key** (or Plex token). Tick **Save this server** to keep it for next time. For a saved server, leave the key field empty and the saved key is used. Type a new key and save again to replace it.
4. Click **Load libraries**. Every movie and TV library on the server is listed with its size.
5. Tick the libraries to scan and click **Scan**. Your choice is remembered for that server. Press **Cancel** or **Esc** to stop a scan.
6. Click **View details** on a library to see its duplicates, or download the list as **TXT**, **CSV** or **JSON**.
7. To keep a duplicate on purpose, click **Ignore** under its title. It's hidden from future scans of that server until another copy appears. **Ignored (n)** on the library card lists what you've ignored, with a **Restore** link for each.
8. Remove the copies you don't want with your usual tools (file manager, Sonarr/Radarr, etc.), then rescan your library in the media server.

## How duplicates are matched

**Movies** match on **title + year**. Titles are compared without case, accents or punctuation, so `The Matrix`, `The matrix` and `The Matrix:` match. If the folder or file name has a different year in brackets than the metadata (say `Dune (1984)` matched to the 2021 film), the year from the path wins, so remakes aren't lumped together. Numbers in titles, such as *2001: A Space Odyssey* or *Death Race 2000*, are never mistaken for years.

**TV episodes** match on **show + season + episode number**:
- Shows are compared by the server's internal ID, so two shows with the same name stay separate.
- A double-episode file (e.g. `S01E01-E02`) counts towards each episode it contains. It's only listed when another copy of one of those episodes exists, and it's tagged in the results.
- Specials (season 0) are included.
- Episodes the server hasn't identified (no episode number) are skipped, since matching them would be guesswork.

A title counts as duplicated whether the copies are **separate items** or **versions stacked on one item**. Within each title, copies are sorted by resolution, then size, largest first.

## Troubleshooting

| Message | Likely cause |
|---|---|
| `HTTP 401 — check your API key / token` | The key is wrong, or was deleted on the server. |
| `could not reach … (wrong URL, or server down)` | The URL isn't reachable from the container. See [Before you scan](#before-you-scan-the-container-connects-to-your-server). |
| `no API key given, and no saved server with this URL` | Enter the key, or pick the server from **Saved servers**. |
| `No movie or TV libraries found` | The server has no libraries of type *Movies* or *Shows*, or the key can't see them. |
| The page looks out of date after an update | Hard-refresh the page (Ctrl+F5 / Cmd+Shift+R). |

## Development

No build step: the files in `public/` are served as-is.

```
public/            the web UI
  js/servers/      one file per media server: how to read its libraries, its login
                   header and allowed requests, and its form labels
    index.js       the list of supported servers
    mediabrowser.js  shared Jellyfin/Emby code; jellyfin.js and emby.js hold the differences
    plex.js
    common.js      errors, URL clean-up, the browser → backend transport
  js/dedupe.js     duplicate detection and ignore matching (pure functions)
  js/results.js    results table and TXT / CSV / JSON export
  js/app.js        page wiring: form, library picker, saved servers, ignores, scan
  js/version.js    app version (keep in step with package.json)
lib/http.js        the HTTP layer on plain node:http: static files, JSON bodies, routing
lib/upstream.js    sends requests to the media servers, adding the key (server-side only)
server.js          the routes: page, saved servers, ignore lists, and the media proxy
entrypoint.sh      container start: hands serverconfig/ to PUID:PGID and drops root
test/              node:test suites, with fake Jellyfin, Emby and Plex servers;
                   http.test.js and security.test.js attack the server's protections
```

```bash
npm test           # run all tests (Node 26; there are no dependencies to install)
npm run dev        # app on http://localhost:3000, restarts on change; data in ./serverconfig
```

The app has no npm dependencies: it runs on Node's built-in HTTP server. Dependabot opens a PR when GitHub Actions or the `node:26-alpine` base image is updated; the tests run on the PR, and merging it publishes a rebuilt image.

Every push runs the tests on GitHub Actions, and an image is only published if they pass.

**Releasing:** bump the version in `package.json` and `public/js/version.js`, add a `CHANGELOG.md` entry (a test checks all three agree), then push a tag:

```bash
git tag v2.0.1 && git push origin v2.0.1
```

## Contributing

Bug reports and pull requests are welcome on [GitHub](https://github.com/Aerowinder/jembex-dedupe/issues).

## License

[MIT](LICENSE). Original work © 2025 SpaceinvaderOne; changes © 2026 Aerowinder.
