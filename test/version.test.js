import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APP_VERSION } from '../public/js/version.js';

test('the UI version matches package.json and the changelog', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(APP_VERSION, pkg.version);
    const changelog = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
    assert.match(changelog, new RegExp(`^## ${pkg.version.replaceAll('.', '\\.')}\\b`, 'm'), 'CHANGELOG.md has an entry for this version');
});
