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

test('the tray and app icons the code and the build name exist, at the sizes macOS and Windows need', () => {
	const root = path.join(__dirname, '..');
	const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
	const build = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build;
	// A PNG's size sits in its IHDR chunk, bytes 16 to 24.
	const size = (name) => { const png = fs.readFileSync(path.join(root, 'assets', name)); return [png.readUInt32BE(16), png.readUInt32BE(20)]; };
	for (const name of ['trayTemplate.png', 'tray.ico', 'tray.png']) assert.ok(main.includes(`'${name}'`), `main.js uses ${name}`);
	// macOS takes a tray image as a template only by its name, and finds the @2x beside it by name too.
	assert.deepEqual(size('trayTemplate@2x.png').map((n) => n / 2), size('trayTemplate.png'));
	assert.ok(size('trayTemplate.png')[1] <= 22, 'no taller than the menu bar');
	const ico = fs.readFileSync(path.join(root, 'assets', 'tray.ico'));
	const icoSizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => ico.readUInt8(6 + 16 * i));
	for (const px of [16, 20, 24, 32]) assert.ok(icoSizes.includes(px), `tray.ico has ${px} px (Windows at ${px / 16 * 100}%)`);
	for (const icon of [build.win.icon, build.mac.icon]) assert.deepEqual(size(icon.replace('assets/', '')), [1024, 1024], icon);
	assert.ok(build.files.includes('assets/**'));
});

test('electron-updater is a runtime dependency, not a dev one', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
	assert.ok(pkg.dependencies['electron-updater']);
	assert.equal(pkg.devDependencies['electron-updater'], undefined);
});

test('CI leaves a release a draft for sign-release, and every action it runs is pinned to a commit', () => {
	const workflows = path.join(__dirname, '..', '.github', 'workflows');
	const release = fs.readFileSync(path.join(workflows, 'release.yml'), 'utf8').replace(/\r\n/g, '\n'); // a Windows checkout has CRLF
	assert.match(release, /softprops\/action-gh-release@[0-9a-f]{40}[^\n]*\n\s+with:[\s\S]*?\n\s+draft: true\n/);
	for (const name of fs.readdirSync(workflows)) {
		for (const [, action] of fs.readFileSync(path.join(workflows, name), 'utf8').matchAll(/uses: (\S+)/g)) assert.match(action, /@[0-9a-f]{40}$/, `${name}: ${action}`);
	}
});
