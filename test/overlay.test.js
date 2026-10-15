'use strict';
// v0.5.0 destroyed and recreated the overlay window on every tray change (monitor, hidden kinds,
// cleared cache) and never re-asserted its topmost status. One window, changed in place, is the rule.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createOverlay, sameBounds, REASSERT_MS } = require('../overlay.js');

const A = { x: 0, y: 0, width: 1920, height: 1080 };
const B = { x: 1920, y: 0, width: 2560, height: 1440 };

function fakeWindow(bounds) {
	const calls = [];
	return {
		calls, bounds, destroyed: false, visible: true,
		setBounds(next) { calls.push(['setBounds', next]); this.bounds = next; },
		loadURL(url) { calls.push(['loadURL', url]); return Promise.resolve(); },
		isDestroyed() { return this.destroyed; },
		isVisible() { return this.visible; },
		destroy() { calls.push(['destroy']); this.destroyed = true; },
		setAlwaysOnTop(flag, level) { calls.push(['setAlwaysOnTop', flag, level]); },
		moveTop() { calls.push(['moveTop']); },
		webContents: { setAudioMuted: (muted) => calls.push(['setAudioMuted', muted]) },
	};
}

function harness() {
	const made = [];
	const timers = [];
	const overlay = createOverlay({
		createWindow: (bounds) => { const w = fakeWindow(bounds); made.push(w); return w; },
		setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
		clearTimer: (t) => { t.cleared = true; },
	});
	const only = (w, name) => w.calls.filter(([n]) => n === name);
	return { overlay, made, timers, only };
}

test('the first show creates the window once; the same url and bounds again change nothing', () => {
	const { overlay, made, timers, only } = harness();
	assert.deepEqual(overlay.show({ url: 'https://x/screen', bounds: A, muted: false }), ['created', 'loaded']);
	assert.equal(made.length, 1);
	assert.deepEqual(made[0].bounds, A);
	assert.deepEqual(only(made[0], 'loadURL'), [['loadURL', 'https://x/screen']]);
	assert.deepEqual(only(made[0], 'setAudioMuted'), [['setAudioMuted', false]]);
	assert.equal(timers.length, 1, 'the re-assert timer started');
	assert.equal(timers[0].ms, REASSERT_MS);

	assert.deepEqual(overlay.show({ url: 'https://x/screen', bounds: { ...A }, muted: false }), []);
	assert.equal(made.length, 1, 'no second window');
	assert.equal(only(made[0], 'loadURL').length, 1, 'no reload');
	assert.equal(only(made[0], 'setBounds').length, 0, 'no move');
	assert.equal(only(made[0], 'destroy').length, 0);
});

test('a new monitor moves the same window; a new url reloads it; neither recreates it', () => {
	const { overlay, made, only } = harness();
	overlay.show({ url: 'https://x/screen', bounds: A });
	assert.deepEqual(overlay.show({ url: 'https://x/screen', bounds: B }), ['moved']);
	assert.deepEqual(only(made[0], 'setBounds'), [['setBounds', B]]);
	assert.equal(only(made[0], 'loadURL').length, 1, 'a move is not a reload');

	assert.deepEqual(overlay.show({ url: 'https://x/screen?skip=banner', bounds: B }), ['loaded']);
	assert.deepEqual(only(made[0], 'loadURL').at(-1), ['loadURL', 'https://x/screen?skip=banner']);
	assert.equal(made.length, 1, 'still the one window');
	assert.equal(overlay.window, made[0]);
});

test('every show re-asserts topmost without focus, and so does the timer; a hidden window is left alone', () => {
	const { overlay, made, timers, only } = harness();
	made.length = 0;
	overlay.show({ url: 'https://x/screen', bounds: A });
	const w = made[0];
	assert.deepEqual(only(w, 'setAlwaysOnTop'), [['setAlwaysOnTop', true, 'screen-saver']]);
	assert.equal(only(w, 'moveTop').length, 1);

	w.visible = false;
	assert.equal(timers[0].fn(), false, 'not ready to show yet: nothing to assert');
	assert.equal(only(w, 'moveTop').length, 1);

	w.visible = true;
	assert.equal(timers[0].fn(), true);
	assert.equal(overlay.reassert(), true);
	assert.equal(only(w, 'moveTop').length, 3);
	assert.equal(only(w, 'setAlwaysOnTop').length, 3);
});

test('reload loads the current url again; setMuted reaches the page; both are no-ops without a window', () => {
	const { overlay, made, only } = harness();
	overlay.reload(); overlay.setMuted(true);
	assert.equal(made.length, 0);
	overlay.show({ url: 'https://x/screen', bounds: A });
	overlay.reload();
	assert.deepEqual(only(made[0], 'loadURL'), [['loadURL', 'https://x/screen'], ['loadURL', 'https://x/screen']]);
	overlay.setMuted(true);
	assert.deepEqual(only(made[0], 'setAudioMuted').at(-1), ['setAudioMuted', true]);
});

test('close destroys the window and stops the timer; the next show starts over with a new window', () => {
	const { overlay, made, timers, only } = harness();
	overlay.show({ url: 'https://x/screen', bounds: A });
	overlay.close();
	assert.deepEqual(only(made[0], 'destroy'), [['destroy']]);
	assert.equal(timers[0].cleared, true);
	assert.equal(overlay.window, null);
	overlay.close();
	assert.equal(only(made[0], 'destroy').length, 1, 'closing twice destroys once');

	assert.deepEqual(overlay.show({ url: 'https://x/screen', bounds: A }), ['created', 'loaded']);
	assert.equal(made.length, 2);
	assert.equal(timers.length, 2, 'a fresh timer for the fresh window');
});

test('a window that died on its own (crash, OS) is replaced by the next show', () => {
	const { overlay, made } = harness();
	overlay.show({ url: 'https://x/screen', bounds: A });
	made[0].destroyed = true;
	assert.equal(overlay.window, null);
	assert.deepEqual(overlay.show({ url: 'https://x/screen', bounds: A }), ['created', 'loaded']);
	assert.equal(made.length, 2);
});

test('sameBounds compares the four numbers and nothing else', () => {
	assert.equal(sameBounds(A, { ...A, id: 7 }), true);
	assert.equal(sameBounds(A, { ...A, width: 1921 }), false);
	assert.equal(sameBounds(null, A), false);
	assert.equal(sameBounds(A, undefined), false);
});
