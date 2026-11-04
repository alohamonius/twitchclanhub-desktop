// Signs a release CI built and publishes it: `npm run sign-release -- v0.6.3` on the founder's Mac.
// CI (release.yml) leaves every release a draft, which neither the app's updater nor the website's
// download link sees. This checks the draft is what CI built from a commit on main, signs the
// installer with the release key (macOS asks for the login password), uploads <installer>.sig, then
// publishes the release and fetches the .sig back the way the app will. --dry-run signs into a temp
// folder and stops there; it also takes a release that is already published.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { RELEASE_KEYS, checkSignature, rawPublicKey, sha512File, signRelease } = require('../signature.js');

const REPO = 'alohamonius/twitchclanhub-desktop';
const INSTALLER = 'twitchclanhub-setup.exe';
const BUILDER = 'github-actions[bot]';

/** The version and the installer's sha512 in electron-builder's latest.yml (flat enough for two patterns). */
function parseLatest(text, file) {
	const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return {
		version: text.match(/^version: *['"]?([^'"\s]+)['"]?\s*$/m)?.[1],
		sha512: text.match(new RegExp(`^ *- url: *${escaped}\\s*\\n *sha512: *(\\S+)`, 'm'))?.[1],
	};
}

/** Why this release may not be signed, or null. `release` is GitHub's JSON for it. */
function releaseProblem({ release, tag, onMain, dryRun = false }) {
	if (!release) return `there is no release ${tag} (CI makes it as a draft when the tag is pushed)`;
	if (!release.draft && !dryRun) return `${tag} is already published: it is signed while still a draft, before anyone can download it`;
	if (!onMain) return `${tag} points at a commit that is not on main`;
	const built = release.assets.filter((asset) => !asset.name.endsWith('.sig'));
	for (const name of [INSTALLER, 'latest.yml']) if (!built.some((asset) => asset.name === name)) return `${tag} has no ${name}`;
	const foreign = built.filter((asset) => asset.uploader?.login !== BUILDER);
	if (foreign.length) return `not uploaded by CI: ${foreign.map((asset) => `${asset.name} (${asset.uploader?.login})`).join(', ')}`;
	return null;
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const api = (route) => JSON.parse(gh(['api', route]));
function download(asset, file) {
	const out = fs.openSync(file, 'w');
	try {
		const run = spawnSync('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${REPO}/releases/assets/${asset.id}`], { stdio: ['ignore', out, 'inherit'] });
		if (run.status !== 0) throw new Error(`could not download ${asset.name}`);
	} finally { fs.closeSync(out); }
}
function fail(reason) { console.error(`Not signed: ${reason}.`); process.exit(1); }

async function main(argv) {
	const dryRun = argv.includes('--dry-run');
	const tag = argv.find((arg) => !arg.startsWith('--'));
	if (!/^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(tag ?? '')) fail('name the tag, as in npm run sign-release -- v0.6.3');
	const version = tag.slice(1);

	const release = api(`repos/${REPO}/releases?per_page=30`).find((r) => r.tag_name === tag);
	const status = release ? api(`repos/${REPO}/compare/main...${tag}`).status : null;
	const problem = releaseProblem({ release, tag, onMain: status === 'identical' || status === 'behind', dryRun });
	if (problem) fail(problem);
	const commit = api(`repos/${REPO}/commits/${tag}`).sha;

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tch-sign-'));
	const asset = (name) => release.assets.find((a) => a.name === name);
	download(asset('latest.yml'), path.join(dir, 'latest.yml'));
	download(asset(INSTALLER), path.join(dir, INSTALLER));
	const latest = parseLatest(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'), INSTALLER);
	if (latest.version !== version) fail(`latest.yml says ${latest.version}, the tag says ${version}`);
	const sha512 = await sha512File(path.join(dir, INSTALLER));
	if (sha512 !== latest.sha512) fail(`${INSTALLER} does not match the sha512 in latest.yml`);

	const { readKey } = require('./keychain.js');
	console.log(`${tag}: commit ${commit.slice(0, 12)} on main, ${INSTALLER} built by CI, sha512 ${sha512.slice(0, 16)}…`);
	console.log('macOS will ask for the login password to use the release key: «Allow», not «Always Allow».');
	const privateKey = readKey();
	if (!privateKey) fail('this Mac\'s Keychain has no release key (npm run release-key makes one)');
	const trusted = RELEASE_KEYS.includes(rawPublicKey(privateKey));
	if (!trusted && !dryRun) fail('the Keychain key is not the one RELEASE_KEYS in signature.js trusts');
	const sig = signRelease({ version, file: INSTALLER, sha512, privateKey });
	const sigFile = path.join(dir, `${INSTALLER}.sig`);
	fs.writeFileSync(sigFile, `${JSON.stringify(sig)}\n`);
	const self = checkSignature({ text: fs.readFileSync(sigFile, 'utf8'), version, file: INSTALLER, sha512, keys: [rawPublicKey(privateKey)] });
	if (self) fail(`the new signature does not check: ${self}`);
	if (dryRun) {
		console.log(`Dry run: signed into ${sigFile}${trusted ? '' : ' with a key signature.js does not trust'}; nothing uploaded or published.`);
		return;
	}

	gh(['release', 'upload', tag, sigFile, '--clobber', '-R', REPO]);
	gh(['release', 'edit', tag, '--draft=false', '--latest', '-R', REPO]);
	// What the app will see: the .sig from the public download link, checked against the keys it trusts.
	let seen = 'not fetched';
	for (let attempt = 0; attempt < 5 && seen !== null; attempt++) {
		if (attempt) await new Promise((resolve) => setTimeout(resolve, 3000));
		const response = await fetch(`https://github.com/${REPO}/releases/download/${tag}/${INSTALLER}.sig`).catch(() => null);
		seen = response?.ok ? checkSignature({ text: await response.text(), version, file: INSTALLER, sha512 }) : `HTTP ${response?.status ?? 'error'}`;
	}
	if (seen) fail(`published, but the public .sig did not check (${seen}): look at the release page before anyone updates`);
	console.log(`Signed and published ${tag}. Windows apps from the version with the check on install it when the streamer clicks «Перезапустити й оновити».`);
}

if (require.main === module) main(process.argv.slice(2)).catch((error) => fail(error?.message ?? error));

module.exports = { parseLatest, releaseProblem };
