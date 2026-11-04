// Auto-update for the Windows build, from the latest GitHub Release of this public repo
// (electron-updater reads latest.yml next to the installer; no token). It downloads on its own but
// installs only when the streamer picks «Перезапустити й оновити», and only after verify() found the
// release key's signature on that very file (signature.js): nothing GitHub serves runs unchecked. A
// small state machine so the tray can show it and it can be tested with a fake updater. macOS is not
// wired: its updates need a signed app, so it stays manual for now.
'use strict';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 20 * 1000;

/**
 * `autoUpdater`: electron-updater's (or a fake with .on/.checkForUpdates/.quitAndInstall).
 * `verify(info)` resolves null when the downloaded update may be installed, otherwise why not; without it nothing is.
 * `onChange(state)` fires on every transition: { phase: 'idle'|'checking'|'downloading'|'verifying'|'ready'|'refused'|'error'|'unsupported', version?, percent?, message? }.
 */
function createUpdater({ autoUpdater, supported, verify = async () => 'nothing checks the signature', log = () => {}, onChange = () => {}, setTimer = setInterval, setLater = setTimeout }) {
	let state = { phase: supported ? 'idle' : 'unsupported' };
	let timers = [];
	const set = (next) => { state = next; onChange(state); };

	if (supported) {
		autoUpdater.autoDownload = true;
		autoUpdater.autoInstallOnAppQuit = false;
		autoUpdater.allowDowngrade = false;
		autoUpdater.on('checking-for-update', () => { log('update: checking'); set({ phase: 'checking' }); });
		autoUpdater.on('update-not-available', () => { log('update: none'); set({ phase: 'idle' }); });
		autoUpdater.on('update-available', (info) => { log(`update: ${info?.version} available, downloading`); set({ phase: 'downloading', version: info?.version, percent: 0 }); });
		autoUpdater.on('download-progress', (progress) => set({ phase: 'downloading', version: state.version, percent: Math.round(progress?.percent ?? 0) }));
		autoUpdater.on('update-downloaded', (info) => void settle(info));
		autoUpdater.on('error', (error) => { log(`update error: ${error?.message ?? error}`); set({ phase: 'error', message: String(error?.message ?? error).slice(0, 200) }); });
	}

	/** Ready only when verify() passes. A refused one is checked again on the next check (electron-updater keeps the download). */
	async function settle(info) {
		const version = info?.version;
		log(`update: ${version} downloaded, checking the signature`);
		set({ phase: 'verifying', version });
		let reason;
		try { reason = await verify(info); } catch (error) { reason = String(error?.message ?? error); }
		if (state.phase !== 'verifying' || state.version !== version) return; // a newer download took over
		if (reason) { log(`update: ${version} refused: ${reason}`); set({ phase: 'refused', version, message: String(reason).slice(0, 200) }); }
		else { log(`update: ${version} signed by the release key, ready`); set({ phase: 'ready', version }); }
	}

	async function check() {
		if (!supported || ['checking', 'downloading', 'verifying', 'ready'].includes(state.phase)) return state;
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
