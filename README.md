<p align="center">
  <img src="public/logo.svg" alt="" width="128">
</p>

# Jembex Dedupe

> A fork of JellEmPlex Dedupe by SpaceinvaderOne, updated for Jellyfin 12 with a host of other features added. See the [changelog](CHANGELOG.md) for details.

Find duplicate movies and TV episodes on Jellyfin, Emby and Plex.

Pick the libraries to scan, and Jembex Dedupe lists every title you have more than once, with the size, resolution, codecs and path of each copy. You decide what to keep. It's read-only: it never changes or deletes anything on your media server.

## Features

- Works with Jellyfin, Emby and Plex
- Finds duplicate movies and TV episodes
- You choose which libraries to scan
- Catches separate copies and stacked versions of one item
- Shows progress and time remaining, with the option to cancel an in-progress scan
- Ignore duplicates you want to keep
- Exports to TXT, CSV or JSON
- Remembers your servers and keys
- Has dark and light modes, and works on phones
- Runs on amd64 and arm64

## Security

**Run it on a network you trust, and don't expose it to the internet.** There's no login, so anyone who can open the page can scan your saved servers and see the results.

- API keys stay in the container. Saved keys are never sent to the browser, so they can't be copied from the page. A key you use without saving isn't stored at all.
- Other websites can't use the app through your browser, and the app only sends keys to the server you entered.
- For extra protection, set `ALLOWED_HOSTS` to the names and addresses you open the app by, such as `ALLOWED_HOSTS=nas.lan,192.168.1.10`. Requests addressed to anything else are refused. This blocks DNS rebinding, where a website briefly points its own name at your server. `localhost` always works.

## Installation

Image: `ghcr.io/aerowinder/jembex-dedupe:latest`

| Setting | Value |
|---|---|
| Port | `80` inside the container |
| Path | `/config` is where the app keeps its data: one file per server, with its URL, API key and ignore list. Map it to a host folder so it survives updates. |
| `PUID` / `PGID` | The user and group that own `/config` and that the app runs as. Default `1000`. On Unraid, use `99` and `100`. |
| `ALLOWED_HOSTS` | Optional. Comma-separated host names and IPs, no ports. See [Security](#️-security). |

The app doesn't run as root: at startup it hands `/config` to `PUID`:`PGID` and runs as that user.

### Unraid

In the Docker tab, click Add Container and switch on Advanced View (top right). Fill in the fields below, adding the port, path and variables with "Add another Path, Port, Variable, Label or Device" at the bottom. Then click Apply and open the WebUI from the Docker tab.

| Field | Value |
|---|---|
| Name | `Jembex-Dedupe` |
| Repository | `ghcr.io/aerowinder/jembex-dedupe:latest` |
| Icon URL | `https://raw.githubusercontent.com/Aerowinder/jembex-dedupe/main/public/logo.png` |
| WebUI | `http://[IP]:[PORT:80]/` |
| Port | Container `80`, host `3369` (or any free port) |
| Path | Container `/config`, host `/mnt/user/appdata/jembex-dedupe` |
| Variable | `PUID` = `99` |
| Variable | `PGID` = `100` |

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
      - ./config:/config
    restart: unless-stopped
```

### Docker run

```bash
docker run -d \
  --name jembex-dedupe \
  -p 3369:80 \
  -e PUID=1000 -e PGID=1000 \
  -v /path/to/config:/config \
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

Use `latest` to always get the newest version, or a version tag to update only when you choose. On Unraid, Check for Updates in the Docker tab picks up new images.

## Getting an API key

### Jellyfin

Go to Dashboard → API Keys → +, give it a name (e.g. "Jembex Dedupe"), and copy the key.

### Emby

Go to Settings → Advanced → API Keys → New API Key, give it a name, and copy the key.

### Plex

Plex uses a token instead. Open Plex's `Preferences.xml` and copy the value of `PlexOnlineToken`:

| System | Location |
|---|---|
| Unraid | `/mnt/user/appdata/plex/Library/Application Support/Plex Media Server/Preferences.xml` |
| Linux | `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml` |
| Windows | `%LOCALAPPDATA%\Plex Media Server\Preferences.xml` |
| macOS | `~/Library/Application Support/Plex Media Server/Preferences.xml` |

## Usage

1. Choose Jellyfin, Emby or Plex.
2. Enter the server URL, such as `192.168.1.100:8096` or `https://jellyfin.example.com` (`http://` is assumed if you leave it out). See [the note below](#the-url-must-work-from-the-container).
3. Paste the API key (or Plex token), and tick Save this server to keep it. Next time, pick the saved server and leave the key empty. To replace a saved key, type the new one and save again.
4. Click Load libraries to list every movie and TV library on the server.
5. Tick the libraries you want and click Scan. Your choice is remembered for that server. Cancel or Esc stops a scan.
6. Click View details on a library to see its duplicates, or download them as TXT, CSV or JSON.
7. To keep a duplicate on purpose, click Ignore under its title. It stays hidden until another copy appears. Ignored (n) on the library card lists them, with a Restore link for each.
8. Remove the copies you don't want with your usual tools (file manager, Sonarr/Radarr, etc.), then rescan the library in your media server.

### The URL must work from the container

The container talks to your media server, not your browser. So the URL has to be reachable from the container:

- A LAN address like `192.168.1.10:8096` usually works.
- `localhost` means the container itself, so use the host's IP address instead.
- It doesn't matter which device you browse from, or whether the page is on `http://` or `https://`.

## How duplicates are matched

### Movies

Movies match on title and year.

- Case, accents and punctuation are ignored, so `The Matrix`, `The matrix` and `The Matrix:` match.
- If the folder or file name has a different year in brackets than the metadata (say `Dune (1984)` matched to the 2021 film), the path's year wins, so remakes stay separate.
- Numbers in titles, like *2001: A Space Odyssey* or *Death Race 2000*, are never mistaken for years.

### TV episodes

Episodes match on show, season and episode number.

- Shows are compared by the server's internal ID, so two shows with the same name stay separate.
- A double-episode file (e.g. `S01E01-E02`) counts towards each episode in it, and is tagged in the results.
- Specials (season 0) are included.
- Episodes without an episode number are skipped, since matching them would be guesswork.

Copies count as duplicates whether they're separate items or versions stacked on one item. Within each title, copies are sorted by resolution, then size, largest first.

## Troubleshooting

| Message | Likely cause |
|---|---|
| `HTTP 401 — check your API key / token` | The key is wrong, or was deleted on the server. |
| `could not reach … (wrong URL, or server down)` | The URL isn't reachable from the container. See [the URL note](#the-url-must-work-from-the-container). |
| `no API key given, and no saved server with this URL` | Enter the key, or pick the server from Saved servers. |
| `No movie or TV libraries found` | The server has no Movies or Shows libraries, or the key can't see them. |
| The page looks out of date after an update | Hard-refresh the page (Ctrl+F5 / Cmd+Shift+R). |

## Contributing

Bug reports and pull requests are welcome on [GitHub](https://github.com/Aerowinder/jembex-dedupe/issues).

## License

[MIT](LICENSE). Original work © 2025 SpaceinvaderOne; changes © 2026 Aerowinder.
