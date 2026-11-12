// «Що показувати на моєму екрані» names topics (bd twitchclanhub_com-9i1): what the server's /screen page hides by.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SCREEN_TOPICS, keptSkips } = require('../screen-topics.js');

test('the menu lists the server\'s topics and `alerts`, nothing the site no longer draws', () => {
	assert.deepEqual(SCREEN_TOPICS.map(([topic]) => topic), ['donation', 'follow', 'raid', 'shoutout', 'alerts']);
	assert.ok(SCREEN_TOPICS.every(([, label]) => typeof label === 'string' && label.length > 0));
});

test('a skip saved by 0.6.3 or before (banner, rain, sticker) is dropped on load; a topic stays, once, in the menu\'s order', () => {
	assert.deepEqual(keptSkips(['banner', 'rain', 'sticker']), []);
	assert.deepEqual(keptSkips(['alerts', 'donation', 'banner', 'donation']), ['donation', 'alerts']);
	assert.deepEqual([keptSkips(undefined), keptSkips('donation'), keptSkips(null)], [[], [], []]);
});
