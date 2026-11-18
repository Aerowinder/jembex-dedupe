// Results: per-library summary cards, the full-screen duplicate table, and the exports.
// A library result is { name, kind, groups, ignored } where kind is 'movies' or 'tv', and
// groups / ignored come from applyIgnores() (each group has an order and an ignoreKey).

import { formatFileSize, formatResolution } from './format.js';
import { episodeCode } from './dedupe.js';

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(text, className, onClick) {
    const node = el('button', className, text);
    node.type = 'button';
    node.onclick = onClick;
    return node;
}

const fileCount = groups => groups.reduce((n, g) => n + g.files.length, 0);
const codec = f => (f.videoCodec ? f.videoCodec.toUpperCase() : '—');
const audio = f => (f.audio && f.audio !== 'Unknown' ? f.audio : '—');
const titleWithYear = g => (g.year ? `${g.title} (${g.year})` : g.title);
const unitOf = (kind, n) => (kind === 'tv' ? (n === 1 ? 'episode' : 'episodes') : (n === 1 ? 'title' : 'titles'));
const unit = lib => unitOf(lib.kind, lib.groups.length);
const episodeLabel = g => `${episodeCode(g.season, g.episode)}${g.title ? ` · ${g.title}` : ''}`;
export const groupLabel = (lib, g) => (lib.kind === 'tv' ? `${g.series} ${episodeLabel(g)}` : titleWithYear(g));
const fileLine = f => `  ${formatFileSize(f.size).padStart(10)}  ${formatResolution(f).padEnd(10)}  ${codec(f).padEnd(5)}  ` +
    `${audio(f).padEnd(22)}  ${f.note ? `[${f.note}] ` : ''}${f.path || ''}`;

// What the page set up: the container and library list (to re-render after an ignore),
// and setIgnored(lib, group, ignored) → Promise<boolean>, which saves the change.
let view = { container: null, libraries: [], setIgnored: async () => false };

export function renderSummaries(container, libraries, { setIgnored } = {}) {
    view = { container, libraries, setIgnored: setIgnored || view.setIgnored };
    redrawSummaries();
}

function redrawSummaries() {
    const { container, libraries } = view;
    container.replaceChildren();
    const shown = libraries.filter(lib => lib.groups.length || lib.ignored.length);
    if (!shown.length) {
        container.append(el('p', null, 'No duplicates found in any library.'));
        return;
    }
    shown.forEach((lib, i) => {
        const box = el('div', 'library-box');
        box.style.animationDelay = `${i * 0.1}s`;
        const parts = [lib.groups.length
            ? `${lib.groups.length} ${unit(lib)} with duplicates · ${fileCount(lib.groups)} files`
            : 'No duplicates left'];
        if (lib.ignored.length) parts.push(`${lib.ignored.length} ignored`);

        const actions = el('div', 'library-actions');
        if (lib.groups.length) {
            actions.append(button('View details', 'btn btn-secondary btn-sm', () => openResults(lib)), downloadButtons(lib));
        }
        if (lib.ignored.length) {
            actions.append(button(`Ignored (${lib.ignored.length})`, 'btn btn-secondary btn-sm', () => openResults(lib, 'ignored')));
        }
        box.append(el('h3', null, lib.name), el('p', null, parts.join(' · ')), actions);
        container.append(box);
    });
}

function downloadButtons(lib) {
    const group = el('div', 'btn-group');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Download');
    group.append(el('span', 'btn-group-label', 'Download'));
    for (const format of Object.keys(EXPORTS)) {
        const b = button(format.toUpperCase(), 'btn btn-secondary btn-sm', () => downloadResults(lib, format));
        b.title = `Download as .${format}`;
        group.append(b);
    }
    return group;
}

// mode 'duplicates' lists what's left to deal with; 'ignored' lists what the user has hidden
export function openResults(lib, mode = 'duplicates') {
    const ignoredView = mode === 'ignored';
    const groupsOf = () => (ignoredView ? lib.ignored : lib.groups);
    const overlay = el('div', 'dupes-overlay');
    const panel = el('div', 'dupes');
    const close = () => {
        overlay.remove();
        document.documentElement.classList.remove('dupes-open');
        document.removeEventListener('keydown', onKey);
    };
    const onKey = e => { if (e.key === 'Escape') close(); };

    const meta = el('span', 'dupes-meta');
    const heading = el('div');
    heading.append(el('h2', null, ignoredView ? `${lib.name} · ignored` : lib.name), meta);
    const closeBtn = button('✕', 'btn btn-secondary btn-sm', close);
    closeBtn.title = 'Close (Esc)';
    const actions = el('div', 'dupes-actions');
    if (!ignoredView) actions.append(downloadButtons(lib));
    actions.append(closeBtn);
    const header = el('div', 'dupes-header');
    header.append(heading, actions);
    const scroller = el('div', 'dupes-scroll');

    const columns = [lib.kind === 'tv' ? 'Episode' : 'Title', 'Size', 'Resolution', 'Video', 'Audio', 'Path'];

    async function toggle(group, control) {
        control.disabled = true;
        const ignore = !ignoredView;
        if (!(await view.setIgnored(lib, group, ignore))) {
            control.disabled = false;
            return;
        }
        const [from, to] = ignore ? ['groups', 'ignored'] : ['ignored', 'groups'];
        lib[from] = lib[from].filter(g => g !== group);
        lib[to] = [...lib[to], group].sort((a, b) => a.order - b.order);
        draw();
        redrawSummaries();
    }

    function draw() {
        const groups = groupsOf();
        meta.textContent = `${groups.length} ${unitOf(lib.kind, groups.length)} · ${fileCount(groups)} files`;
        if (!groups.length) {
            scroller.replaceChildren(el('p', 'dupes-empty', ignoredView ? 'Nothing is ignored.' : 'No duplicates left.'));
            return;
        }

        const table = el('table', 'dupes-table');
        const headRow = el('tr');
        for (const h of columns) headRow.append(el('th', h === 'Size' ? 'num' : null, h));
        const thead = el('thead');
        thead.append(headRow);
        table.append(thead);

        let series;
        for (const group of groups) {
            // TV: a heading row each time the show changes (groups arrive sorted by show)
            if (lib.kind === 'tv' && group.series !== series) {
                series = group.series;
                const seriesHead = el('tbody', 'dupes-series');
                const row = el('tr');
                const cell = el('th', null, series);
                cell.colSpan = columns.length;
                row.append(cell);
                seriesHead.append(row);
                table.append(seriesHead);
            }
            const tbody = el('tbody');
            group.files.forEach((f, i) => {
                const row = el('tr');
                if (i === 0) {
                    const title = el('td', 'dupes-title');
                    if (lib.kind === 'tv') {
                        title.append(episodeCode(group.season, group.episode));
                        if (group.title) title.append(el('span', 'dupes-year', ` ${group.title}`));
                    } else {
                        title.append(group.title);
                        if (group.year) title.append(el('span', 'dupes-year', ` (${group.year})`));
                    }
                    const control = button(ignoredView ? 'Restore' : 'Ignore', 'link-btn dupes-ignore', () => toggle(group, control));
                    control.title = ignoredView
                        ? 'Show this duplicate in scans again'
                        : 'Hide this duplicate from future scans. It comes back if another copy appears.';
                    title.append(control);
                    title.rowSpan = group.files.length;
                    row.append(title);
                }
                const filePath = el('td', 'dupes-path');
                // a multi-episode file shows which episodes it holds
                if (f.note) filePath.append(el('span', 'dupes-tag', f.note));
                filePath.append(f.path || '');
                filePath.title = f.path || '';
                row.append(
                    el('td', 'num', formatFileSize(f.size)),
                    el('td', null, formatResolution(f)),
                    el('td', null, codec(f)),
                    el('td', null, audio(f)),
                    filePath,
                );
                tbody.append(row);
            });
            table.append(tbody);
        }
        scroller.replaceChildren(table);
    }

    draw();
    panel.append(header, scroller);
    overlay.append(panel);
    overlay.onclick = e => { if (e.target === overlay) close(); };
    document.addEventListener('keydown', onKey);
    document.documentElement.classList.add('dupes-open');
    document.body.append(overlay);
    closeBtn.focus();
}

// ---------- Exports ----------

export function resultsAsText(lib) {
    const lines = [`Duplicates in ${lib.name}: ${lib.groups.length} ${unit(lib)}, ${fileCount(lib.groups)} files`, ''];
    let series;
    for (const group of lib.groups) {
        if (lib.kind === 'tv') {
            if (group.series !== series) {
                series = group.series;
                lines.push(`== ${series} ==`, '');
            }
            lines.push(episodeLabel(group));
        } else {
            lines.push(titleWithYear(group));
        }
        group.files.forEach(f => lines.push(fileLine(f)));
        lines.push('');
    }
    return lines.join('\n');
}

const csvCell = value => {
    let text = value === undefined || value === null ? '' : String(value);
    // SECURITY: Excel runs a cell starting with = + - @ (or a tab or CR before one) as a
    // formula, e.g. a file named =HYPERLINK(...). A leading ' makes it plain text.
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

// One row per file. Starts with a byte-order mark so Excel reads accented titles correctly.
export function resultsAsCsv(lib) {
    const tv = lib.kind === 'tv';
    const header = [...(tv ? ['Series', 'Season', 'Episode', 'Title'] : ['Title', 'Year']),
        'Size (bytes)', 'Size', 'Resolution', 'Video', 'Audio', 'Note', 'Path'];
    const rows = lib.groups.flatMap(g => g.files.map(f => [
        ...(tv ? [g.series, g.season, g.episode, g.title] : [g.title, g.year]),
        f.size || 0, formatFileSize(f.size), formatResolution(f), f.videoCodec ? f.videoCodec.toUpperCase() : '',
        f.audio && f.audio !== 'Unknown' ? f.audio : '', f.note, f.path,
    ]));
    return `﻿${[header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function resultsAsJson(lib) {
    const tv = lib.kind === 'tv';
    return JSON.stringify({
        library: lib.name,
        kind: lib.kind,
        exportedAt: new Date().toISOString(),
        duplicates: lib.groups.map(g => ({
            ...(tv ? { series: g.series, season: g.season, episode: g.episode } : {}),
            title: g.title ?? null,
            ...(tv ? {} : { year: g.year ?? null }),
            files: g.files.map(f => ({
                path: f.path ?? null,
                sizeBytes: f.size || 0,
                resolution: formatResolution(f),
                width: f.width ?? null,
                height: f.height ?? null,
                videoCodec: f.videoCodec ?? null,
                audio: f.audio && f.audio !== 'Unknown' ? f.audio : null,
                ...(f.note ? { note: f.note } : {}),
            })),
        })),
    }, null, 2);
}

const EXPORTS = {
    txt: { render: resultsAsText, type: 'text/plain' },
    csv: { render: resultsAsCsv, type: 'text/csv' },
    json: { render: resultsAsJson, type: 'application/json' },
};

function downloadResults(lib, format) {
    const { render, type } = EXPORTS[format];
    const url = URL.createObjectURL(new Blob([render(lib)], { type: `${type};charset=utf-8` }));
    const a = el('a');
    a.href = url;
    a.download = `${lib.name.replace(/[^\w.-]+/g, '_')}_duplicates.${format}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

