// What «Що показувати на моєму екрані» hides (bd twitchclanhub_com-9i1, a streamer 2026-11-12: «коли використовуєш
// програму для виведення на мій екран алертів, донат, фолов буде вискакувати на мій екран»). The server's page
// (twitchclanhub.com apps/api/public/fx.html) hides an alert whose topic is in ?skip=: what caused it, the server's
// FX_TOPICS, and `alerts` for one with none, what a viewer bought with Channel Points or clan credits.
//
// Until 0.6.4 the menu listed kinds the site removed on 2026-10-25 (banners, emoji rain, stickers), so it hid
// nothing. A skip saved then names one of those: it is dropped on load, as it never matches anything again.

const SCREEN_TOPICS = [
	['donation', 'Донати'],
	['follow', 'Фоловери й підписки'],
	['raid', 'Рейди'],
	['shoutout', 'Шатаути'],
	['alerts', 'Меми й звуки від глядачів'],
];

/** The saved skips this menu still has, each once, in the menu's order; anything else is gone. */
function keptSkips(skip) {
	if (!Array.isArray(skip)) return [];
	return SCREEN_TOPICS.map(([topic]) => topic).filter((topic) => skip.includes(topic));
}

module.exports = { SCREEN_TOPICS, keptSkips };
