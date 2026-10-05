// GitHub Actions'ta saat başı çalışır: zamanı gelmiş ve henüz paylaşılmamış gönderileri Instagram'a yollar.
// Instagram API with Instagram Login (graph.instagram.com) — Facebook sayfası gerekmez.
// Ortam değişkenleri (GitHub Secrets): IG_TOKEN, IG_USER_ID · (opsiyonel) MEDIA_BASE, GRAPH_VERSION, DRY_RUN=1
// Dosyalar: schedule.json (make-schedule.mjs üretir), state/posted.json (bu script günceller, workflow commit'ler)
import fs from 'node:fs';

const TOKEN = process.env.IG_TOKEN;
const USER = process.env.IG_USER_ID;
const BASE = process.env.MEDIA_BASE || 'https://kazasyagrup-cyber.github.io/cosmoderm-instagram/media/';
const V = process.env.GRAPH_VERSION || 'v23.0';
const DRY = process.env.DRY_RUN === '1';
const MAX_PER_RUN = 2; // GitHub cron gecikirse birikenleri bir anda boşaltma
const MAX_LATE_H = 20; // bundan daha geç kalmış gönderiyi atla (ertesi güne taşma)

if (!DRY && (!TOKEN || !USER)) throw new Error('IG_TOKEN / IG_USER_ID eksik');

const schedule = JSON.parse(fs.readFileSync('schedule.json', 'utf8'));
const statePath = 'state/posted.json';
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const save = () => {
	fs.mkdirSync('state', {recursive: true});
	fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
};

const api = async (path, params = {}, method = 'POST') => {
	const url = new URL(`https://graph.instagram.com/${V}/${path}`);
	const body = new URLSearchParams({...params, access_token: TOKEN});
	const res = method === 'GET' ? await fetch(`${url}?${body}`) : await fetch(url, {method, body});
	const json = await res.json();
	if (!res.ok || json.error) throw new Error(`${path}: ${JSON.stringify(json.error || json)}`);
	return json;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(id) {
	// video işlenene kadar bekle (en fazla ~6 dk)
	for (let i = 0; i < 36; i++) {
		const s = await api(id, {fields: 'status_code,status'}, 'GET');
		if (s.status_code === 'FINISHED') return;
		if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`video işlenemedi: ${s.status}`);
		await sleep(10000);
	}
	throw new Error('video işleme zaman aşımı');
}

async function publish(post) {
	const url = BASE + encodeURIComponent(post.file);
	const params = post.kind === 'banner' ? {image_url: url, caption: post.caption} : {media_type: 'REELS', video_url: url, caption: post.caption, share_to_feed: 'true'};
	// özel kapak: profil ızgarasında boş/karanlık kare yerine logo + başlık + ürün + −20% görünsün (dosya varsa)
	const cover = post.file.replace(/\.mp4$/, '.cover.jpg');
	if (post.kind !== 'banner' && fs.existsSync('media/' + cover)) params.cover_url = BASE + encodeURIComponent(cover);
	const c = await api(`${USER}/media`, params);
	if (post.kind === 'banner') await sleep(5000);
	await waitReady(c.id);
	const p = await api(`${USER}/media_publish`, {creation_id: c.id});
	return p.id;
}

const now = Date.now();
const due = schedule.filter((p) => !state[p.file] && Date.parse(p.at) <= now);
let n = 0;
let failed = 0;
for (const post of due) {
	const lateH = (now - Date.parse(post.at)) / 3600e3;
	if (lateH > MAX_LATE_H) {
		state[post.file] = {skipped: 'late', at: new Date().toISOString()};
		console.log('ATLANDI (çok geç):', post.file);
		continue;
	}
	if (n >= MAX_PER_RUN) break;
	n++;
	try {
		if (DRY) {
			console.log('DRY_RUN — paylaşılacaktı:', post.at, post.file);
			continue;
		}
		const id = await publish(post);
		state[post.file] = {id, at: new Date().toISOString()};
		console.log('PAYLAŞILDI:', post.file, id);
	} catch (e) {
		failed++;
		const prev = state[`__err:${post.file}`] || 0;
		state[`__err:${post.file}`] = prev + 1;
		// aynı gönderi 3 kez hata verirse atla, sıradakileri kilitlemesin
		if (prev + 1 >= 3) state[post.file] = {skipped: 'error', error: String(e.message).slice(0, 300), at: new Date().toISOString()};
		console.error('HATA:', post.file, e.message);
	}
	save();
}
save();
const left = schedule.filter((p) => !state[p.file]).length;
console.log(`bu tur: ${n} denendi, ${failed} hata · kalan: ${left}/${schedule.length}`);
if (failed) process.exitCode = 1; // Actions'ta kırmızı görünsün (e-posta bildirimi gelir)
