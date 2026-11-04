// An update is installed only when signed by the release key, which the founder keeps in the macOS
// Keychain of one Mac: never on GitHub, never in CI. The release carries <installer>.sig, the version,
// file name and sha512 of the installer signed with Ed25519. The app hashes the file it downloaded
// itself, so a release changed on GitHub (the account, a token, a tag push or a CI step taken over)
// fails here and is never run. scripts/sign-release.js writes the .sig from the same message.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');

/** The public halves of the release keys (raw Ed25519, base64). Two only while a key is replaced. */
const RELEASE_KEYS = ['vUdb7fhyJWUQAW8WCO7uc27yTlZFfYpgJHttYcaYdhQ='];
const SIG_MAX_CHARS = 4096;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const FILE = /^[\w.-]+$/;

function message({ version, file, sha512 }) { return Buffer.from(`twitchclanhub-desktop update\n${version}\n${file}\n${sha512}\n`); }
function publicKeyOf(raw) { return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw, 'base64').toString('base64url') }, format: 'jwk' }); }
/** The raw public half of an Ed25519 KeyObject (private or public), as RELEASE_KEYS holds it. */
function rawPublicKey(key) { return Buffer.from(crypto.createPublicKey(key).export({ format: 'jwk' }).x, 'base64url').toString('base64'); }

/** The base64 sha512 of a file, the form latest.yml and the .sig carry. */
function sha512File(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha512');
		fs.createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('base64')));
	});
}

/** The .sig file's JSON for one installer. `privateKey` is an Ed25519 KeyObject. */
function signRelease({ version, file, sha512, privateKey }) {
	if (!VERSION.test(version) || !FILE.test(file)) throw new Error(`cannot sign ${version} ${file}`);
	return { version, file, sha512, signature: crypto.sign(null, message({ version, file, sha512 }), privateKey).toString('base64') };
}

/** Null when `text` (a .sig file) signs exactly this version, file name and hash with one of `keys`; otherwise why not. */
function checkSignature({ text, version, file, sha512, keys = RELEASE_KEYS }) {
	let sig;
	try { sig = JSON.parse(text); } catch { return 'the signature is not JSON'; }
	if (!VERSION.test(version) || !FILE.test(file)) return `the update names ${version} ${file}`;
	if (sig?.version !== version || sig?.file !== file) return `the signature is for ${String(sig?.version).slice(0, 20)} ${String(sig?.file).slice(0, 40)}`;
	if (sig.sha512 !== sha512) return 'the downloaded file is not the one that was signed';
	if (typeof sig.signature !== 'string') return 'no signature in the file';
	const body = message(sig);
	const signature = Buffer.from(sig.signature, 'base64');
	const good = keys.some((key) => { try { return crypto.verify(null, body, publicKeyOf(key), signature); } catch { return false; } });
	return good ? null : 'not signed by the release key';
}

/**
 * The check of a downloaded update (electron-updater's update-downloaded event): the installer's name
 * from the release, its .sig fetched from the same release, the downloaded file hashed here.
 * Resolves null when it may be installed, otherwise the reason it may not.
 */
async function verifyDownload(info, { repo, fetchImpl, keys = RELEASE_KEYS, timeoutMs = 30_000 }) {
	const file = info?.files?.map((f) => f?.url).find((url) => typeof url === 'string' && url.endsWith('.exe'));
	const version = info?.version;
	if (!file || typeof version !== 'string' || typeof info.downloadedFile !== 'string') return 'the update names no installer';
	if (!VERSION.test(version) || !FILE.test(file)) return `the update names ${version.slice(0, 20)} ${file.slice(0, 40)}`;
	let text;
	try {
		const response = await fetchImpl(`${repo}/releases/download/v${version}/${file}.sig`, { signal: AbortSignal.timeout(timeoutMs) });
		if (!response.ok) return `no signature in the release (${response.status})`;
		text = await response.text();
	} catch (error) { return `the signature did not load: ${error?.message ?? error}`; }
	if (text.length > SIG_MAX_CHARS) return 'the signature file is too long';
	return checkSignature({ text, version, file, sha512: await sha512File(info.downloadedFile), keys });
}

module.exports = { RELEASE_KEYS, checkSignature, rawPublicKey, sha512File, signRelease, verifyDownload };
