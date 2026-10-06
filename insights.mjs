// İstatistik toplayıcı (06.10, Faz 1): publish.mjs ile aynı workflow'da çalışır, kendi aralığını kendisi tutar.
//  - Reels/feed: 2 saatte bir, son 30 günün gönderileri  - Story: saatte bir (24 saat dolunca API'den kaybolur)
//  - Hesap: günlük erişim/izlenme/profil ziyareti/takipçi
// Çıktı: metrics/AAAA-AA-GG.json (o günün son ölçümü, media_id başına) + metrics/account.json (gün başına)
// Ortam: IG_TOKEN, IG_USER_ID, (yerel deneme) INSIGHTS_FORCE=1
import fs from 'node:fs';

const TOKEN = process.env.IG_TOKEN;
const USER = process.env.IG_USER_ID;
const V = process.env.GRAPH_VERSION || 'v23.0';
const FORCE = process.env.INSIGHTS_FORCE === '1';
if (!TOKEN || !USER) throw new Error('IG_TOKEN / IG_USER_ID eksik');

const M = {
	REELS: ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'],
	FEED: ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'profile_visits', 'follows'],
	STORY: ['views', 'reach', 'replies', 'shares', 'total_interactions', 'navigation', 'follows', 'profile_visits'],
	ACCOUNT: ['reach', 'views', 'accounts_engaged', 'total_interactions', 'profile_views', 'website_clicks', 'likes', 'comments', 'shares', 'saves', 'replies'],
};
const KIND2TYPE = {banner: 'FEED', carousel: 'FEED', igstory: 'STORY'}; // diğerleri (talk/story(ugc)/routine/spot) = REELS

const get = async (path, params = {}) => {
	const u = new URL(`https://graph.instagram.com/${V}/${path}`);
	u.search = new URLSearchParams({...params, access_token: TOKEN});
	const j = await (await fetch(u)).json();
	if (j.error) throw new Error(j.error.message);
	return j;
};
const val = (d) => d.values?.[0]?.value ?? d.total_value?.value ?? null;

// toplu dene; desteklenmeyen ölçüm varsa tek tek dene (API birini reddedince hepsini reddediyor)
async function metrics(id, list, extra = {}) {
	try {
		const j = await get(`${id}/insights`, {metric: list.join(','), ...extra});
		return Object.fromEntries(j.data.map((d) => [d.name, val(d)]));
	} catch (e) {
		if (/does not exist|expired|Unsupported get request|Object with ID/i.test(e.message)) return null; // silinmiş/süresi dolmuş
		const out = {};
		for (const m of list) {
			try {
				const j = await get(`${id}/insights`, {metric: m, ...extra});
				out[m] = val(j.data[0]);
			} catch {}
		}
		return Object.keys(out).length ? out : null;
	}
}

const statePath = 'state/insights.json';
const st = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const now = Date.now();
const due = (k, h) => FORCE || !st[k] || now - Date.parse(st[k]) >= h * 3600e3 - 5 * 60e3;
const day = new Date(now + 5 * 3600e3).toISOString().slice(0, 10); // Almatı günü
fs.mkdirSync('metrics', {recursive: true});
const dayPath = `metrics/${day}.json`;
const snap = fs.existsSync(dayPath) ? JSON.parse(fs.readFileSync(dayPath, 'utf8')) : {};

const posted = JSON.parse(fs.readFileSync('state/posted.json', 'utf8'));
const sched = Object.fromEntries(JSON.parse(fs.readFileSync('schedule.json', 'utf8')).map((p) => [p.file, p]));
const items = Object.entries(posted)
	.filter(([f, v]) => v?.id && !f.startsWith('__'))
	.map(([file, v]) => ({file, id: v.id, at: v.at, kind: sched[file]?.kind || (/^(hl|ts|tbest)/.test(file) && !/\.cover/.test(file) ? 'igstory' : 'talk')}));
// schedule'da olmayan eski dosyalar: uzantıdan tür tahmini
for (const it of items) if (!sched[it.file] && /\.jpe?g$/i.test(it.file) && !/^hl/.test(it.file)) it.kind = 'banner';

let n = 0;
const doStories = due('stories', 1);
const doPosts = due('posts', 2);
for (const it of items) {
	const type = KIND2TYPE[it.kind] || 'REELS';
	const ageH = (now - Date.parse(it.at)) / 3600e3;
	if (type === 'STORY' ? !doStories || ageH > 24.5 : !doPosts || ageH > 30 * 24) continue;
	const m = await metrics(it.id, M[type]);
	if (!m) continue;
	snap[it.id] = {file: it.file, kind: it.kind, type, posted_at: it.at, measured_at: new Date(now).toISOString(), ...m};
	n++;
}
if (doStories) st.stories = new Date(now).toISOString();
if (doPosts) st.posts = new Date(now).toISOString();

if (due('account', 2)) {
	const acc = fs.existsSync('metrics/account.json') ? JSON.parse(fs.readFileSync('metrics/account.json', 'utf8')) : {};
	const a = (await metrics(USER, M.ACCOUNT, {period: 'day', metric_type: 'total_value'})) || {};
	const u = await get(USER, {fields: 'followers_count,follows_count,media_count'});
	acc[day] = {...acc[day], ...a, followers: u.followers_count, media_count: u.media_count, measured_at: new Date(now).toISOString()};
	fs.writeFileSync('metrics/account.json', JSON.stringify(acc, null, 1));
	st.account = new Date(now).toISOString();
	console.log(`hesap: takipçi ${u.followers_count}, erişim ${a.reach ?? '-'}, profil ziyareti ${a.profile_views ?? '-'}`);
}
fs.writeFileSync(dayPath, JSON.stringify(snap, null, 1));
fs.mkdirSync('state', {recursive: true});
fs.writeFileSync(statePath, JSON.stringify(st, null, 1));
console.log(`istatistik: ${n} gönderi ölçüldü (story ${doStories ? 'evet' : 'hayır'}, gönderi ${doPosts ? 'evet' : 'hayır'})`);
