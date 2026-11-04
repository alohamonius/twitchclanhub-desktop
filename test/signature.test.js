'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { RELEASE_KEYS, checkSignature, rawPublicKey, sha512File, signRelease, verifyDownload } = require('../signature.js');

const ours = crypto.generateKeyPairSync('ed25519').privateKey;
const theirs = crypto.generateKeyPairSync('ed25519').privateKey;
const keys = [rawPublicKey(ours)];
const file = 'twitchclanhub-setup.exe';
const sha = (text) => crypto.createHash('sha512').update(text).digest('base64');
const signed = (fields, privateKey = ours) => JSON.stringify(signRelease({ version: '0.6.3', file, sha512: sha('installer'), privateKey, ...fields }));

function downloaded(content) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tch-sig-'));
	const at = path.join(dir, 'update.exe');
	fs.writeFileSync(at, content);
	return { version: '0.6.3', files: [{ url: file, sha512: 'whatever latest.yml says' }], downloadedFile: at };
}
function serve(answers) {
	const asked = [];
	return { asked, fetchImpl: async (url) => { asked.push(url); const next = answers[url]; if (next instanceof Error) throw next; return next ?? { ok: false, status: 404, text: async () => 'Not Found' }; } };
}
const repo = 'https://github.com/alohamonius/twitchclanhub-desktop';
const sigUrl = `${repo}/releases/download/v0.6.3/${file}.sig`;
const ok = (text) => ({ ok: true, status: 200, text: async () => text });

test('the shipped release key is one real Ed25519 public key', () => {
	assert.equal(RELEASE_KEYS.length, 1);
	assert.equal(Buffer.from(RELEASE_KEYS[0], 'base64').length, 32);
	assert.equal(crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(RELEASE_KEYS[0], 'base64').toString('base64url') }, format: 'jwk' }).asymmetricKeyType, 'ed25519');
});

test('a signature by our key over this version, file and hash passes; anything else says why not', () => {
	const fields = { version: '0.6.3', file, sha512: sha('installer'), keys };
	assert.equal(checkSignature({ text: signed(), ...fields }), null);
	assert.equal(checkSignature({ text: signed({}, theirs), ...fields }), 'not signed by the release key');
	assert.equal(checkSignature({ text: signed(), ...fields, sha512: sha('malware') }), 'the downloaded file is not the one that was signed');
	assert.match(checkSignature({ text: signed(), ...fields, version: '0.6.4' }), /signature is for 0\.6\.3/, 'a real 0.6.3 signature does not pass for a release that calls itself 0.6.4');
	assert.match(checkSignature({ text: signed(), ...fields, file: 'other.exe' }), /signature is for/);
	assert.equal(checkSignature({ text: 'not json', ...fields }), 'the signature is not JSON');
	const forged = { ...JSON.parse(signed()), sha512: sha('malware') };
	assert.equal(checkSignature({ text: JSON.stringify(forged), ...fields, sha512: sha('malware') }), 'not signed by the release key', 'changing the hash in the .sig breaks the signature');
	assert.equal(checkSignature({ text: signed(), ...fields, keys: [] }), 'not signed by the release key');
});

test('a version or file name with a line break is refused, so fields cannot shift inside the signed message', () => {
	assert.throws(() => signRelease({ version: '0.6.3\nx', file, sha512: 'h', privateKey: ours }));
	assert.match(checkSignature({ text: signed(), version: '0.6.3\nx', file, sha512: sha('installer'), keys }), /names/);
});

test('verifyDownload fetches the .sig beside the installer in the same release and hashes the downloaded file itself', async () => {
	const info = downloaded('installer');
	const { asked, fetchImpl } = serve({ [sigUrl]: ok(signed()) });
	assert.equal(await verifyDownload(info, { repo, fetchImpl, keys }), null);
	assert.deepEqual(asked, [sigUrl]);
	assert.equal(await sha512File(info.downloadedFile), sha('installer'));
});

test('verifyDownload refuses a swapped installer, a missing or unreachable .sig, an oversized one and an update with no installer', async () => {
	assert.equal(await verifyDownload(downloaded('malware'), { repo, keys, ...serve({ [sigUrl]: ok(signed()) }) }), 'the downloaded file is not the one that was signed');
	assert.equal(await verifyDownload(downloaded('installer'), { repo, keys, ...serve({}) }), 'no signature in the release (404)');
	assert.match(await verifyDownload(downloaded('installer'), { repo, keys, ...serve({ [sigUrl]: new Error('offline') }) }), /did not load: offline/);
	assert.equal(await verifyDownload(downloaded('installer'), { repo, keys, ...serve({ [sigUrl]: ok('x'.repeat(5000)) }) }), 'the signature file is too long');
	assert.equal(await verifyDownload({ version: '0.6.3', files: [{ url: 'twitchclanhub-mac.dmg' }], downloadedFile: '/x' }, { repo, keys, ...serve({}) }), 'the update names no installer');
	assert.match(await verifyDownload({ ...downloaded('installer'), version: '../../evil' }, { repo, keys, ...serve({}) }), /names/);
});
