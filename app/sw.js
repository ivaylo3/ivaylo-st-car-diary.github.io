// Car Diary service worker
// 1) Кешира самото приложение, за да се отваря и без интернет.
// 2) Получава ежедневния сигнал от GitHub Actions и показва известие.
//    Сигналът не носи данни: какво да се покаже се изчислява тук,
//    от копието на сроковете, което приложението пази на устройството.
const CACHE = 'car-diary-v10';
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

// Връща списък с позиции, за които днес има ново „стъпало“ (30, 7, 3... дни; 1500/500 км; просрочено).
async function dueToday() {
  const snap = await readJSON('due.json');
  if (!snap) return { snap: null, list: [] };
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
  list.sort((a, b) => (b.over - a.over) || ((a.dLeft ?? 1e9) - (b.dLeft ?? 1e9)));
  return { snap, list, sent };
}

async function showDaily() {
  const { snap, list, sent } = await dueToday();
  if (!snap || !list.length) return;
  const overdue = list.filter(x => x.over).length;
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
