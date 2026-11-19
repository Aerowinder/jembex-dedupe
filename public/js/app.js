// Page wiring: form state, theme, saved configs, library picker, notifications, and the scan.
//
// Flow: enter server details → "Load libraries" lists every movie and TV library (with item
// counts) → tick the ones to scan → "Scan". Each library is scanned by its own kind.
//
// Every request to the media server goes through this app's backend (/api/media), which
// adds the API key. A saved server's key never comes back to the browser: leave the key
// field empty and the backend uses the key saved for that URL.

import { SERVERS, createClient, normalizeServerUrl, proxyTransport } from './servers/index.js';
import { applyIgnores, findDuplicateGroups, groupFileIds, MOVIES, EPISODES } from './dedupe.js';
import { groupLabel, renderSummaries } from './results.js';
import { formatTimeLeft } from './format.js';
import { APP_VERSION } from './version.js';

const $ = id => document.getElementById(id);
const form = {
    root: $('scanForm'),
    type: $('serverType'),
    url: $('serverUrl'),
    key: $('apiKey'),
    keyLabel: $('apiKeyLabel'),
    save: $('saveConfig'),
    configs: $('savedConfigs'),
    configSelect: $('configSelect'),
    configLoad: $('loadConfigBtn'),
    configDelete: $('deleteConfigBtn'),
    loadLibraries: $('loadLibrariesBtn'),
    picker: $('libraryPicker'),
    libraryList: $('libraryList'),
    toggleAll: $('toggleAllLibraries'),
    reload: $('reloadLibraries'),
    scan: $('scanBtn'),
};
const results = $('results');
const summary = {
    root: $('connectionSummary'),
    server: document.querySelector('#connectionSummary .summary-server'),
    detail: document.querySelector('#connectionSummary .summary-detail'),
    rescan: $('rescanBtn'),
    change: $('changeServerBtn'),
};
const cancelButton = $('cancelScan');

const KINDS = {
    movies: { rules: MOVIES, label: 'Movies', noun: 'movies', one: 'movie' },
    tv: { rules: EPISODES, label: 'TV', noun: 'episodes', one: 'episode' },
};

const store = {
    get: key => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

const number = n => n.toLocaleString();

// ---------- Notifications ----------

function notify(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    const dismiss = () => {
        toast.classList.add('toast-out');
        setTimeout(() => toast.remove(), 300);
    };
    toast.onclick = dismiss;
    document.body.append(toast);
    setTimeout(dismiss, 5000);
}

function showMessage(text) {
    const p = document.createElement('p');
    p.textContent = text;
    results.replaceChildren(p);
}

// ---------- Progress ----------

const progress = (() => {
    const overlay = $('loading-overlay');
    const label = overlay.querySelector('.progress-label');
    const bar = overlay.querySelector('.progress');
    const fill = overlay.querySelector('.progress-fill');
    const count = overlay.querySelector('.progress-count');

    // Time left is measured per phase (listing, then Plex details), from the phase's first
    // step, and counts down between pages.
    let phase = null; // { key, startedAt, startDone, deadline, countText }
    let ticker = null;

    const render = () => {
        let eta = '';
        if (phase?.deadline) eta = ` · ${formatTimeLeft(Math.max(0, (phase.deadline - Date.now()) / 1000))}`;
        else if (phase) eta = ' · estimating time remaining…';
        count.textContent = phase ? phase.countText + eta : '';
    };

    // Jump the fill without animating, so nothing from a previous state slides into view
    const setFill = width => {
        fill.style.transition = 'none';
        fill.style.width = width;
        void fill.offsetWidth; // flush, then let later steps animate again
        fill.style.transition = '';
    };

    return {
        // Nothing to measure yet: a faint shimmer, never a partial fill
        waiting(text) {
            overlay.classList.remove('hidden');
            label.textContent = text;
            bar.classList.add('indeterminate');
            bar.removeAttribute('aria-valuenow');
            setFill('0%');
            phase = null;
            render();
        },

        step(text, done, total, noun) {
            if (!total) return this.waiting(text);
            overlay.classList.remove('hidden');
            const key = `${noun}|${total}`;
            if (phase?.key !== key) {
                if (bar.classList.contains('indeterminate')) {
                    bar.classList.remove('indeterminate');
                    setFill('0%');
                }
                phase = { key, startedAt: Date.now(), startDone: done, deadline: null };
            }
            const pct = Math.min(100, Math.round((done / total) * 100));
            label.textContent = text;
            bar.setAttribute('aria-valuenow', pct);
            fill.style.width = `${pct}%`;

            const progressed = done - phase.startDone;
            const elapsed = (Date.now() - phase.startedAt) / 1000;
            if (progressed > 0 && elapsed > 0.5 && done < total) {
                phase.deadline = Date.now() + ((total - done) / (progressed / elapsed)) * 1000;
            } else if (done >= total) {
                phase.deadline = null;
            }
            phase.countText = `${number(Math.min(done, total))} / ${number(total)} ${noun}`;
            render();
            ticker ??= setInterval(render, 1000);
        },

        done() {
            overlay.classList.add('hidden');
            clearInterval(ticker);
            ticker = null;
            phase = null;
            cancelButton.disabled = false;
            cancelButton.textContent = 'Cancel';
        },
    };
})();

// ---------- Theme ----------

function applyServerType(type) {
    for (const name of Object.keys(SERVERS)) document.body.classList.toggle(`theme-${name}`, name === type);
    form.keyLabel.textContent = SERVERS[type].keyLabel;
    form.url.placeholder = SERVERS[type].urlPlaceholder;
    updateKeyHint();
}

function applyLightMode(light) {
    document.body.classList.toggle('light-mode', light);
    document.querySelector('.theme-toggle').textContent = light ? '☀️' : '🌓';
}

// ---------- Saved configs (stored server-side in /config) ----------

let savedConfigs = []; // { filename, displayName, serverType, serverUrl, hasKey }: never the key itself

async function refreshConfigs() {
    try {
        const response = await fetch(`/api/configs/${form.type.value}`);
        savedConfigs = response.ok ? await response.json() : [];
    } catch {
        savedConfigs = [];
    }
    form.configSelect.replaceChildren(new Option('Choose…', ''));
    savedConfigs.forEach(c => form.configSelect.append(new Option(c.displayName, c.filename)));
    form.configs.hidden = !savedConfigs.length;
    updateKeyHint();
}

const selectedConfig = () => savedConfigs.find(c => c.filename === form.configSelect.value);

// The saved server for the URL in the form, if any: its key is used when the key field is empty
function savedServerForUrl(url) {
    const wanted = normalizeServerUrl(url);
    return wanted ? savedConfigs.find(c => c.hasKey && normalizeServerUrl(c.serverUrl) === wanted) : undefined;
}

function updateKeyHint() {
    const server = SERVERS[form.type.value];
    form.key.placeholder = savedServerForUrl(form.url.value)
        ? `Saved ${server.keyNoun} will be used (type a new one to replace it)`
        : server.keyPlaceholder;
}

function loadSelectedConfig() {
    const config = selectedConfig();
    if (!config) return;
    form.type.value = config.serverType;
    form.url.value = config.serverUrl;
    form.key.value = '';
    store.set('serverUrl', config.serverUrl);
    applyServerType(config.serverType);
    resetLibraries();
    notify(`Config "${config.displayName}" loaded`, 'success');
}

async function deleteSelectedConfig() {
    const config = selectedConfig();
    if (!config || !confirm(`Delete the saved config "${config.displayName}"?`)) return;
    try {
        const response = await fetch(`/api/configs/${config.serverType}/${encodeURIComponent(config.filename)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error((await response.json()).error);
        notify(`Config "${config.displayName}" deleted`, 'success');
        refreshConfigs();
    } catch (err) {
        notify(`Error deleting config: ${err.message}`, 'error');
    }
}

async function saveConfig(serverType, serverUrl, apiKey) {
    try {
        const response = await fetch(`/api/configs/${serverType}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ serverUrl, apiKey }),
        });
        if (!response.ok) throw new Error((await response.json()).error);
        notify(`Saved "${serverUrl}"`, 'success');
        form.save.checked = false;
        await refreshConfigs();
        return true;
    } catch (err) {
        notify(`Error saving config: ${err.message}`, 'error');
        return false;
    }
}

// ---------- Library picker ----------
// The libraries shown belong to one connection; editing the server details discards them.

let connection = null; // { serverType, serverUrl, apiKey, libraries: [{ id, name, kind, count }] }

const connectionKey = c => `libraries:${c.serverType}|${normalizeServerUrl(c.serverUrl)}`;

// apiKey is null when the field is empty: the backend then uses the saved key
function readForm() {
    return { serverType: form.type.value, serverUrl: form.url.value.trim(), apiKey: form.key.value.trim() || null };
}

const clientFor = (server, signal) => createClient(server.serverType, proxyTransport(server, signal));

function resetLibraries() {
    connection = null;
    form.picker.hidden = true;
    form.loadLibraries.hidden = false;
    form.libraryList.replaceChildren();
}

const libraryBoxes = () => [...form.libraryList.querySelectorAll('input[type="checkbox"]')];
const selectedLibraries = () => {
    const ids = new Set(libraryBoxes().filter(box => box.checked).map(box => box.value));
    return connection ? connection.libraries.filter(lib => ids.has(lib.id)) : [];
};

function updatePickerState() {
    const boxes = libraryBoxes();
    const selected = boxes.filter(box => box.checked).length;
    form.scan.disabled = !selected || Boolean(activeScan);
    form.scan.textContent = selected ? `Scan ${selected} ${selected === 1 ? 'library' : 'libraries'}` : 'Select a library';
    form.toggleAll.textContent = selected === boxes.length ? 'Select none' : 'Select all';
    if (connection) store.set(connectionKey(connection), JSON.stringify(boxes.filter(b => b.checked).map(b => b.value)));
}

function renderLibraries() {
    let remembered = null;
    try { remembered = JSON.parse(store.get(connectionKey(connection))); } catch { /* none saved */ }
    const rows = connection.libraries.map(lib => {
        const row = document.createElement('label');
        row.className = 'library-option';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.value = lib.id;
        box.checked = Array.isArray(remembered) ? remembered.includes(lib.id) : true;
        box.addEventListener('change', updatePickerState);
        const name = document.createElement('span');
        name.className = 'library-name';
        name.textContent = lib.name;
        const meta = document.createElement('span');
        meta.className = 'library-meta';
        meta.dataset.libraryId = lib.id;
        meta.textContent = KINDS[lib.kind].label;
        row.append(box, name, meta);
        return row;
    });
    form.libraryList.replaceChildren(...rows);
    form.loadLibraries.hidden = true;
    form.picker.hidden = false;
    updatePickerState();
}

function showCount(lib) {
    const meta = [...form.libraryList.querySelectorAll('.library-meta')].find(m => m.dataset.libraryId === lib.id);
    const kind = KINDS[lib.kind];
    if (meta) meta.textContent = `${number(lib.count)} ${lib.count === 1 ? kind.one : kind.noun}`;
}

async function loadLibraries() {
    const details = readForm();
    if (!details.serverUrl) {
        notify('Server URL is required', 'error');
        return;
    }
    if (!details.apiKey && !savedServerForUrl(details.serverUrl)) {
        notify('API key is required', 'error');
        return;
    }
    // Once saved, scan with the saved key and clear it from the page
    if (form.save.checked && details.apiKey && await saveConfig(details.serverType, details.serverUrl, details.apiKey)) {
        form.key.value = '';
        details.apiKey = null;
        updateKeyHint();
    }

    results.replaceChildren();
    form.loadLibraries.disabled = true;
    form.loadLibraries.textContent = 'Connecting…';
    try {
        const client = clientFor(details);
        const libraries = (await client.listLibraries()).map(lib => ({ ...lib, count: null }));
        if (!libraries.length) throw new Error('No movie or TV libraries found on this server');
        connection = { ...details, libraries };
        renderLibraries();
        // Counts fill in as they arrive; the scan's progress bar reuses them
        const thisConnection = connection;
        libraries.forEach(lib => client.countItems(lib)
            .then(count => {
                lib.count = count;
                if (connection === thisConnection) showCount(lib);
            })
            .catch(() => { /* the bar just won't measure this library */ }));
    } catch (err) {
        resetLibraries();
        showMessage(`Error: ${err.message}`);
    } finally {
        form.loadLibraries.disabled = false;
        form.loadLibraries.textContent = 'Load libraries';
    }
}

// ---------- Collapsed form ----------
// After a scan, the form folds into one line so the results start near the top of the page

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function collapseForm(libraries) {
    summary.server.textContent = SERVERS[connection.serverType].label ?? connection.serverType;
    const count = `${libraries.length} ${libraries.length === 1 ? 'library' : 'libraries'}`;
    summary.detail.textContent = `${connection.serverUrl} · ${count}`;
    summary.detail.title = libraries.map(lib => lib.name).join(', ');
    form.root.hidden = true;
    summary.root.hidden = false;
    summary.root.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

function expandForm() {
    summary.root.hidden = true;
    form.root.hidden = false;
    form.scan.focus();
}

// ---------- Scan ----------

let activeScan = null; // AbortController of the running scan

// ---------- Ignored duplicates (stored in the container, per server) ----------

const ignoreUrl = server => `/api/ignored/${server.serverType}`;

async function loadIgnored(server) {
    try {
        const response = await fetch(`${ignoreUrl(server)}?${new URLSearchParams({ serverUrl: server.serverUrl })}`);
        if (!response.ok) throw new Error((await response.json()).error);
        return (await response.json()).entries;
    } catch (err) {
        notify(`Couldn't read the ignore list, so nothing is hidden: ${err.message}`, 'warning');
        return [];
    }
}

// Called by the results view; resolves to whether the change was saved
function ignoreHandler(server) {
    return async (lib, group, ignore) => {
        try {
            const body = ignore
                ? { serverUrl: server.serverUrl, key: group.ignoreKey, label: groupLabel(lib, group), paths: groupFileIds(group) }
                : { serverUrl: server.serverUrl, key: group.ignoreKey };
            const response = await fetch(ignoreUrl(server), {
                method: ignore ? 'POST' : 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!response.ok) throw new Error((await response.json()).error);
            return true;
        } catch (err) {
            notify(`Couldn't ${ignore ? 'ignore' : 'restore'} "${groupLabel(lib, group)}": ${err.message}`, 'error');
            return false;
        }
    };
}

function cancelScan() {
    if (!activeScan) return;
    cancelButton.disabled = true;
    cancelButton.textContent = 'Cancelling…';
    activeScan.abort();
}

async function scan() {
    const libraries = selectedLibraries();
    if (activeScan || !connection || !libraries.length) return;

    results.replaceChildren();
    activeScan = new AbortController();
    form.scan.disabled = true;
    summary.rescan.disabled = true;
    try {
        const server = { serverType: connection.serverType, serverUrl: connection.serverUrl, apiKey: connection.apiKey };
        const client = clientFor(server, activeScan.signal);
        const ignoreEntries = await loadIgnored(server);

        // One bar for the whole scan, using the counts from the picker (re-counted if missing)
        if (libraries.some(lib => lib.count === null)) progress.waiting('Counting…');
        await Promise.all(libraries.filter(lib => lib.count === null).map(lib => client.countItems(lib)
            .then(count => { lib.count = count; })
            .catch(err => { if (err.name === 'AbortError') throw err; })));
        const total = libraries.reduce((sum, lib) => sum + (lib.count || 0), 0);
        const kinds = new Set(libraries.map(lib => lib.kind));
        const noun = kinds.size === 1 ? KINDS[[...kinds][0]].noun : 'items';
        let done = 0;

        const scanned = [];
        for (const library of libraries) {
            const { rules } = KINDS[library.kind];
            const label = `Scanning ${library.name}…`;
            progress.step(label, done, total, noun);
            const items = await client.listItems(library, n => {
                done += n;
                progress.step(label, done, total, noun);
            });
            let { shown, ignored } = applyIgnores(findDuplicateGroups(items, rules), ignoreEntries, library.kind);
            if (client.enrich && shown.length) {
                // Plex: per-version audio details, only for the duplicates still to deal with
                const ids = new Set(shown.flatMap(g => g.files.map(f => f.itemId)));
                const targets = items.filter(item => ids.has(item.id));
                const detailLabel = `Reading details for ${library.name}…`;
                let read = 0;
                progress.step(detailLabel, 0, targets.length, 'items');
                await client.enrich(targets, () => progress.step(detailLabel, ++read, targets.length, 'items'));
                ({ shown, ignored } = applyIgnores(findDuplicateGroups(items, rules), ignoreEntries, library.kind));
            }
            scanned.push({ name: library.name, kind: library.kind, groups: shown, ignored });
        }
        renderSummaries(results, scanned, { setIgnored: ignoreHandler(server) });
        collapseForm(libraries);
    } catch (err) {
        if (err.name === 'AbortError') {
            showMessage('Scan cancelled.');
        } else {
            console.error(err);
            showMessage(`Error: ${err.message}`);
        }
    } finally {
        activeScan = null;
        summary.rescan.disabled = false;
        progress.done();
        updatePickerState();
    }
}

// ---------- Init ----------

$('appVersion').textContent = `v${APP_VERSION}`;

// Keys are never kept in the browser; clear one an older version stored
try { localStorage.removeItem('apiKey'); } catch { /* private mode */ }

const storedType = store.get('serverType');
form.type.value = SERVERS[storedType] ? storedType : 'emby';
form.url.value = store.get('serverUrl') || '';
applyServerType(form.type.value);
applyLightMode(store.get('theme') === 'light');
refreshConfigs();

form.type.addEventListener('change', () => {
    store.set('serverType', form.type.value);
    applyServerType(form.type.value);
    resetLibraries();
    refreshConfigs();
});
form.url.addEventListener('input', () => {
    resetLibraries();
    updateKeyHint();
});
form.url.addEventListener('change', () => store.set('serverUrl', form.url.value.trim()));
form.key.addEventListener('input', resetLibraries);

// Enter in any field: load libraries, or scan once they're listed
form.root.addEventListener('submit', event => {
    event.preventDefault();
    if (connection) scan(); else loadLibraries();
});
form.scan.addEventListener('click', scan);
summary.rescan.addEventListener('click', scan);
summary.change.addEventListener('click', expandForm);
form.reload.addEventListener('click', loadLibraries);
form.toggleAll.addEventListener('click', () => {
    const boxes = libraryBoxes();
    const selectAll = boxes.some(box => !box.checked);
    boxes.forEach(box => { box.checked = selectAll; });
    updatePickerState();
});
form.configLoad.addEventListener('click', loadSelectedConfig);
form.configDelete.addEventListener('click', deleteSelectedConfig);
cancelButton.addEventListener('click', cancelScan);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && activeScan) cancelScan();
});
document.querySelector('.theme-toggle').addEventListener('click', () => {
    const light = !document.body.classList.contains('light-mode');
    applyLightMode(light);
    store.set('theme', light ? 'light' : 'dark');
});
