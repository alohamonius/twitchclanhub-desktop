// Auto-update for the Windows build, from the latest GitHub Release of this public repo
// (electron-updater reads latest.yml next to the installer; no token). A small state machine so the
// tray can show it and it can be tested with a fake updater. macOS is not wired: its updates need a
// signed app, so it stays manual for now.
'use strict';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 20 * 1000;

/**
 * `autoUpdater`: electron-updater's (or a fake with .on/.checkForUpdates/.quitAndInstall).
 * `onChange(state)` fires on every transition: { phase: 'idle'|'checking'|'downloading'|'ready'|'error'|'unsupported', version?, percent?, message? }.
 */
function createUpdater({ autoUpdater, supported, log = () => {}, onChange = () => {}, setTimer = setInterval, setLater = setTimeout }) {
	let state = { phase: supported ? 'idle' : 'unsupported' };
	let timers = [];
	const set = (next) => { state = next; onChange(state); };

	if (supported) {
		autoUpdater.autoDownload = true;
		autoUpdater.autoInstallOnAppQuit = true;
		autoUpdater.on('checking-for-update', () => { log('update: checking'); set({ phase: 'checking' }); });
		autoUpdater.on('update-not-available', () => { log('update: none'); set({ phase: 'idle' }); });
		autoUpdater.on('update-available', (info) => { log(`update: ${info?.version} available, downloading`); set({ phase: 'downloading', version: info?.version, percent: 0 }); });
		autoUpdater.on('download-progress', (progress) => set({ phase: 'downloading', version: state.version, percent: Math.round(progress?.percent ?? 0) }));
		autoUpdater.on('update-downloaded', (info) => { log(`update: ${info?.version} ready`); set({ phase: 'ready', version: info?.version }); });
		autoUpdater.on('error', (error) => { log(`update error: ${error?.message ?? error}`); set({ phase: 'error', message: String(error?.message ?? error).slice(0, 200) }); });
	}

	async function check() {
		if (!supported || state.phase === 'checking' || state.phase === 'downloading' || state.phase === 'ready') return state;
		try { await autoUpdater.checkForUpdates(); } catch (error) { log(`update check failed: ${error?.message ?? error}`); set({ phase: 'error', message: String(error?.message ?? error).slice(0, 200) }); }
		return state;
	}

	return {
		get state() { return state; },
		check,
		/** Checks shortly after start, then every six hours. */
		start() {
			if (!supported) return;
			timers = [setLater(() => void check(), FIRST_CHECK_MS), setTimer(() => void check(), CHECK_EVERY_MS)];
			for (const timer of timers) timer?.unref?.();
		},
		stop() { for (const timer of timers) { clearTimeout(timer); clearInterval(timer); } timers = []; },
		installNow() { if (state.phase === 'ready') autoUpdater.quitAndInstall(false, true); },
	};
}

module.exports = { createUpdater, CHECK_EVERY_MS, FIRST_CHECK_MS };
