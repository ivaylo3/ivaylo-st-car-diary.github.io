// Car Diary service worker
// 1) Кешира самото приложение, за да се отваря и без интернет.
// 2) Получава ежедневния сигнал от GitHub Actions и показва известие.
//    Сигналът не носи данни: какво да се покаже се изчислява тук,
//    от копието на сроковете, което приложението пази на устройството.
const CACHE = 'car-diary-v15';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png', 'icons/badge-72.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== 'cd-notify').map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then(m => m || caches.match('index.html')))
  );
});

// ---------- известия ----------
const DAY = 864e5;
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function parse(s) { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2]); }
function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / DAY); }
function fmtK(n) { return Math.round(n).toLocaleString('bg-BG'); }
function dd(s) { const p = s.split('-'); return p[2] + '.' + p[1]; }

async function readJSON(name) {
  const c = await caches.open('cd-notify');
  const r = await c.match(name);
  return r ? r.json() : null;
}
async function writeJSON(name, obj) {
  const c = await caches.open('cd-notify');
  await c.put(name, new Response(JSON.stringify(obj), { headers: { 'Content-Type': 'application/json' } }));
}

// Километраж от MyŠkoda: същият криптиран файл, който чете приложението (без заявка към Škoda).
function b64(s) { const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
async function freshKm(snap) {
  try {
    const cfg = await readJSON('odo-cfg.json');
    if (!cfg || !cfg.url || !cfg.pass) return snap;
    const r = await fetch(cfg.url + '?t=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return snap;
    const f = await r.json(), enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(cfg.pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(f.salt), iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const p = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(f.iv) }, key, b64(f.ct))));
    const d = ymd(new Date(p.at));
    if (typeof p.km === 'number' && p.km > snap.km && d >= snap.kmDate) return Object.assign({}, snap, { km: p.km, kmDate: d });
  } catch (_) {}
  return snap;
}

// Връща списък с позиции, за които днес има ново „стъпало“ (30, 7, 3... дни; 1500/500 км; просрочено).
async function dueToday() {
  let snap = await readJSON('due.json');
  if (!snap) return { snap: null, list: [] };
  snap = await freshKm(snap);
  const today = ymd(new Date());
  const sent = (await readJSON('sent.json')) || {};
  const days = (snap.days || [30, 7, 3, 1, 0]).slice().sort((a, b) => a - b);
  const marks = (snap.kmMarks || [1500, 500, 0]).slice().sort((a, b) => a - b);
  const kmNow = snap.km + (snap.rate || 0) * Math.max(0, daysBetween(snap.kmDate, today));
  const list = [];
  for (const it of snap.items) {
    const dLeft = it.d ? daysBetween(today, it.d) : null;
    const kmLeft = it.km != null ? it.km - kmNow : null;
    let step = null, text = '';
    if (it.appt) {
      // запазен час за сервиз: 3 дни, 1 ден преди и в самия ден (ако часът още не е минал)
      if (dLeft == null || dLeft < 0) continue;
      if (dLeft === 0 && it.t) { const hm = it.t.split(':').map(Number), n = new Date(); if (n.getHours() * 60 + n.getMinutes() > hm[0] * 60 + hm[1]) continue; }
      const aStep = (it.days || [3, 1, 0]).slice().sort((a, b) => a - b).find(x => dLeft <= x);
      if (aStep === undefined) continue;
      const key = it.k + '@' + it.d + ' ' + (it.t || '');
      const at = it.t ? ' в ' + it.t : '';
      text = dLeft === 0 ? 'днес' + at : dLeft === 1 ? 'утре' + at + ' (' + dd(it.d) + ')' : 'след ' + dLeft + ' дни – ' + dd(it.d) + at;
      if (sent[key] !== 'a' + aStep) list.push({ key, step: 'a' + aStep, n: it.n, text, over: false, dLeft, appt: true });
      continue;
    }
    const over = (dLeft != null && dLeft < 0) || (kmLeft != null && kmLeft <= 0);
    if (over) {
      const since = dLeft != null && dLeft < 0 ? -dLeft : 0;
      step = 'over' + Math.floor(since / (snap.overdueEvery || 3));
      text = dLeft != null && dLeft < 0 ? 'просрочено с ' + (-dLeft) + (dLeft === -1 ? ' ден' : ' дни') : 'просрочено по километри';
    } else {
      const dStep = dLeft != null ? days.find(x => dLeft <= x) : undefined;
      const kStep = kmLeft != null ? marks.find(x => kmLeft <= x) : undefined;
      if (dStep !== undefined) { step = 'd' + dStep; text = dLeft === 0 ? 'днес' : 'след ' + dLeft + (dLeft === 1 ? ' ден' : ' дни') + ' (' + dd(it.d) + ')'; }
      if (kStep !== undefined && (step === null || kmLeft <= 1500)) { step = (step ? step + '|' : '') + 'k' + kStep; text = (text ? text + ' · ' : '') + '≈ ' + fmtK(Math.max(0, kmLeft)) + ' км'; }
    }
    const key = it.k + '@' + (it.d || '') + '/' + (it.km != null ? it.km : '');
    if (step && sent[key] !== step) list.push({ key, step, n: it.n, text, over, dLeft });
  }
  list.sort((a, b) => (b.over - a.over) || ((b.appt ? 1 : 0) - (a.appt ? 1 : 0)) || ((a.dLeft ?? 1e9) - (b.dLeft ?? 1e9)));
  return { snap, list, sent };
}

async function showDaily() {
  const { snap, list, sent } = await dueToday();
  if (!snap || !list.length) return;
  const overdue = list.filter(x => x.over).length;
  const appts = list.filter(x => x.appt);
  if (appts.length === list.length) {
    // само напомняне за сервиз – отделно, по-ясно известие
    const a = appts[0];
    await self.registration.showNotification('Час за сервиз ' + a.text, {
      body: a.n + (appts.length > 1 ? '\n…и още ' + (appts.length - 1) + ' запазени часа' : ''), tag: 'car-diary-appt', renotify: true,
      icon: 'icons/icon-192.png', badge: 'icons/badge-72.png', data: { url: (snap.url || './') + '#service' }
    });
    for (const x of list) sent[x.key] = x.step;
    await writeJSON('sent.json', sent);
    return;
  }
  const title = overdue ? (overdue === 1 ? '1 просрочено обслужване' : overdue + ' просрочени') + (list.length > overdue ? ' и още ' + (list.length - overdue) : '')
                        : (list.length === 1 ? list[0].n : list.length + ' неща наближават');
  const body = list.slice(0, 5).map(x => x.n + ': ' + x.text).join('\n') + (list.length > 5 ? '\n…и още ' + (list.length - 5) : '');
  await self.registration.showNotification(title, {
    body, tag: 'car-diary-daily', renotify: true,
    icon: 'icons/icon-192.png', badge: 'icons/badge-72.png',
    data: { url: snap.url || './' }
  });
  for (const x of list) sent[x.key] = x.step;
  await writeJSON('sent.json', sent);
}

self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (_) {}
  if (msg.type === 'test') {
    e.waitUntil(dueToday().then(({ snap, list }) => self.registration.showNotification('Car Diary · известията работят', {
      body: snap ? (list.length ? 'Днес има ' + list.length + ' за напомняне.' : 'Днес няма нови напомняния.') : 'Отворете приложението веднъж, за да заредим сроковете.',
      tag: 'car-diary-test', icon: 'icons/icon-192.png', badge: 'icons/badge-72.png', data: { url: snap && snap.url || './' }
    })));
    return;
  }
  e.waitUntil(showDaily());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
