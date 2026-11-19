# Changelog

## 2.0.2, 2026-11-19

- The warning about saved API keys now only shows while the save checkbox is ticked.

## 2.0.1, 2026-11-19

- When a scan completes, the server connection dialog will collapse, allowing you to see the results without scrolling.
- Minor housekeeping changes.

## 2.0.0, 2026-11-18

Since the release of Jellyfin 12.0, JellEmPlex has been broken for Jellyfin installations, due to authentication changes in Jellyfin. Sadly, it does not look like an official update is coming for this excellent container, so I've forked it and updated it myself. The fork has been renamed to Jembex Dedupe. It is inspired by the original JellEmPlex Dedupe by SpaceInvaderOne, but has seen significant updates.

If you are a current user of JellEmPlex, to get started with Jembex Dedupe, all you need to do is change your container's image path to `ghcr.io/aerowinder/jembex-dedupe`.

This container no longer runs as root; on Unraid, you can add `PUID=99` and `PGID=100` so its files match the rest of your appdata permissions.

**New features**:
- Updated for Jellyfin 12
- Supports scanning TV episodes
- Choose which libraries to scan
- Finds duplicates version 1.0.0 missed
- Ignore duplicates you keep on purpose, or allow-list false positives
- Additional export options to CSV and JSON
- Includes builds for on ARM systems, such as a Raspberry Pi or an ARM-based NAS.
- Redesigned webpage

**Removed Features**
- Delete function has been removed from duplicate lists, as it is inherently dangerous. You must manually reconcile your duplicate media.

**Security Updates**
- Your API keys stay private. Once you save them, they are never shown again
- Reworked dependencies, and all remaining dependencies have been updated to in-support versions.


## 1.0.0, 2025-07-19

Original release by SpaceinvaderOne.
