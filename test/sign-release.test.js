'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseLatest, releaseProblem } = require('../scripts/sign-release.js');

// v0.6.2's latest.yml as electron-builder wrote it.
const latest = `version: 0.6.2
files:
  - url: twitchclanhub-setup.exe
    sha512: JKVV3TI0cpmH3vm3IS1bseyLt9vneYlePLyCmNhJgNXO9dW3DgZNTUT7yRF7ddtjZ9Bc1mTYMzTc3267t+Psfw==
    size: 82033769
path: twitchclanhub-setup.exe
sha512: JKVV3TI0cpmH3vm3IS1bseyLt9vneYlePLyCmNhJgNXO9dW3DgZNTUT7yRF7ddtjZ9Bc1mTYMzTc3267t+Psfw==
releaseDate: '2026-11-04T11:11:55.592Z'
`;

test('reads the version and the installer hash from latest.yml', () => {
	assert.deepEqual(parseLatest(latest, 'twitchclanhub-setup.exe'), { version: '0.6.2', sha512: 'JKVV3TI0cpmH3vm3IS1bseyLt9vneYlePLyCmNhJgNXO9dW3DgZNTUT7yRF7ddtjZ9Bc1mTYMzTc3267t+Psfw==' });
	assert.equal(parseLatest(latest, 'other.exe').sha512, undefined);
});

const bot = { login: 'github-actions[bot]' };
const draft = { draft: true, assets: ['latest.yml', 'twitchclanhub-setup.exe', 'twitchclanhub-setup.exe.blockmap', 'twitchclanhub-mac.dmg'].map((name) => ({ name, uploader: bot })) };

test('signs only a draft CI built from a commit on main', () => {
	assert.equal(releaseProblem({ release: draft, tag: 'v0.6.3', onMain: true }), null);
	assert.match(releaseProblem({ release: undefined, tag: 'v0.6.3', onMain: false }), /no release/);
	assert.match(releaseProblem({ release: { ...draft, draft: false }, tag: 'v0.6.3', onMain: true }), /already published/);
	assert.equal(releaseProblem({ release: { ...draft, draft: false }, tag: 'v0.6.3', onMain: true, dryRun: true }), null, 'a dry run may look at a published one');
	assert.match(releaseProblem({ release: draft, tag: 'v0.6.3', onMain: false }), /not on main/);
	const swapped = { ...draft, assets: draft.assets.map((a) => (a.name === 'twitchclanhub-setup.exe' ? { ...a, uploader: { login: 'someone' } } : a)) };
	assert.match(releaseProblem({ release: swapped, tag: 'v0.6.3', onMain: true }), /not uploaded by CI: twitchclanhub-setup\.exe \(someone\)/);
	const noYml = { ...draft, assets: draft.assets.filter((a) => a.name !== 'latest.yml') };
	assert.match(releaseProblem({ release: noYml, tag: 'v0.6.3', onMain: true }), /has no latest\.yml/);
	const resigned = { ...draft, assets: [...draft.assets, { name: 'twitchclanhub-setup.exe.sig', uploader: { login: 'alohamonius' } }] };
	assert.equal(releaseProblem({ release: resigned, tag: 'v0.6.3', onMain: true }), null, 'our own earlier .sig is no reason to stop');
});
