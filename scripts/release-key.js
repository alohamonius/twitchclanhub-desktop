// Makes the release key once, on the founder's Mac, in the login Keychain, and prints its public half
// for RELEASE_KEYS in signature.js. Run again, it prints the public half of the key already there.
'use strict';
const { RELEASE_KEYS, rawPublicKey } = require('../signature.js');
const { ACCOUNT, SERVICE, createKey, readKey } = require('./keychain.js');

if (process.platform !== 'darwin') {
	console.error('The release key lives in the macOS Keychain: run this on the Mac.');
	process.exit(1);
}
let key = readKey();
const made = key === null;
if (made) key = createKey();
const publicKey = rawPublicKey(key);
console.log(made ? `Made the release key: Keychain item «${SERVICE}», account «${ACCOUNT}».` : `The release key is already in the Keychain («${SERVICE}»).`);
console.log(`Public half: ${publicKey}`);
console.log(RELEASE_KEYS.includes(publicKey) ? 'signature.js already trusts it.' : 'Put it into RELEASE_KEYS in signature.js and release that version.');
if (made) {
	console.log('\nBack it up now: Keychain Access, search «twitchclanhub», double-click the item, «Show password»,');
	console.log('copy it into the password manager. Without the key, installed apps take no more updates by themselves.');
}
