// Взима километража от официалното MyŠkoda Public API – ЕДНА заявка на пускане, без повторни опити.
// Резултатът се криптира (AES-256-GCM, ключ от ODO_SECRET чрез PBKDF2) и се записва в odo.json.
// ВАЖНО: логовете на публично репо са публични – тук не се печатат никакви стойности,
// само имена на полета, HTTP статус и колко заявки остават.
import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// Съобщенията се показват и като анотации на пускането (видими в GitHub и през API), без стойности.
const _log = console.log;
console.log = (...a) => { const m = a.join(' '); _log(m); if (process.env.GITHUB_ACTIONS) _log('::notice title=MyŠkoda::' + m.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')); };

const { SKODA_API_KEY, SKODA_VIN, ODO_SECRET } = process.env;
const OUT = process.argv[2] || 'odo.json';
if (!SKODA_API_KEY || !SKODA_VIN || !ODO_SECRET) { console.log('Липсва SKODA_API_KEY, SKODA_VIN или ODO_SECRET в GitHub Secrets.'); process.exit(1); }

const url = 'https://public.api.connect.skoda-auto.cz/api/v1/vehicles/' + encodeURIComponent(SKODA_VIN.trim());
let res;
try {
  res = await fetch(url, { headers: { 'X-API-Key': SKODA_API_KEY.trim(), Accept: 'application/json' } });
} catch (e) { console.log('Škoda API не отговори:', e.message); process.exit(1); }

const h = n => res.headers.get(n);
console.log('HTTP', res.status, '· оставащи заявки:', h('RateLimit-Remaining') ?? '?', '/', h('RateLimit-Limit') ?? '?');
const keyExpires = h('X-API-Key-Expires-At') || null;
if (keyExpires) console.log('Ключът е валиден до:', keyExpires.slice(0, 10));

if (!res.ok) {
  let problem = '';
  try { const j = await res.json(); problem = j.type || j.title || ''; } catch (_) {}
  const hint = {
    401: 'Ключът е невалиден или изтекъл – създайте нов в MyŠkoda и обновете SKODA_API_KEY.',
    403: 'Ключът няма достъп до тази кола (проверете SKODA_VIN и за коя кола е ключът).',
    404: 'Колата не е намерена – проверете SKODA_VIN.',
    429: 'Лимитът на заявки е достигнат – следващият опит е утре.'
  }[res.status] || 'Неочакван отговор.';
  console.log(hint, problem ? '(' + String(problem).replace(/https?:\/\/\S+\/problems\//, '') + ')' : '');
  process.exit(1);
}

const data = await res.json();

// Търсим полето за километража, без да знаем точната структура.
const found = [];
(function walk(o, path) {
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o)) {
    const p = path ? path + '.' + k : k;
    if (/odometer|mileage|totaldistance/i.test(k)) {
      if (typeof v === 'number') found.push({ p, v, unit: /(In)?Meters?$|InM$/.test(k) && !/kilo|km/i.test(k) ? 'm' : 'km' });
      else if (v && typeof v === 'object') {
        for (const [k2, v2] of Object.entries(v)) if (typeof v2 === 'number' && /^(value|km|inkm|valueinkm|kilometers|distance)$/i.test(k2)) found.push({ p: p + '.' + k2, v: v2, unit: /^(m|meters?|metres?)$/i.test(String(v.unit || '').trim()) ? 'm' : 'km' });
      }
    }
    if (v && typeof v === 'object') walk(v, p);
  }
})(data, '');

if (!found.length) {
  const paths = [];
  (function list(o, path, d) { if (!o || typeof o !== 'object' || d > 5) return; for (const [k, v] of Object.entries(o)) { const p = path ? path + '.' + k : k; paths.push(p + ':' + (Array.isArray(v) ? 'array' : typeof v)); if (v && typeof v === 'object') list(v, p, d + 1); } })(data, '', 0);
  console.log('Не намерих поле за километраж. Полета в отговора (без стойности):\n' + paths.join('\n'));
  process.exit(1);
}
// пропускаме полета като „км до следващ сервиз/инспекция“ или пробег
const good = found.filter(f => !/until|next|service|inspection|remaining|range|interval|due/i.test(f.p));
if (!good.length) { console.log('Намерени са само полета за сервизни интервали, не за километража:', found.map(f => f.p).join(', ')); process.exit(1); }
const best = good[0];
const km = Math.round(best.unit === 'm' ? best.v / 1000 : best.v);
console.log('Километражът е взет от полето:', best.p);

// време на отчитане от колата, ако го има
let capturedAt = null;
(function walk(o) { if (!o || typeof o !== 'object' || capturedAt) return; for (const [k, v] of Object.entries(o)) { if (!capturedAt && typeof v === 'string' && /capturedAt|timestamp|updatedAt|carCapturedTimestamp/i.test(k) && !isNaN(Date.parse(v))) capturedAt = v; else if (v && typeof v === 'object') walk(v); } })(data);

const payload = JSON.stringify({ v: 1, km, at: capturedAt || new Date().toISOString(), fetched: new Date().toISOString(), keyExpires });

const enc = new TextEncoder();
const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
const base = await crypto.subtle.importKey('raw', enc.encode(ODO_SECRET), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(payload)));
const b64 = u => Buffer.from(u).toString('base64');
writeFileSync(OUT, JSON.stringify({ v: 1, alg: 'PBKDF2-SHA256-250000/AES-256-GCM', salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
console.log('Готово: криптираният файл е записан.');
