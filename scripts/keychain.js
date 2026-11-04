// The release key lives in the login Keychain of the founder's Mac as a generic password that no app
// may read without asking (-T ""): every signing shows macOS's prompt for the login password. Not a
// file, so a script that `npm install` runs cannot copy it quietly. TCH_RELEASE_KEY_SERVICE points at
// another item (a throwaway key when trying the scripts out).
'use strict';
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const SERVICE = process.env.TCH_RELEASE_KEY_SERVICE || 'twitchclanhub-desktop release key';
const ACCOUNT = 'release';
const NOT_FOUND = 44; // security(1)'s exit status for a missing item

/** The private key (an Ed25519 KeyObject), or null when this Keychain has none. macOS asks first. */
function readKey(service = SERVICE) {
	let base64;
	try {
		base64 = execFileSync('security', ['find-generic-password', '-s', service, '-a', ACCOUNT, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	} catch (error) {
		if (error.status === NOT_FOUND) return null;
		const said = String(error.stderr ?? '').trim() || error.message;
		throw new Error(/interaction is not allowed/i.test(said) ? 'macOS could not show its password prompt here; run it in Terminal' : `Keychain: ${said}`);
	}
	return crypto.createPrivateKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'pkcs8' });
}

/** Makes a new key and stores it. `askEveryTime: false` only for a throwaway key in a test. */
function createKey(service = SERVICE, { askEveryTime = true } = {}) {
	const { privateKey } = crypto.generateKeyPairSync('ed25519');
	const base64 = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
	execFileSync('security', ['add-generic-password', '-s', service, '-a', ACCOUNT, '-l', service,
		'-j', 'Signs twitchclanhub desktop releases (scripts/sign-release.js). Keep a copy in the password manager.',
		...(askEveryTime ? ['-T', ''] : []), '-w', base64], { stdio: 'ignore' });
	return privateKey;
}

function deleteKey(service) { execFileSync('security', ['delete-generic-password', '-s', service, '-a', ACCOUNT], { stdio: 'ignore' }); }

module.exports = { ACCOUNT, SERVICE, createKey, deleteKey, readKey };
