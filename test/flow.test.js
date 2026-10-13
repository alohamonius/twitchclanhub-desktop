'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pairDevice, PairingError } = require('../flow.js');

const reply = (status, json) => ({ status, json: async () => json });
const start = reply(200, { deviceCode: 'D'.repeat(43), userCode: 'ABCD-EFGH', verifyUrl: 'https://x.test/dashboard?pair=ABCD-EFGH', expiresIn: 600, interval: 3 });

function script(...answers) {
	const calls = [];
	const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); const next = answers.shift(); if (next instanceof Error) throw next; return next; };
	return { fetchImpl, calls };
}
const clock = () => { let t = 0; return () => (t += 1000); };

test('shows the code, polls while pending, returns the token once approved', async () => {
	const { fetchImpl, calls } = script(start, reply(200, { status: 'pending' }), reply(200, { status: 'pending' }), reply(200, { status: 'approved', token: 'T'.repeat(43) }));
	let shown;
	const token = await pairDevice({ base: 'https://x.test', name: 'KIRA-PC', fetchImpl, onCode: (c) => { shown = c; }, sleep: async () => {}, now: clock() });
	assert.equal(token, 'T'.repeat(43));
	assert.equal(shown.userCode, 'ABCD-EFGH');
	assert.deepEqual(calls[0], { url: 'https://x.test/desktop/pair/start', body: { name: 'KIRA-PC' } });
	assert.equal(calls[1].url, 'https://x.test/desktop/pair/poll');
	assert.equal(calls.length, 4);
});

test('an expired pairing, an unreachable server and a nonsense reply each end it with a reason', async () => {
	const base = 'https://x.test';
	const expired = script(start, reply(410, { status: 'expired' }));
	await assert.rejects(pairDevice({ base, name: 'a', fetchImpl: expired.fetchImpl, sleep: async () => {}, now: clock() }), (e) => e instanceof PairingError && e.reason === 'expired');
	const down = script(new Error('offline'));
	await assert.rejects(pairDevice({ base, name: 'a', fetchImpl: down.fetchImpl, sleep: async () => {}, now: clock() }), (e) => e.reason === 'unreachable');
	const odd = script(reply(200, { nope: 1 }));
	await assert.rejects(pairDevice({ base, name: 'a', fetchImpl: odd.fetchImpl, sleep: async () => {}, now: clock() }), (e) => e.reason === 'bad_response');
});

test('a brief network drop while polling is survived; cancelling stops at once', async () => {
	const base = 'https://x.test';
	const flaky = script(start, new Error('blip'), reply(200, { status: 'approved', token: 'T'.repeat(43) }));
	assert.equal(await pairDevice({ base, name: 'a', fetchImpl: flaky.fetchImpl, sleep: async () => {}, now: clock() }), 'T'.repeat(43));
	const cancel = script(start, reply(200, { status: 'pending' }));
	let slept = 0;
	await assert.rejects(pairDevice({ base, name: 'a', fetchImpl: cancel.fetchImpl, sleep: async () => { slept++; }, now: clock(), isCancelled: () => slept >= 1 }), (e) => e.reason === 'cancelled');
});
