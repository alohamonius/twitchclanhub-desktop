'use strict';
// v0.4.0 shipped without log.js in the installer's file list and crashed on launch. Every local
// module the main process requires must be in build.files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('every local module main.js requires is packaged', () => {
	const root = path.join(__dirname, '..');
	const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
	const files = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.files;
	const needed = [...main.matchAll(/require\('\.\/([^']+)'\)/g)].map((match) => match[1]);
	assert.ok(needed.length >= 3, 'found the requires');
	for (const name of needed) {
		assert.ok(fs.existsSync(path.join(root, name)), `${name} exists`);
		assert.ok(files.includes(name), `${name} is in build.files`);
	}
	// and what those modules require in turn
	for (const name of needed) {
		for (const match of fs.readFileSync(path.join(root, name), 'utf8').matchAll(/require\('\.\/([^']+)'\)/g)) assert.ok(files.includes(match[1]), `${match[1]} (required by ${name}) is in build.files`);
	}
});

test('electron-updater is a runtime dependency, not a dev one', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
	assert.ok(pkg.dependencies['electron-updater']);
	assert.equal(pkg.devDependencies['electron-updater'], undefined);
});
