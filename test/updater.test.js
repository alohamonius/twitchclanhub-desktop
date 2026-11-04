'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createUpdater } = require('../updater.js');

const settled = () => new Promise((resolve) => setImmediate(resolve));

function fake() {
	const updater = Object.assign(new EventEmitter(), { checks: 0, installed: 0, fail: false,
		async checkForUpdates() { this.checks++; if (this.fail) throw new Error('offline'); },
		quitAndInstall(silent, forceRun) { this.installed++; this.args = [silent, forceRun]; } });
	return updater;
}

test('a found update downloads on its own and is ready only after its signature checks; only then can it be installed', async () => {
	const auto = fake(); const seen = []; const verified = [];
	const u = createUpdater({ autoUpdater: auto, supported: true, verify: async (info) => { verified.push(info.downloadedFile); return null; }, onChange: (s) => seen.push(s.phase + (s.percent !== undefined ? `:${s.percent}` : '')) });
	assert.equal(auto.autoDownload, true);
	u.installNow(); assert.equal(auto.installed, 0, 'nothing to install yet');
	await u.check();
	auto.emit('checking-for-update'); auto.emit('update-available', { version: '0.5.0' });
	auto.emit('download-progress', { percent: 41.6 }); auto.emit('update-downloaded', { version: '0.5.0', downloadedFile: 'C:/pending/setup.exe' });
	assert.equal(u.state.phase, 'verifying');
	u.installNow(); assert.equal(auto.installed, 0, 'not while the signature is being checked');
	await settled();
	assert.deepEqual(seen, ['checking', 'downloading:0', 'downloading:42', 'verifying', 'ready']);
	assert.deepEqual(verified, ['C:/pending/setup.exe']);
	assert.equal(u.state.version, '0.5.0');
	u.installNow();
	assert.deepEqual([auto.installed, auto.args], [1, [false, true]], 'quits, installs and runs the app again');
});

test('nothing installs by itself on quit, and no older version is taken', () => {
	const auto = fake(); createUpdater({ autoUpdater: auto, supported: true });
	assert.equal(auto.autoInstallOnAppQuit, false);
	assert.equal(auto.allowDowngrade, false);
});

test('an update whose signature fails is refused and cannot be installed; the next check tries it again', async () => {
	const auto = fake(); let answer = 'not signed by the release key';
	const u = createUpdater({ autoUpdater: auto, supported: true, verify: async () => answer });
	auto.emit('update-downloaded', { version: '0.5.0' }); await settled();
	assert.deepEqual(u.state, { phase: 'refused', version: '0.5.0', message: 'not signed by the release key' });
	u.installNow(); assert.equal(auto.installed, 0);
	await u.check(); assert.equal(auto.checks, 1, 'a refused update does not stop later checks');
	answer = null; auto.emit('update-downloaded', { version: '0.5.0' }); await settled();
	assert.equal(u.state.phase, 'ready');
});

test('a check that throws, and an updater given no check at all, refuse rather than install', async () => {
	const throwing = fake(); const a = createUpdater({ autoUpdater: throwing, supported: true, verify: async () => { throw new Error('disk gone'); } });
	throwing.emit('update-downloaded', { version: '0.5.0' }); await settled();
	assert.deepEqual([a.state.phase, a.state.message], ['refused', 'disk gone']);
	const unchecked = fake(); const b = createUpdater({ autoUpdater: unchecked, supported: true });
	unchecked.emit('update-downloaded', { version: '0.5.0' }); await settled();
	assert.equal(b.state.phase, 'refused');
	b.installNow(); assert.equal(unchecked.installed, 0);
});

test('no update goes back to idle; a failed check is an error that a later check can leave', async () => {
	const auto = fake(); const u = createUpdater({ autoUpdater: auto, supported: true });
	auto.emit('update-not-available'); assert.equal(u.state.phase, 'idle');
	auto.fail = true; await u.check(); assert.equal(u.state.phase, 'error');
	auto.fail = false; await u.check(); assert.equal(auto.checks, 2, 'an error does not stop later checks');
});

test('it does not check again while one is running, downloading, verifying or ready', async () => {
	const auto = fake(); const u = createUpdater({ autoUpdater: auto, supported: true, verify: async () => null });
	auto.emit('checking-for-update'); await u.check();
	auto.emit('update-available', { version: '0.5.0' }); await u.check();
	auto.emit('update-downloaded', { version: '0.5.0' }); await u.check();
	await settled(); assert.equal(u.state.phase, 'ready'); await u.check();
	assert.equal(auto.checks, 0);
});

test('unsupported (macOS, a dev run) never touches the updater and start schedules nothing', async () => {
	const auto = fake(); let timers = 0;
	const u = createUpdater({ autoUpdater: auto, supported: false, setLater: () => { timers++; }, setTimer: () => { timers++; } });
	await u.check(); u.start(); u.installNow();
	assert.deepEqual([u.state.phase, auto.checks, auto.installed, timers, auto.autoDownload], ['unsupported', 0, 0, 0, undefined]);
});

test('start checks soon after launch and then on an interval', () => {
	const auto = fake(); const scheduled = [];
	const u = createUpdater({ autoUpdater: auto, supported: true, setLater: (fn, ms) => { scheduled.push(['later', ms]); return { unref() {} }; }, setTimer: (fn, ms) => { scheduled.push(['every', ms]); return { unref() {} }; } });
	u.start();
	assert.deepEqual(scheduled, [['later', 20000], ['every', 21600000]]);
});
