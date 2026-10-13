// The sign-in: ask the server for a pairing, show its code, poll until the streamer approves it in
// the dashboard, return the device token. Pure (fetch and sleep are injected) so it is tested
// without Electron or a server. The token never appears in a URL: it comes back in a JSON body.
'use strict';

class PairingError extends Error { constructor(reason) { super(reason); this.reason = reason; } }

async function post(fetchImpl, base, path, body) {
	const response = await fetchImpl(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
	let json = null;
	try { json = await response.json(); } catch { /* not JSON: handled by the caller through status */ }
	return { status: response.status, json };
}

/**
 * Resolves with the token. `onCode({ userCode, verifyUrl })` fires once, as soon as the code exists.
 * Rejects with PairingError('expired' | 'cancelled' | 'unreachable' | 'bad_response').
 */
async function pairDevice({ base, name, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onCode, isCancelled = () => false, now = Date.now }) {
	let started;
	try { started = await post(fetchImpl, base, '/desktop/pair/start', { name }); } catch { throw new PairingError('unreachable'); }
	const info = started.json;
	if (started.status !== 200 || !info || typeof info.deviceCode !== 'string' || typeof info.userCode !== 'string') throw new PairingError('bad_response');
	onCode?.({ userCode: info.userCode, verifyUrl: info.verifyUrl });
	const deadline = now() + (Number(info.expiresIn) || 600) * 1000;
	const interval = Math.max(1, Number(info.interval) || 3) * 1000;
	let failures = 0;
	while (now() < deadline) {
		if (isCancelled()) throw new PairingError('cancelled');
		await sleep(interval);
		if (isCancelled()) throw new PairingError('cancelled');
		let polled;
		try { polled = await post(fetchImpl, base, '/desktop/pair/poll', { deviceCode: info.deviceCode }); } catch { if (++failures > 20) throw new PairingError('unreachable'); continue; }
		failures = 0;
		if (polled.status === 410) throw new PairingError('expired');
		if (polled.status === 200 && polled.json?.status === 'approved' && typeof polled.json.token === 'string') return polled.json.token;
		if (polled.status === 200 && polled.json?.status === 'pending') continue;
		if (polled.status === 429) { await sleep(interval); continue; }
		throw new PairingError('bad_response');
	}
	throw new PairingError('expired');
}

module.exports = { pairDevice, PairingError };
