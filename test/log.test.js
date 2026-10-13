'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createLog, redact, MAX_BYTES } = require('../log.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tch-log-'));

test('a log line carries a timestamp, and tail returns the newest lines in order', () => {
	const log = createLog({ dir: tmp(), now: () => new Date('2026-10-14T10:00:00Z') });
	for (let i = 1; i <= 5; i++) log.write(`line ${i}`);
	assert.deepEqual(log.tail(2).split('\n'), ['2026-10-14T10:00:00.000Z line 4', '2026-10-14T10:00:00.000Z line 5']);
});

test('nothing secret reaches the file: a Bearer header and long opaque strings are hidden', () => {
	const dir = tmp();
	const log = createLog({ dir });
	const token = 'T'.repeat(43);
	log.write(`request failed: Authorization: Bearer ${token}`);
	log.write(`pairing ${'D'.repeat(43)} approved`);
	const text = fs.readFileSync(path.join(dir, 'app.log'), 'utf8');
	assert.equal(text.includes(token), false);
	assert.equal(text.includes('D'.repeat(43)), false);
	assert.match(text, /Bearer \[hidden\]/);
	assert.equal(redact('ABCD-EFGH is a code and stays readable'), 'ABCD-EFGH is a code and stays readable');
});

test('the file rolls over at its size limit and tail reads across both files', () => {
	const dir = tmp();
	const log = createLog({ dir });
	const filler = 'x '.repeat(500);
	for (let i = 0; i < Math.ceil(MAX_BYTES / 1000) + 20; i++) log.write(`${i} ${filler}`);
	assert.ok(fs.existsSync(path.join(dir, 'app.log.1')), 'rotated');
	assert.ok(fs.statSync(path.join(dir, 'app.log')).size <= MAX_BYTES + 2000);
	assert.ok(log.tail(3).split('\n').length === 3);
});

test('a log in a folder that cannot be written never throws', () => {
	const log = createLog({ dir: path.join(os.tmpdir(), 'tch-no', '\0bad') });
	assert.doesNotThrow(() => log.write('still fine'));
	assert.equal(log.tail(), '');
});
