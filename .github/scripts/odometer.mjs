// Километраж от официалното MyŠkoda Public API (GET /api/v1/vehicles/{VIN}?include=odometer).
//
// ODO_MODE=auto  – сутрешна проверка: само ако в София е 8 ч; до 4 опита (8:30, 8:40, 8:50, 9:00), спира при успех.
// ODO_MODE=now   – синхронизация от приложението: една заявка.
//
// Ако колата още не е изпратила данни, пускането НЕ е грешка: пазим предишния километраж и записваме
// кога е бил опитът и с какъв код. Грешка (и имейл от GitHub) има само при реален проблем – ключ/VIN/тайни.
//
// Резултатът се криптира (AES-256-GCM, ключ от ODO_SECRET чрез PBKDF2) и се записва във файл.
// Логовете на публично репо са публични – тук не се печатат никакви стойности.
import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const _log = console.log;
console.log = (...a) => { const m = a.join(' '); _log(m); if (process.env.GITHUB_ACTIONS) _log('::notice title=MyŠkoda::' + m.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')); };

const { SKODA_API_KEY, SKODA_VIN, ODO_SECRET } = process.env;
const MODE = process.env.ODO_MODE === 'auto' ? 'auto' : 'now';
const REQ = (process.env.ODO_REQUEST || '').slice(0, 40);
const OUT = process.argv[2] || 'odo.json', PREV = process.argv[3] || '';
const ATTEMPTS = Number(process.env.ODO_ATTEMPTS || 4), GAP_MIN = Number(process.env.ODO_GAP_MIN ?? 10);

if (!SKODA_API_KEY || !SKODA_VIN || !ODO_SECRET) { console.log('Липсва SKODA_API_KEY, SKODA_VIN или ODO_SECRET в GitHub Secrets.'); process.exit(1); }

if (MODE === 'auto' && !process.env.ODO_IGNORE_HOUR) {
  // GitHub работи по UTC – пуска се в 05:30 и 06:30 UTC; работим само когато в София е 8:xx (зимно и лятно време).
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', hour12: false }).format(new Date()));
  if (h !== 8) { console.log(`В София е ${h} ч – сутрешната проверка е в 8:30, това пускане се пропуска.`); process.exit(0); }
}

const WHY = {
  ODOMETER_UNAVAILABLE: 'колата още не е изпратила километража (не е карана скоро или е без връзка)',
  ODOMETER_DISABLED: 'услугата за километраж е изключена – проверете онлайн услугите в MyŠkoda',
  ODOMETER_UNSUPPORTED: 'Škoda не предоставя километраж за тази кола през това API',
  NO_ODOMETER: 'в отговора няма километраж',
  RATE_LIMIT: 'достигнат е лимитът от заявки за часа',
  NETWORK: 'Škoda API не отговори',
  HTTP_401: 'ключът е невалиден или изтекъл – създайте нов в MyŠkoda и обновете SKODA_API_KEY',
  HTTP_403: 'ключът няма достъп до тази кола – проверете SKODA_VIN',
  HTTP_404: 'колата не е намерена – проверете SKODA_VIN'
};
const FATAL = new Set(['HTTP_401', 'HTTP_403', 'HTTP_404']);

let keyExpires = null;
async function attempt() {
  const url = 'https://public.api.connect.skoda-auto.cz/api/v1/vehicles/' + encodeURIComponent(SKODA_VIN.trim()) + '?include=odometer';
  let res;
  try { res = await fetch(url, { headers: { 'X-API-Key': SKODA_API_KEY.trim(), Accept: 'application/json' } }); }
  catch (e) { return { code: 'NETWORK' }; }
  const h = n => res.headers.get(n);
  console.log('HTTP', res.status, '· оставащи заявки:', h('RateLimit-Remaining') ?? '?', '/', h('RateLimit-Limit') ?? '?');
  if (h('X-API-Key-Expires-At')) keyExpires = h('X-API-Key-Expires-At');
  if (res.status === 429) return { code: 'RATE_LIMIT' };
  if (!res.ok) return { code: 'HTTP_' + res.status };
  let data; try { data = await res.json(); } catch (_) { return { code: 'NO_ODOMETER' }; }
  const odo = data && data.vehicle && data.vehicle.odometer;
  if (odo && typeof odo.mileageInKm === 'number') return { ok: true, km: Math.round(odo.mileageInKm), at: odo.carCapturedTimestamp || null };
  const errs = Array.isArray(data && data.errors) ? data.errors.map(e => String(e && e.type || '')) : [];
  return { code: errs.find(e => e.startsWith('ODOMETER_')) || 'NO_ODOMETER' };
}

const enc = new TextEncoder(), b64 = u => Buffer.from(u).toString('base64'), unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
async function keyFor(salt, use) {
  const base = await crypto.subtle.importKey('raw', enc.encode(ODO_SECRET), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, [use]);
}
async function readPrev() {
  if (!PREV || !existsSync(PREV)) return null;
  try {
    const f = JSON.parse(readFileSync(PREV, 'utf8'));
    const k = await keyFor(unb64(f.salt), 'decrypt');
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv) }, k, unb64(f.ct))));
  } catch (_) { console.log('Предишните данни не могат да се прочетат (сменена ли е ODO_SECRET?) – започваме наново.'); return null; }
}
async function write(obj) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(salt, 'encrypt'), enc.encode(JSON.stringify(obj))));
  writeFileSync(OUT, JSON.stringify({ v: 1, alg: 'PBKDF2-SHA256-250000/AES-256-GCM', salt: b64(salt), iv: b64(iv), ct: b64(ct) }));
}

let r = null;
const tries = MODE === 'auto' ? ATTEMPTS : 1;
for (let i = 0; i < tries; i++) {
  if (i) { console.log(`Опит ${i + 1} от ${tries} след ${GAP_MIN} мин…`); await new Promise(s => setTimeout(s, GAP_MIN * 60000)); }
  r = await attempt();
  if (r.ok || FATAL.has(r.code)) break;
  console.log('Няма свежи данни:', r.code, '–', WHY[r.code] || '');
}

const now = new Date().toISOString(), prev = await readPrev();
let out;
if (r.ok) {
  out = { v: 2, km: r.km, at: r.at || now, fetched: now, keyExpires: keyExpires || (prev && prev.keyExpires) || null, lastAttempt: now, lastOk: true, code: null, req: REQ || null };
  console.log('Километражът е взет (vehicle.odometer.mileageInKm).');
} else {
  out = Object.assign({ v: 2 }, prev || {}, { keyExpires: keyExpires || (prev && prev.keyExpires) || null, lastAttempt: now, lastOk: false, code: r.code, req: REQ || null });
  console.log(prev && typeof prev.km === 'number' ? 'Запазен е предишният километраж; записан е само неуспешният опит.' : 'Още няма запазен километраж; записан е само опитът.');
}
if (keyExpires) console.log('Ключът е валиден до:', keyExpires.slice(0, 10));
await write(out);
console.log('Готово: криптираният файл е записан.');

if (!r.ok && FATAL.has(r.code)) { console.log('Грешка:', WHY[r.code]); process.exit(1); }
