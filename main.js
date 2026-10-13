// The tray app. One transparent, click-through window over the game loads the channel's /screen
// page, the same page OBS draws, so an alert bought by a viewer shows on the stream (OBS) and on the
// streamer's own screen (here). It signs in by code (flow.js), holds a token of its own in the OS's
// secret store, and sends it as an Authorization header: no secret is ever in a URL or a file in
// the clear. No effect logic lives here.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, Menu, Notification, Tray, nativeImage, safeStorage, screen, session, shell } = require('electron');
const { pairDevice, PairingError } = require('./flow.js');

const BASE = (process.env.TCH_BASE || 'https://twitchclanhub.com').replace(/\/$/, '');
// The effect kinds fx.html can draw (packages/shared/src/effects.ts), with the names the streamer sees.
const KINDS = [['banner', 'Банери'], ['rain', 'Дощ з емодзі'], ['sticker', 'Стікери та страшилки']];
const PARTITION = 'persist:overlay';

const defaults = { muted: false, skip: [], display: null };
let config = { ...defaults };
let token = null;
let tray = null;
let overlay = null;
let pairing = null; // { window, cancelled }
let status = 'unpaired';
let checkTimer = null;

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

function notify(body) { try { new Notification({ title: 'twitchclanhub', body }).show(); } catch { /* no notification support */ } }

function targetDisplay() {
	const all = screen.getAllDisplays();
	return all.find((d) => d.id === config.display) || screen.getPrimaryDisplay();
}

function closeOverlay() { if (overlay && !overlay.isDestroyed()) overlay.destroy(); overlay = null; }
function stopChecks() { if (checkTimer) clearInterval(checkTimer); checkTimer = null; }

/** The token is wrong or ended in the dashboard: forget it, say so, and wait to be paired again. */
function signedOut(reason) {
	stopChecks(); closeOverlay(); saveToken(null); status = 'unpaired'; refresh();
	notify(reason);
}

function overlayUrl() {
	const query = new URLSearchParams();
	if (config.skip.length) query.set('skip', config.skip.join(','));
	return `${BASE}/screen${query.size ? `?${query}` : ''}`;
}

function openOverlay() {
	closeOverlay(); stopChecks();
	if (!token) { status = 'unpaired'; return; }
	// The one place the token leaves this process: a header on requests to our own origin.
	const wire = session.fromPartition(PARTITION);
	const origin = new URL(BASE);
	const patterns = [`${origin.protocol}//${origin.host}/*`, `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${origin.host}/*`];
	wire.webRequest.onBeforeSendHeaders({ urls: patterns }, (details, done) => { done({ requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${token}` } }); });

	const { x, y, width, height } = targetDisplay().bounds;
	overlay = new BrowserWindow({
		x, y, width, height, transparent: true, frame: false, resizable: false, movable: false, focusable: false,
		skipTaskbar: true, hasShadow: false, show: false, backgroundColor: '#00000000',
		webPreferences: { session: wire, autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false, contextIsolation: true, sandbox: true },
	});
	overlay.setAlwaysOnTop(true, 'screen-saver');
	overlay.setIgnoreMouseEvents(true);
	overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	overlay.webContents.setAudioMuted(config.muted);
	// The page shows "fx: reconnecting" while its socket is down; that text must never sit over a game.
	overlay.webContents.on('dom-ready', () => { overlay.webContents.insertCSS('#status{display:none !important}').catch(() => undefined); });
	overlay.webContents.on('did-navigate', (_event, _url, code) => {
		if (code === 404) { signedOut('Програму відключено від каналу. Підключіть її знову в треї.'); return; }
		status = 'connected'; refresh();
	});
	overlay.webContents.on('did-fail-load', (_event, _code, _text, _url, isMainFrame) => {
		if (!isMainFrame) return;
		status = 'offline'; refresh();
		setTimeout(() => { if (overlay && !overlay.isDestroyed()) overlay.loadURL(overlayUrl()).catch(() => undefined); }, 10_000);
	});
	// Never navigate away from our own page, never open a window.
	overlay.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	overlay.webContents.on('will-navigate', (event) => event.preventDefault());
	overlay.once('ready-to-show', () => overlay.showInactive());
	status = 'connecting'; refresh();
	overlay.loadURL(overlayUrl()).catch(() => undefined);
	// A device ended in the dashboard: the page's socket is refused and keeps retrying quietly, so ask once a minute.
	checkTimer = setInterval(async () => {
		try { const response = await fetch(`${BASE}/screen`, { headers: { Authorization: `Bearer ${token}` } }); if (response.status === 404) signedOut('Програму відключено від каналу. Підключіть її знову в треї.'); } catch { /* offline: the page retries */ }
	}, 60_000);
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
		saveToken(result);
		notify('Підключено. Ефекти з’являться поверх гри.');
		openOverlay();
	} catch (error) {
		if (!(error instanceof PairingError && error.reason === 'cancelled')) notify(PAIR_MESSAGES[error?.reason] ?? 'Не вдалося підключитися.');
	} finally {
		if (current.window && !current.window.isDestroyed()) current.window.destroy();
		if (pairing === current) pairing = null;
		refresh();
	}
}

const STATUS_LABEL = { unpaired: 'Не підключено до каналу', connecting: 'Підключення…', connected: 'Підключено', offline: 'Немає зв’язку, пробую ще' };

function menu() {
	const displays = screen.getAllDisplays();
	const current = targetDisplay().id;
	const paired = token !== null;
	return Menu.buildFromTemplate([
		{ label: pairing ? 'Чекаю на підтвердження в панелі…' : STATUS_LABEL[status], enabled: false },
		{ type: 'separator' },
		paired
			? { label: 'Відключити від каналу', click: () => { stopChecks(); closeOverlay(); saveToken(null); status = 'unpaired'; refresh(); } }
			: { label: pairing ? 'Скасувати підключення' : 'Підключити до каналу', click: () => { if (pairing) { pairing.cancelled = true; } else void startPairing(); } },
		{ label: 'Вимкнути звук', type: 'checkbox', checked: config.muted, click: (item) => { config.muted = item.checked; saveConfig(); overlay?.webContents.setAudioMuted(config.muted); } },
		{ label: 'Що показувати на моєму екрані', submenu: KINDS.map(([kind, label]) => ({
			label, type: 'checkbox', checked: !config.skip.includes(kind),
			click: (item) => { config.skip = item.checked ? config.skip.filter((k) => k !== kind) : [...new Set([...config.skip, kind])]; saveConfig(); openOverlay(); },
		})) },
		{ label: 'Монітор', submenu: displays.map((d, i) => ({ label: `Екран ${i + 1} (${d.bounds.width}×${d.bounds.height})`, type: 'radio', checked: d.id === current, click: () => { config.display = d.id; saveConfig(); openOverlay(); } })) },
		{ label: 'Запускати з Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
		{ type: 'separator' },
		{ label: 'Відкрити панель', click: () => shell.openExternal(`${BASE}/dashboard`) },
		{ label: 'Вийти', click: () => app.quit() },
	]);
}

function refresh() { if (tray) { tray.setContextMenu(menu()); tray.setToolTip(`twitchclanhub · ${pairing ? 'підключення' : STATUS_LABEL[status]}`); } }

if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on('second-instance', () => { /* the tray is the app: a second launch changes nothing */ });
	app.on('window-all-closed', () => { /* a tray app: closing a window must not quit it */ });
	app.whenReady().then(() => {
		loadConfig(); token = loadToken();
		tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png')));
		screen.on('display-added', refresh); screen.on('display-removed', () => { openOverlay(); refresh(); });
		if (token) openOverlay(); else void startPairing();
		refresh();
	});
}
