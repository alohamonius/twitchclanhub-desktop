// The tray app. One transparent, click-through window over the game loads the channel's /screen
// page, the same page OBS draws, so an alert bought by a viewer shows on the stream (OBS) and on the
// streamer's own screen (here). overlay.js keeps it one window for the whole sign-in, moved and
// reloaded in place, never recreated over a running game, and topmost again every few seconds.
// It signs in by code (flow.js), holds a token of its own in the OS's
// secret store, and sends it as an Authorization header: no secret is ever in a URL or a file in
// the clear. No effect logic lives here.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, Menu, Notification, Tray, clipboard, nativeImage, safeStorage, screen, session, shell } = require('electron');
const { pairDevice, PairingError } = require('./flow.js');
const { createLog } = require('./log.js');
const { createOverlay } = require('./overlay.js');
const { createUpdater } = require('./updater.js');

const BASE = (process.env.TCH_BASE || 'https://twitchclanhub.com').replace(/\/$/, '');
// The effect kinds fx.html can draw (packages/shared/src/effects.ts), with the names the streamer sees.
const KINDS = [['banner', 'Банери'], ['rain', 'Дощ з емодзі'], ['sticker', 'Стікери та страшилки']];
const PARTITION = 'persist:overlay';

const defaults = { muted: false, skip: [], display: null };
let config = { ...defaults };
let token = null;
let tray = null;
let pairing = null; // { window, cancelled }
let status = 'unpaired';
let checkTimer = null;
let log = { write() {}, tail: () => '', dir: '' }; // a real log from whenReady on

const userFile = (name) => path.join(app.getPath('userData'), name);
function loadConfig() { try { config = { ...defaults, ...JSON.parse(fs.readFileSync(userFile('config.json'), 'utf8')) }; } catch { config = { ...defaults }; } }
function saveConfig() { try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(userFile('config.json'), JSON.stringify(config)); } catch { /* the next change saves again */ } }

// The token lives encrypted by the OS (DPAPI on Windows, Keychain on macOS). Without that, it is
// kept in memory only: the app asks to pair again after a restart rather than write a secret in the clear.
function loadToken() {
	try {
		if (!safeStorage.isEncryptionAvailable()) return null;
		return safeStorage.decryptString(fs.readFileSync(userFile('device.bin')));
	} catch { return null; }
}
function saveToken(value) {
	token = value;
	try {
		if (value === null) fs.rmSync(userFile('device.bin'), { force: true });
		else if (safeStorage.isEncryptionAvailable()) { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(userFile('device.bin'), safeStorage.encryptString(value)); }
	} catch { /* kept in memory for this run */ }
}

function note(message) { log.write(message); }

// The overlay window, one per sign-in (overlay.js); makeOverlayWindow below builds it when asked.
const overlay = createOverlay({ createWindow: makeOverlayWindow, log: note });

// Windows only: macOS updates need a signed app, so there it stays a manual download for now.
const RELEASES = 'https://github.com/alohamonius/twitchclanhub-desktop/releases/latest';
const updater = createUpdater({
	autoUpdater: process.platform === 'win32' && app.isPackaged ? require('electron-updater').autoUpdater : null,
	supported: process.platform === 'win32' && app.isPackaged,
	log: (message) => note(message),
	onChange: (state) => {
		if (state.phase === 'ready') notify(`Нова версія ${state.version} готова. Вона встановиться при наступному запуску, або оберіть у треї «Перезапустити й оновити».`);
		refresh();
	},
});
function notify(body) { try { new Notification({ title: 'twitchclanhub', body }).show(); } catch { /* no notification support */ } }

function targetDisplay() {
	const all = screen.getAllDisplays();
	return all.find((d) => d.id === config.display) || screen.getPrimaryDisplay();
}

function stopChecks() { if (checkTimer) clearInterval(checkTimer); checkTimer = null; }
/** A device ended in the dashboard: the page's socket is refused and keeps retrying quietly, so ask once a minute. */
function startChecks() {
	if (checkTimer) return;
	checkTimer = setInterval(async () => {
		try { const response = await fetch(`${BASE}/screen`, { headers: { Authorization: `Bearer ${token}` } }); if (response.status === 404) signedOut('Програму відключено від каналу. Підключіть її знову в треї.'); } catch { /* offline: the page retries */ }
	}, 60_000);
}

/** The token is wrong or ended in the dashboard: forget it, say so, and wait to be paired again. */
function signedOut(reason) {
	note(`signed out: ${reason}`);
	stopChecks(); overlay.close(); saveToken(null); status = 'unpaired'; refresh();
	notify(reason);
}

function overlayUrl() {
	const query = new URLSearchParams();
	if (config.skip.length) query.set('skip', config.skip.join(','));
	return `${BASE}/screen${query.size ? `?${query}` : ''}`;
}

/** The one place the token leaves this process: a header on requests to our own origin. Once, at start; it reads the token of the moment. */
function wireSession() {
	const wire = session.fromPartition(PARTITION);
	const origin = new URL(BASE);
	const patterns = [`${origin.protocol}//${origin.host}/*`, `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${origin.host}/*`];
	wire.webRequest.onBeforeSendHeaders({ urls: patterns }, (details, done) => { done({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` } }); });
}

/** Builds the overlay window at these bounds. overlay.js decides when: once per sign-in, then it is moved and reloaded in place. */
function makeOverlayWindow({ x, y, width, height }) {
	const window = new BrowserWindow({
		x, y, width, height, transparent: true, frame: false, resizable: false, movable: false, focusable: false,
		skipTaskbar: true, hasShadow: false, show: false, backgroundColor: '#00000000',
		webPreferences: { session: session.fromPartition(PARTITION), autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, contextIsolation: true, sandbox: true },
	});
	window.setAlwaysOnTop(true, 'screen-saver');
	window.setIgnoreMouseEvents(true);
	window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	// The page shows "fx: reconnecting" while its socket is down; that text must never sit over a game.
	window.webContents.on('dom-ready', () => { window.webContents.insertCSS('#status{display:none !important}').catch(() => undefined); });
	window.webContents.on('did-navigate', (_event, _url, code) => {
		note(`page loaded: HTTP ${code}`);
		if (code === 404) { signedOut('Програму відключено від каналу. Підключіть її знову в треї.'); return; }
		status = 'connected'; refresh();
	});
	window.webContents.on('did-fail-load', (_event, code, text, _url, isMainFrame) => {
		if (!isMainFrame || code === -3) return; // -3: a load cut short by the next one, not a failure
		note(`page failed to load: ${text} (${code})`);
		status = 'offline'; refresh();
		setTimeout(() => overlay.reload(), 10_000);
	});
	// Never navigate away from our own page, never open a window.
	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-navigate', (event) => event.preventDefault());
	window.once('ready-to-show', () => { window.showInactive(); overlay.reassert(); });
	return window;
}

/** The overlay as the settings want it now: created on the first call, afterwards moved or reloaded in place. */
function showOverlay() {
	if (!token) { status = 'unpaired'; refresh(); return; }
	const { x, y, width, height } = targetDisplay().bounds;
	const did = overlay.show({ url: overlayUrl(), bounds: { x, y, width, height }, muted: config.muted });
	if (did.includes('created')) note(`opening the overlay, ${width}x${height} at ${x},${y}`);
	if (did.includes('moved')) note(`overlay moved, ${width}x${height} at ${x},${y}`);
	if (did.includes('loaded')) { status = 'connecting'; refresh(); }
	startChecks();
}

const PAIR_MESSAGES = { expired: 'Код застарів. Спробуйте підключитися ще раз.', unreachable: 'Немає зв’язку з twitchclanhub.', bad_response: 'Сервер відповів несподівано. Спробуйте пізніше.' };

function pairingPage(code, verifyUrl) {
	const safe = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
	return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<body style="margin:0;font:15px system-ui,sans-serif;background:#0e0e10;color:#efeff1;display:grid;place-items:center;height:100vh;text-align:center">
<main style="padding:24px"><p style="color:#adadb8;margin:0 0 6px">Ваш код підключення</p>
<p style="font:700 40px ui-monospace,monospace;letter-spacing:.12em;margin:0 0 14px;color:#ec5c32">${safe(code)}</p>
<p style="color:#adadb8;max-width:360px;margin:0 auto 18px;line-height:1.5">Введіть його в панелі twitchclanhub у картці «Програма». Код діє 10 хвилин.</p>
<a href="${safe(verifyUrl)}" style="display:inline-block;padding:11px 20px;border-radius:8px;background:#ec5c32;color:#fff;font-weight:700;text-decoration:none">Відкрити панель</a></main>`)}`;
}

async function startPairing() {
	if (pairing) { pairing.window?.focus(); return; }
	const current = { window: null, cancelled: false };
	pairing = current;
	refresh();
	try {
		const result = await pairDevice({
			base: BASE, name: os.hostname(), isCancelled: () => current.cancelled,
			onCode: ({ userCode, verifyUrl }) => {
				const window = new BrowserWindow({ width: 440, height: 320, resizable: false, minimizable: false, maximizable: false, autoHideMenuBar: true, title: 'Підключення до каналу', backgroundColor: '#0e0e10', webPreferences: { sandbox: true, contextIsolation: true } });
				current.window = window;
				window.on('closed', () => { current.cancelled = true; current.window = null; });
				// Only our own panel opens, in the browser; the window itself never leaves its page.
				window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
				window.webContents.on('will-navigate', (event, url) => { event.preventDefault(); if (url.startsWith(`${BASE}/`)) shell.openExternal(url); });
				window.loadURL(pairingPage(userCode, verifyUrl));
			},
		});
		note('paired: a device token was received');
		saveToken(result);
		notify('Підключено. Ефекти з’являться поверх гри.');
		showOverlay();
	} catch (error) {
		note(`pairing ended: ${error?.reason ?? error?.message ?? 'unknown'}`);
		if (!(error instanceof PairingError && error.reason === 'cancelled')) notify(PAIR_MESSAGES[error?.reason] ?? 'Не вдалося підключитися.');
	} finally {
		if (current.window && !current.window.isDestroyed()) current.window.destroy();
		if (pairing === current) pairing = null;
		refresh();
	}
}

/** The browser cache and web storage of the overlay window; the sign-in (the token) is not touched. */
async function clearCache() {
	try {
		const wire = session.fromPartition(PARTITION);
		await wire.clearCache();
		await wire.clearStorageData({ storages: ['cachestorage', 'serviceworkers', 'localstorage', 'indexdb', 'filesystem', 'shadercache'] });
		note('cache cleared');
		overlay.reload();
		notify('Кеш очищено. Підключення до каналу збережено.');
	} catch (error) {
		note(`cache clear failed: ${error?.message ?? error}`);
		notify('Не вдалося очистити кеш.');
	}
}

/** What support needs first: version, system, state, then the newest log lines. No token, no key. */
function supportText() {
	const head = [`twitchclanhub desktop ${app.getVersion()}`, `${process.platform} ${os.release()} ${process.arch}`, `electron ${process.versions.electron}`, `server ${BASE}`, `state ${pairing ? 'pairing' : status}, ${token ? 'signed in' : 'not signed in'}, updates ${updater.state.phase}`, `muted ${config.muted}, hidden effects: ${config.skip.join(',') || 'none'}`];
	return `${head.join('\n')}\n\n${log.tail(300)}`;
}
function copyLogs() { clipboard.writeText(supportText()); note('logs copied to the clipboard'); notify('Логи скопійовано. Вставте їх у повідомлення в підтримку.'); }
function openLogFolder() { shell.openPath(log.dir).catch(() => undefined); }

const STATUS_LABEL = { unpaired: 'Не підключено до каналу', connecting: 'Підключення…', connected: 'Підключено', offline: 'Немає зв’язку, пробую ще' };

function menu() {
	const displays = screen.getAllDisplays();
	const current = targetDisplay().id;
	const paired = token !== null;
	return Menu.buildFromTemplate([
		{ label: pairing ? 'Чекаю на підтвердження в панелі…' : STATUS_LABEL[status], enabled: false },
		{ type: 'separator' },
		paired
			? { label: 'Відключити від каналу', click: () => { stopChecks(); overlay.close(); saveToken(null); status = 'unpaired'; refresh(); } }
			: { label: pairing ? 'Скасувати підключення' : 'Підключити до каналу', click: () => { if (pairing) { pairing.cancelled = true; } else void startPairing(); } },
		{ label: 'Вимкнути звук', type: 'checkbox', checked: config.muted, click: (item) => { config.muted = item.checked; saveConfig(); overlay.setMuted(config.muted); } },
		{ label: 'Що показувати на моєму екрані', submenu: KINDS.map(([kind, label]) => ({
			label, type: 'checkbox', checked: !config.skip.includes(kind),
			click: (item) => { config.skip = item.checked ? config.skip.filter((k) => k !== kind) : [...new Set([...config.skip, kind])]; saveConfig(); showOverlay(); },
		})) },
		{ label: 'Монітор', submenu: displays.map((d, i) => ({ label: `Екран ${i + 1} (${d.bounds.width}×${d.bounds.height})`, type: 'radio', checked: d.id === current, click: () => { config.display = d.id; saveConfig(); showOverlay(); } })) },
		{ label: process.platform === 'darwin' ? 'Запускати при вході в систему' : 'Запускати з Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
		{ type: 'separator' },
		updateItem(),
		{ label: 'Підтримка', submenu: [
			{ label: 'Очистити кеш', click: () => void clearCache() },
			{ label: 'Скопіювати логи', click: copyLogs },
			{ label: 'Відкрити папку з логами', click: openLogFolder },
		] },
		{ label: 'Відкрити панель', click: () => shell.openExternal(`${BASE}/dashboard`) },
		{ label: 'Вийти', click: () => app.quit() },
	]);
}

/** The tray's update line: the state of the updater, or a link to the releases where it cannot update itself. */
function updateItem() {
	const { phase, version, percent } = updater.state;
	if (phase === 'unsupported') return { label: `Версія ${app.getVersion()} · завантажити нову`, click: () => shell.openExternal(RELEASES) };
	if (phase === 'checking') return { label: `Версія ${app.getVersion()} · перевіряю оновлення…`, enabled: false };
	if (phase === 'downloading') return { label: `Версія ${app.getVersion()} · завантажую ${version ?? ''} ${percent ?? 0}%`, enabled: false };
	if (phase === 'ready') return { label: `Перезапустити й оновити до ${version}`, click: () => updater.installNow() };
	if (phase === 'error') return { label: `Версія ${app.getVersion()} · оновлення не вдалось, ще раз`, click: () => void updater.check() };
	return { label: `Версія ${app.getVersion()} · перевірити оновлення`, click: () => void updater.check() };
}

function refresh() { if (tray) { tray.setContextMenu(menu()); tray.setToolTip(`twitchclanhub · ${pairing ? 'підключення' : STATUS_LABEL[status]}`); } }

if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on('second-instance', () => { /* the tray is the app: a second launch changes nothing */ });
	app.on('window-all-closed', () => { /* a tray app: closing a window must not quit it */ });
	app.whenReady().then(() => {
		app.dock?.hide(); // macOS: a tray app, no Dock icon, and its overlay may sit over full-screen apps
		log = createLog({ dir: path.join(app.getPath('userData'), 'logs') });
		process.on('uncaughtException', (error) => note(`uncaught: ${error?.stack ?? error}`));
		loadConfig(); token = loadToken();
		note(`started ${app.getVersion()} on ${process.platform} ${os.release()} ${process.arch}, electron ${process.versions.electron}, server ${BASE}, ${token ? 'signed in' : 'not signed in'}`);
		tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
		wireSession();
		// A monitor comes or goes, or changes resolution or scale (a game going fullscreen often does
		// both): the overlay follows the chosen display's new bounds and claims the top again. Nothing is recreated.
		screen.on('display-added', () => { showOverlay(); refresh(); });
		screen.on('display-removed', () => { showOverlay(); refresh(); });
		screen.on('display-metrics-changed', (_event, display, changed) => { note(`display ${display.id} changed: ${changed.join(', ')}`); showOverlay(); refresh(); });
		if (token) showOverlay(); else void startPairing();
		refresh();
		updater.start();
	});
}
