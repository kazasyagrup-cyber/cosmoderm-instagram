// Yorum oto-cevabı (06.10): publish.mjs ile aynı workflow'da 15 dk'da bir çalışır.
// Yeni yorum -> konu tespiti (cilt tipi / fiyat / teslimat / sipariş / teşekkür) ->
//   yorum altına kısa cevap + Direct'e detay (private reply, yorum başına 1 kez, 7 gün içinde).
// Anlaşılmayan / sağlıkla ilgili hassas sorular otomatik cevaplanmaz: kısa "yakında cevaplayacağız" + sahibine WhatsApp bildirimi (CallMeBot).
// Bilgiler replies.json'dan (publish/gen-replies.mjs sitenin data.js'inden üretir — fiyat uydurulmaz).
// Ortam: IG_TOKEN, IG_USER_ID, WA_ORDER (sipariş WhatsApp, 7708...), CALLMEBOT_KEY + NOTIFY_PHONE (bildirim), DRY_RUN=1, COMMENTS_TEST=dosya.json (yerel deneme)
import fs from 'node:fs';

const TOKEN = process.env.IG_TOKEN;
const USER = process.env.IG_USER_ID;
const V = process.env.GRAPH_VERSION || 'v23.0';
const DRY = process.env.DRY_RUN === '1';
const WA = (process.env.WA_ORDER || '77087685328').replace(/\D/g, '');
const ME = 'cosmoderm.kz';
const MAX_PER_RUN = 15;
const MAX_AGE_D = 7; // private reply yalnız 7 gün içinde mümkün
const KB = JSON.parse(fs.readFileSync('replies.json', 'utf8'));
const statePath = 'state/comments.json';
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
const posted = fs.existsSync('state/posted.json') ? JSON.parse(fs.readFileSync('state/posted.json', 'utf8')) : {};
const fileOfMedia = Object.fromEntries(Object.entries(posted).filter(([, v]) => v?.id).map(([f, v]) => [v.id, f]));

const api = async (path, params = {}, method = 'GET', json = null) => {
	const url = new URL(`https://graph.instagram.com/${V}/${path}`);
	let res;
	if (method === 'GET') {
		url.search = new URLSearchParams({...params, access_token: TOKEN});
		res = await fetch(url);
	} else if (json) {
		url.search = new URLSearchParams({access_token: TOKEN});
		res = await fetch(url, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(json)});
	} else res = await fetch(url, {method, body: new URLSearchParams({...params, access_token: TOKEN})});
	const out = await res.json();
	if (!res.ok || out.error) throw new Error(`${path}: ${JSON.stringify(out.error || out)}`);
	return out;
};

// --- sınıflandırma ---
const KZ = /[әғқңөұүһі]/i;
const tokens = (t) => t.toLowerCase().replace(/ё/g, 'е').split(/[^\p{L}\p{N}+]+/u).filter(Boolean);
const has = (t, kws) => {
	const low = t.toLowerCase().replace(/ё/g, 'е');
	const tk = tokens(t);
	return kws.some((k) => (k.includes(' ') ? low.includes(k) : tk.some((w) => w.startsWith(k))));
};
const K = {
	price: ['цен', 'сколько', 'стоим', 'прайс', 'баға', 'бағасы', 'қанша', 'price', 'стоит'],
	delivery: ['доставк', 'жеткіз', 'достав', 'отправ', 'жібер', 'город', 'қала', 'астан', 'шымкент', 'караганд', 'актобе', 'атырау', 'павлодар', 'усть', 'костанай', 'тараз', 'семей'],
	order: ['заказ', 'купит', 'куплю', 'хочу', 'тапсырыс', 'алам', 'алғым', 'сатып', 'беріңіз', 'есть в наличии', 'наличи', 'бар ма'],
	original: ['оригинал', 'подделк', 'фейк', 'түпнұсқ', 'жалған'],
	wholesale: ['опт', 'оптом', 'көтерме', 'wholesale'],
	thanks: ['спасибо', 'рахмет', 'класс', 'супер', 'круто', 'отлично', 'керемет', 'тамаша', 'жақсы', 'люблю', 'нравит', 'ұнайды', 'красот', 'топ'],
	// автоматически НЕ отвечаем — пересылаем владельцу
	health: ['беремен', 'жүкті', 'кормлю', 'емізу', 'грудн', 'аллерг', 'лекарств', 'дәрі', 'лечени', 'емдеу', 'ожог', 'күйік', 'рана', 'жара', 'инфекц', 'врач', 'дәрігер', 'гормон', 'роаккутан', 'изотретиноин', 'новорожд', 'нәресте', 'младен'],
	complaint: ['жалоб', 'шағым', 'плох', 'нашар', 'обман', 'алдау', 'не пришел', 'не пришёл', 'келмеді', 'возврат', 'қайтару', 'брак'],
};
export function classify(text, mediaFile) {
	const lang = KZ.test(text) ? 'kz' : 'ru';
	const topics = Object.entries(KB.topics).filter(([, t]) => has(text, t.kw)).map(([k]) => k);
	const f = Object.fromEntries(Object.entries(K).map(([k, kw]) => [k, has(text, kw)]));
	const onlyEmoji = !/[\p{L}]/u.test(text.replace(/[0-9]/g, '')) ;
	const isNumber = /^\s*[0-9]{1,2}\s*[!.)]*\s*$/.test(text);
	const question = /\?/.test(text);
	const mediaProducts = (KB.files[mediaFile] || []).filter((id) => KB.products[id]);
	let action;
	if (f.health || f.complaint) action = 'notify';
	else if (topics.length || f.price || f.delivery || f.order || f.original || f.wholesale) action = 'dm';
	else if (onlyEmoji || isNumber || f.thanks) action = 'thanks';
	else action = question ? 'notify' : 'thanks_soft';
	return {lang, topics, ...f, onlyEmoji, isNumber, question, mediaProducts, action};
}

const T = {
	ru: {
		hi: (u) => `Здравствуйте${u ? ', ' + u : ''}! 🤍 Спасибо за комментарий.`,
		prices: 'Цены: обычная → с промокодом NAOS (−20%).',
		order: `Заказ в WhatsApp: https://wa.me/${WA}`,
		delivery: 'Доставка по всему Казахстану (CDEK, Yandex Go), 1–5 дней. В среднем 1 500 ₸ по Алматы и 2 500 ₸ в другие города — точная стоимость при подтверждении заказа.',
		original: 'Только оригинальная продукция Bioderma и Institut Esthederm (группа NAOS, Франция).',
		wholesale: 'Опт Bioderma и Institut Esthederm: https://www.cosmoderm.kz/wholesale.html — цены и условия по запросу в WhatsApp.',
		note: 'Это общая подборка по типу кожи, не медицинская консультация. Подробнее подскажем в WhatsApp.',
		pubDm: 'Спасибо! 💌 Ответили вам в Direct',
		pubThanks: 'Спасибо! 🤍',
		pubSoft: 'Спасибо за комментарий! 🤍 Напишите тип кожи — подберём уход 💬',
		pubWait: 'Спасибо за вопрос! Ответим вам в ближайшее время 💬',
		pubSorry: `Нам очень жаль! 🙏 Напишите, пожалуйста, в WhatsApp wa.me/${WA} — разберёмся как можно скорее`,
	},
	kz: {
		hi: (u) => `Сәлеметсіз бе${u ? ', ' + u : ''}! 🤍 Пікіріңізге рахмет.`,
		prices: 'Бағалар: қалыпты → NAOS промокодымен (−20%).',
		order: `Тапсырыс WhatsApp арқылы: https://wa.me/${WA}`,
		delivery: 'Қазақстан бойынша жеткізу (CDEK, Yandex Go), 1–5 күн. Алматы бойынша орташа 1 500 ₸, басқа қалаларға 2 500 ₸ — нақты құны тапсырысты растағанда.',
		original: 'Тек түпнұсқа Bioderma және Institut Esthederm өнімдері (NAOS тобы, Франция).',
		wholesale: 'Bioderma және Institut Esthederm көтерме саудасы: https://www.cosmoderm.kz/wholesale.html — бағалар мен шарттар WhatsApp арқылы.',
		note: 'Бұл тері түріне арналған жалпы ұсыныс, медициналық кеңес емес. Толығырақ WhatsApp-та айтамыз.',
		pubDm: 'Рахмет! 💌 Direct-ке жауап жаздық',
		pubThanks: 'Рахмет! 🤍',
		pubSoft: 'Пікіріңізге рахмет! 🤍 Тері түріңізді жазыңыз — күтім таңдап береміз 💬',
		pubWait: 'Сұрағыңызға рахмет! Жақын арада жауап береміз 💬',
		pubSorry: `Кешіріңіз! 🙏 WhatsApp-қа жазыңызшы wa.me/${WA} — тез арада шешеміз`,
	},
};

// Direct mesajı (Instagram sınırı 1000 karakter): her konu = başlık + ürünler; sığmazsa sondan ürün azalt, boş başlığı at
const NN = '\n\n';
export function composeDm(c, username) {
	const t = T[c.lang];
	const blocks = []; // [{title, items[]}]
	const split = (txt) => {
		const [title, ...items] = txt.split(NN);
		return {title, items};
	};
	if (c.topics.length) for (const k of c.topics.slice(0, 2)) blocks.push(split(KB.topics[k][c.lang]));
	else if (c.mediaProducts.length && (c.price || c.order)) blocks.push({title: '', items: c.mediaProducts.map((id) => KB.products[id][c.lang])});
	else if (c.price || c.order) blocks.push(split(KB.best[c.lang]));
	const extra = [];
	if (c.delivery) extra.push(t.delivery);
	if (c.original) extra.push(t.original);
	if (c.wholesale) extra.push(t.wholesale);
	const head = t.hi(username);
	const tail = [blocks.length ? t.prices : '', t.order, c.topics.length ? t.note : ''].filter(Boolean).join('\n');
	const render = () => [head, ...blocks.filter((b) => b.items.length).map((b) => [b.title, ...b.items].filter(Boolean).join(NN)), ...extra, tail].filter(Boolean).join(NN);
	// iki konu varsa önce dengeli kes: en uzun bloktan bir ürün çıkar
	while (render().length > 1000 && blocks.some((b) => b.items.length)) {
		const b = blocks.reduce((a, x) => (x.items.length > a.items.length ? x : a));
		b.items.pop();
	}
	return render().slice(0, 1000);
}

async function notifyOwner(text) {
	const key = process.env.CALLMEBOT_KEY;
	const phone = process.env.NOTIFY_PHONE;
	if (DRY) return console.log('DRY bildirim:', text);
	if (!key || !phone) {
		// WhatsApp (CallMeBot) ayarlanana kadar: GitHub issue → sahibine e-posta bildirimi
		const gh = process.env.GITHUB_TOKEN;
		const repo = process.env.GITHUB_REPOSITORY;
		if (!gh || !repo) return console.log('BİLDİRİM (kanal yok):', text);
		const r = await fetch(`https://api.github.com/repos/${repo}/issues`, {
			method: 'POST',
			headers: {Authorization: `Bearer ${gh}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json'},
			body: JSON.stringify({title: 'Instagram: cevap gerekiyor — ' + (text.split(/\n/)[1] || '').slice(0, 70), body: text, assignees: ['kazasyagrup-cyber']}),
		});
		return console.log('bildirim (GitHub issue):', r.status);
	}
	const u = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text.slice(0, 900))}&apikey=${encodeURIComponent(key)}`;
	const r = await fetch(u);
	console.log('bildirim gönderildi:', r.status);
}

async function handle(m, cm) {
	const c = classify(cm.text || '', fileOfMedia[m.id]);
	const rec = {at: new Date().toISOString(), media: m.id, user: cm.username, text: (cm.text || '').slice(0, 300), action: c.action, topics: c.topics};
	const t = T[c.lang];
	if (c.action === 'dm') {
		const dm = composeDm(c, cm.username);
		if (DRY) console.log(`DRY DM -> @${cm.username}:\n${dm}\n---\nyorum altı: ${t.pubDm}`);
		else {
			await api(`${USER}/messages`, {}, 'POST', {recipient: {comment_id: cm.id}, message: {text: dm}});
			await api(`${cm.id}/replies`, {message: t.pubDm}, 'POST');
		}
	} else if (c.action === 'notify') {
		const link = m.permalink || '';
		await notifyOwner(`📩 CosmoDerm Instagram — cevap gerekiyor\n@${cm.username}: "${(cm.text || '').slice(0, 400)}"\n${link}`);
		const msg = c.complaint ? t.pubSorry : t.pubWait;
		if (DRY) console.log(`DRY yorum altı -> @${cm.username}: ${msg}`);
		else await api(`${cm.id}/replies`, {message: msg}, 'POST');
	} else {
		const msg = c.action === 'thanks' ? t.pubThanks : t.pubSoft;
		if (DRY) console.log(`DRY yorum altı -> @${cm.username}: ${msg}`);
		else await api(`${cm.id}/replies`, {message: msg}, 'POST');
	}
	return rec;
}

async function main() {
	let media;
	if (process.env.COMMENTS_TEST) media = JSON.parse(fs.readFileSync(process.env.COMMENTS_TEST, 'utf8'));
	else {
		if (!TOKEN || !USER) throw new Error('IG_TOKEN / IG_USER_ID eksik');
		const since = Date.now() - MAX_AGE_D * 864e5;
		const list = (await api(`${USER}/media`, {fields: 'id,permalink,timestamp,comments_count', limit: 60})).data || [];
		media = [];
		for (const m of list.filter((x) => x.comments_count > 0 && Date.parse(x.timestamp) > since - 30 * 864e5)) {
			const cs = (await api(`${m.id}/comments`, {fields: 'id,text,username,timestamp,replies{username}', limit: 50})).data || [];
			media.push({...m, comments: cs});
		}
	}
	let n = 0;
	for (const m of media) {
		for (const cm of m.comments || []) {
			if (n >= MAX_PER_RUN) break;
			if (state[cm.id] || cm.username === ME) continue;
			if ((cm.replies?.data || []).some((r) => r.username === ME)) {
				state[cm.id] = {skipped: 'zaten cevaplanmış'};
				continue;
			}
			if (Date.now() - Date.parse(cm.timestamp) > MAX_AGE_D * 864e5) {
				state[cm.id] = {skipped: 'eski'};
				continue;
			}
			n++;
			try {
				state[cm.id] = await handle(m, cm);
				console.log('CEVAPLANDI:', cm.id, '@' + cm.username, state[cm.id].action, state[cm.id].topics.join(','));
			} catch (e) {
				const k = `__err:${cm.id}`;
				state[k] = (state[k] || 0) + 1;
				if (state[k] >= 3) state[cm.id] = {skipped: 'error', error: String(e.message).slice(0, 300)};
				console.error('HATA:', cm.id, e.message);
			}
		}
	}
	if (!DRY && !process.env.COMMENTS_TEST) {
		fs.mkdirSync('state', {recursive: true});
		fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
	}
	console.log(`yorumlar: ${n} işlendi`);
}
if (process.argv[1] && process.argv[1].endsWith('comments.mjs')) await main();
