// The one overlay window. It is created once per sign-in and then changed in place: new bounds when
// the monitor or its resolution changes (a game switching to fullscreen often changes it), a new URL
// when the streamer hides a kind, the same URL again after the cache is cleared or a load failed.
// It is never destroyed and recreated while signed in: a topmost window appearing over a game is
// what can knock an exclusive-fullscreen game out of its mode (a black flicker) and start a z-order
// fight, and neither can be verified on this machine (no Windows), so the window simply stays.
// Its topmost status is re-asserted on a timer and on every display change: Windows can demote a
// topmost window when a game toggles fullscreen or another topmost window appears, and nothing else
// ever brings it back. Pure: the window comes from an injected factory, so this runs under a fake.
'use strict';

const REASSERT_MS = 5_000;

function sameBounds(a, b) {
	return Boolean(a && b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * `createWindow(bounds)` returns a BrowserWindow (or a fake with the same methods): setBounds,
 * loadURL (a promise), isDestroyed, isVisible, destroy, setAlwaysOnTop, moveTop, and
 * webContents.setAudioMuted. The factory installs the window's own listeners; this never does.
 */
function createOverlay({ createWindow, log = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
	let window = null;
	let url = null;
	let bounds = null;
	let timer = null;
	const alive = () => window !== null && !window.isDestroyed();

	/** Topmost again, without taking focus. A hidden window (not ready yet) is left alone. */
	function reassert() {
		if (!alive() || !window.isVisible()) return false;
		try { window.setAlwaysOnTop(true, 'screen-saver'); window.moveTop(); } catch (error) { log(`topmost failed: ${error?.message ?? error}`); }
		return true;
	}

	return {
		/** The live window, or null. */
		get window() { return alive() ? window : null; },

		/**
		 * Makes the window match: created on the first call (or after it was destroyed), moved when
		 * the bounds differ, loading the URL only when it changed. Returns what it did, for the log:
		 * any of 'created', 'moved', 'loaded'; an empty list means nothing changed.
		 */
		show({ url: nextUrl, bounds: nextBounds, muted }) {
			const did = [];
			if (!alive()) {
				window = createWindow(nextBounds);
				bounds = nextBounds;
				url = null;
				did.push('created');
				if (!timer) { timer = setTimer(reassert, REASSERT_MS); timer?.unref?.(); }
			} else if (!sameBounds(bounds, nextBounds)) {
				window.setBounds(nextBounds);
				bounds = nextBounds;
				did.push('moved');
			}
			if (url !== nextUrl) {
				url = nextUrl;
				window.loadURL(nextUrl).catch(() => undefined);
				did.push('loaded');
			}
			if (muted !== undefined) window.webContents.setAudioMuted(muted);
			reassert();
			return did;
		},

		/** The same page again: after the cache was cleared, or when a load failed and it is time to retry. */
		reload() {
			if (alive() && url !== null) window.loadURL(url).catch(() => undefined);
		},

		setMuted(muted) {
			if (alive()) window.webContents.setAudioMuted(muted);
		},

		reassert,

		/** Signed out, or quitting: the window goes and the timer stops. The next show() makes a new one. */
		close() {
			if (timer) { clearTimer(timer); timer = null; }
			if (alive()) window.destroy();
			window = null;
			url = null;
			bounds = null;
		},
	};
}

module.exports = { createOverlay, sameBounds, REASSERT_MS };
