// A small rolling log the streamer can hand to support. Pure Node (no Electron), so it is tested
// on its own. Nothing secret is ever written: the app does not log tokens, and `redact` strips any
// Bearer value or long opaque string that slips into a message anyway.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 256 * 1024;

/** Bearer tokens and any 32+ character run of URL-safe characters (a token, a device code). */
function redact(text) {
	return String(text)
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [hidden]')
		.replace(/[A-Za-z0-9_-]{32,}/g, '[hidden]');
}

function createLog({ dir, now = () => new Date() }) {
	const file = path.join(dir, 'app.log');
	const write = (line) => {
		try {
			fs.mkdirSync(dir, { recursive: true });
			try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* no file yet */ }
			fs.appendFileSync(file, `${now().toISOString()} ${redact(line)}\n`);
		} catch { /* logging must never break the app */ }
	};
	/** The last `lines` lines, older rotated file first, for pasting into a message. */
	const tail = (lines = 300) => {
		const read = (name) => { try { return fs.readFileSync(name, 'utf8'); } catch { return ''; } };
		return (read(`${file}.1`) + read(file)).split('\n').filter(Boolean).slice(-lines).join('\n');
	};
	return { file, dir, write, tail };
}

module.exports = { createLog, redact, MAX_BYTES };
