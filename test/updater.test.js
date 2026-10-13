'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createUpdater } = require('../updater.js');

function fake() {
	const updater = Object.assign(new EventEmitter(), { checks: 0, installed: 0, fail: false,
		async checkForUpdates() { this.checks++; if (this.fail) throw new Error('offline'); },
		quitAndInstall(silent, forceRun) { this.installed++; this.args = [silent, forceRun]; } });
	return updater;
}

test('a found update downloads on its own, reports progress and ends ready; only then can it be installed', async () => {
	const auto = fake(); const seen = [];
	const u = createUpdater({ autoUpdater: auto, supported: true, onChange: (s) => seen.push(s.phase + (s.percent !== undefined ? `:${s.percent}` : '')) });
	assert.equal(auto.autoDownload, true); assert.equal(auto.autoInstallOnAppQuit, true);
	u.installNow(); assert.equal(auto.installed, 0, 'nothing to install yet');
	await u.check();
	auto.emit('checking-for-update'); auto.emit('update-available', { version: '0.5.0' });
	auto.emit('download-progress', { percent: 41.6 }); auto.emit('update-downloaded', { version: '0.5.0' });
	assert.deepEqual(seen, ['checking', 'downloading:0', 'downloading:42', 'ready']);
	assert.equal(u.state.version, '0.5.0');
	u.installNow();
	assert.deepEqual([auto.installed, auto.args], [1, [false, true]], 'quits, installs and runs the app again');
});

test('no update goes back to idle; a failed check is an error that a later check can leave', async () => {
	const auto = fake(); const u = createUpdater({ autoUpdater: auto, supported: true });
	auto.emit('update-not-available'); assert.equal(u.state.phase, 'idle');
	auto.fail = true; await u.check(); assert.equal(u.state.phase, 'error');
	auto.fail = false; await u.check(); assert.equal(auto.checks, 2, 'an error does not stop later checks');
});

test('it does not check again while one is running, downloading or ready', async () => {
	const auto = fake(); const u = createUpdater({ autoUpdater: auto, supported: true });
	auto.emit('checking-for-update'); await u.check();
	auto.emit('update-available', { version: '0.5.0' }); await u.check();
	auto.emit('update-downloaded', { version: '0.5.0' }); await u.check();
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
