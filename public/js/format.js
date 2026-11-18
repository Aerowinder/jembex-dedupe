// Display helpers shared by the results view and the text export.

export function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${parseFloat((bytes / 1024 ** i).toFixed(2))} ${units[i]}`;
}

// "1920x1080", or the server's own label (e.g. Plex "4k") when dimensions are missing.
export function formatResolution({ width, height, resolutionLabel }) {
    if (width && height) return `${width}x${height}`;
    return resolutionLabel || 'Unknown';
}

// "eng EAC3 5.1" — any missing piece is left out.
export function formatAudio({ language, codec, channels } = {}) {
    const parts = [language, codec && codec.toUpperCase(), channels]
        .filter(p => p !== undefined && p !== null && p !== '' && p !== 'Unknown');
    return parts.length ? parts.join(' ') : 'Unknown';
}

export function pixelCount(file) {
    return (file.width || 0) * (file.height || 0);
}

// "approximately 2:05 remaining". Minutes keep counting past an hour (75:00), so the
// format never changes shape while it counts down.
export function formatTimeLeft(seconds) {
    const total = Math.max(0, Math.ceil(seconds));
    const m = Math.floor(total / 60);
    const s = String(total % 60).padStart(2, '0');
    return `approximately ${m}:${s} remaining`;
}
