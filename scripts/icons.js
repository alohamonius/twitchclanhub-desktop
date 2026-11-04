// Renders every icon the app ships from assets/icon.svg, the site's `tch` tile (twitchclanhub.com's
// apps/web/public/icon-tch.svg, made there by scripts/logo.mjs). `npm run icons` after it changes;
// the PNGs and the .ico are committed. Electron draws them, so nothing beyond the repo is needed.
//   trayTemplate.png (+ @2x)  macOS menu bar: the bare letters in black, which macOS tints for a
//                             light or dark bar and the click highlight (a name ending in Template)
//   tray.ico                  Windows tray: the tile at every size the taskbar asks for, 100% to 400%
//   tray.png                  Linux tray
//   icon.png / icon-mac.png   the app: the tile full bleed (Windows), and inside macOS's icon grid
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ASSETS = path.join(__dirname, '..', 'assets');
const source = fs.readFileSync(path.join(ASSETS, 'icon.svg'), 'utf8').replace(/<!--[\s\S]*?-->\s*/, '');
// The letters, in the tile's own coordinates: ink from 40,60 to 780,484 (the c overshoots the baseline by 4).
// Drawn as six paths, they leave hairline seams where two meet (the h's arch on its stem, the t's bar),
// plain at tray size. So the t and the h become one path, their union solid; the c stays apart,
// because it winds the other way and would cut a hole where the t's bar reaches into it.
const pieces = [.../d="([^"]+)"/g[Symbol.matchAll](/<g id="g">([\s\S]*?)<\/g>/.exec(source)[1])].map((match) => match[1]);
const bowl = pieces.find((d) => /A [\d.]+ [\d.]+ 0 1 0/.test(d)); // the c: its outer arc is the large one
const glyph = `<path d="${pieces.filter((d) => d !== bowl).join(' ')}"/><path d="${bowl}"/>`;
const tile = source.replace(/(<g id="g">)[\s\S]*?(<\/g>)/, `$1${glyph}$2`);
const INK = { x: 40, y: 60, width: 740, height: 424 };

/** The tile at `size`, drawn `inset` px in from each edge, with macOS's soft shadow when asked. */
function tileSvg(size, inset = 0, shadow = false) {
	const inner = tile.replace(/width="600" height="600"/, `width="${size - 2 * inset}" height="${size - 2 * inset}"`);
	const style = `position:absolute;left:${inset}px;top:${inset}px${shadow ? ';filter:drop-shadow(0 10px 14px rgba(0,0,0,.3))' : ''}`;
	return inner.replace('<svg ', `<svg style="${style}" `);
}

/** The letters in black, `ink` px tall, centred on a `width` x `height` canvas. */
function glyphSvg(width, height, ink) {
	const scale = ink / INK.height;
	const x = (width - INK.width * scale) / 2;
	const y = (height - ink) / 2;
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
		+ `<g fill="#000" transform="translate(${x} ${y}) scale(${scale}) translate(${-INK.x} ${-INK.y})">${glyph}</g></svg>`;
}

/**
 * A Windows .ico: 32-bit BMP entries (BGRA, straight alpha, bottom-up, then the 1-bit mask), which
 * every Windows API reads; PNG entries are only safe at 256. `bitmaps`: { size, bgra } from nativeImage.
 */
function ico(bitmaps) {
	const entries = bitmaps.map(({ size, bgra }) => {
		const rows = [];
		for (let y = size - 1; y >= 0; y--) rows.push(bgra.subarray(y * size * 4, (y + 1) * size * 4));
		const header = Buffer.alloc(40);
		header.writeUInt32LE(40, 0); header.writeInt32LE(size, 4); header.writeInt32LE(size * 2, 8);
		header.writeUInt16LE(1, 12); header.writeUInt16LE(32, 14);
		const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // all zero: the alpha channel decides
		return { size, data: Buffer.concat([header, ...rows, mask]) };
	});
	const directory = Buffer.alloc(6 + 16 * entries.length);
	directory.writeUInt16LE(1, 2); directory.writeUInt16LE(entries.length, 4);
	let offset = directory.length;
	entries.forEach(({ size, data }, i) => {
		const at = 6 + 16 * i;
		directory.writeUInt8(size, at); directory.writeUInt8(size, at + 1);
		directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6);
		directory.writeUInt32LE(data.length, at + 8); directory.writeUInt32LE(offset, at + 12);
		offset += data.length;
	});
	return Buffer.concat([directory, ...entries.map((entry) => entry.data)]);
}

/** nativeImage's pixels are BGRA with premultiplied alpha; an .ico wants it straight. */
function straightAlpha(bgra) {
	const out = Buffer.from(bgra);
	for (let i = 0; i < out.length; i += 4) {
		const a = out[i + 3];
		if (a > 0 && a < 255) for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.round((out[i + c] * 255) / a));
	}
	return out;
}

app.whenReady().then(async () => {
	const window = new BrowserWindow({ show: false, width: 1024, height: 1024, frame: false, transparent: true, webPreferences: { offscreen: true } });
	const page = path.join(os.tmpdir(), 'twitchclanhub-icon.html');
	const load = async (html) => {
		fs.writeFileSync(page, html);
		await window.loadFile(page);
		await new Promise((resolve) => setTimeout(resolve, 100));
	};
	// A capture comes out at the screen's scale (2x on a Retina Mac, whatever the switches say), so the
	// page is zoomed by its inverse: each image is drawn at its own pixel size, never resampled.
	await load('<!doctype html><html><body style="margin:0"></body></html>');
	const scale = (await window.webContents.capturePage({ x: 0, y: 0, width: 10, height: 10 })).getSize().width / 10;
	const render = async (svg, width, height = width) => {
		await load(`<!doctype html><html style="zoom:${1 / scale}"><body style="margin:0;background:transparent">${svg}</body></html>`);
		const image = await window.webContents.capturePage({ x: 0, y: 0, width: width / scale, height: height / scale });
		const got = image.getSize();
		if (got.width !== width || got.height !== height) throw new Error(`rendered ${got.width}x${got.height}, wanted ${width}x${height}`);
		return image;
	};
	const write = (name, data) => { fs.writeFileSync(path.join(ASSETS, name), data); console.log(`wrote assets/${name}`); };

	// 26x18 pt with the letters 14 pt tall: as tall as the menu bar's other icons, and their stroke
	// (84 of 424) stays 2.8 pt, so the c and the h's arch still read at 1x.
	write('trayTemplate.png', (await render(glyphSvg(26, 18, 14), 26, 18)).toPNG());
	write('trayTemplate@2x.png', (await render(glyphSvg(52, 36, 28), 52, 36)).toPNG());
	write('tray.png', (await render(tileSvg(32), 32)).toPNG());
	const sizes = [16, 20, 24, 32, 40, 48, 64];
	const bitmaps = [];
	for (const size of sizes) bitmaps.push({ size, bgra: straightAlpha((await render(tileSvg(size), size)).toBitmap()) });
	write('tray.ico', ico(bitmaps));
	write('icon.png', (await render(tileSvg(1024), 1024)).toPNG());
	// macOS's grid: an 824 px tile in the 1024 canvas, so it sits level with the other apps.
	write('icon-mac.png', (await render(tileSvg(1024, 100, true), 1024)).toPNG());
	fs.rmSync(page, { force: true });
	app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
