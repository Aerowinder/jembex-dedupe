# Changelog

## 2.0.0, 2026-11-18

**JellEmPlex Dedupe is now Jembex Dedupe**, updated and maintained by Aerowinder. To keep getting updates, change your container's image to `ghcr.io/aerowinder/jembex-dedupe`. Your saved servers carry over as long as the same folder stays mapped to `/app/serverconfig`. The app no longer runs as root; on Unraid, you can add `PUID=99` and `PGID=100` so its files match the rest of your appdata.

- **Works with Jellyfin 12**, which stopped accepting the way the original sent API keys.
- **Finds duplicates the original missed**, including copies the server had grouped as "versions" of one movie, titles that differ only in capitals, accents or punctuation, and films with a number in the title, like *2001: A Space Odyssey*.
- **TV episodes**, not just movies.
- **Choose which libraries to scan**, with a progress bar, time remaining and a Cancel button.
- **Ignore duplicates you keep on purpose**, like a 4K and a 1080p copy of the same film. They stay hidden until another copy turns up.
- **Export to CSV and JSON**, as well as plain text.
- **Read-only.** The app no longer deletes files: it lists the duplicates and leaves the cleanup to you.
- **Your API keys stay private.** The app talks to your media server itself, so keys never reach your browser, and once a server is saved its key can't be seen, copied or downloaded from the page.
- **Fewer connection problems.** Your media server only needs to be reachable from the container, not from the device you're browsing on.
- **Safer and lighter.** Other websites can't use the app through your browser, and it has no outside dependencies to keep patched.
- **Runs on ARM**, such as a Raspberry Pi or an ARM-based NAS.
- **Redesigned page**, with a light mode that works.

## 1.0.0, 2025-07-19

Original release by SpaceinvaderOne.
