// Изпраща ежедневния сигнал за известия до всички регистрирани устройства.
// Сигналът не съдържа данни от книжката – устройството само решава какво да покаже.
import webpush from 'web-push';

// Съобщенията се показват и като анотации на пускането (видими през API), без данни от книжката.
const _log = console.log;
console.log = (...a) => { const m = a.join(' '); _log(m); if (process.env.GITHUB_ACTIONS) _log('::notice title=Push::' + m.replace(/%/g, '%25').replace(/\r/g, '').replace(/\n/g, '%0A')); };

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_SUBSCRIPTIONS, PUSH_TYPE, SITE_URL } = process.env;
if (!VAPID_PRIVATE_KEY) { console.error('Липсва секретът VAPID_PRIVATE_KEY.'); process.exit(1); }
if (!PUSH_SUBSCRIPTIONS || !PUSH_SUBSCRIPTIONS.trim()) { console.log('Няма регистрирани устройства (секретът PUSH_SUBSCRIPTIONS е празен).'); process.exit(0); }

// Приема JSON масив или по един JSON обект на ред.
function parseSubs(text) {
  const t = text.trim();
  if (t.startsWith('[')) return JSON.parse(t);
  return t.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
}

webpush.setVapidDetails(SITE_URL || 'https://github.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
// Предпазител: ежедневният сигнал тръгва само между 11:00 и 12:59 в София, без значение кой е пуснал проверката
// (напр. ако задачата във външния планировчик е настроена по-често). Тестовото известие не се ограничава.
if ((PUSH_TYPE || 'daily') === 'daily' && !process.env.PUSH_IGNORE_HOUR) {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', hour12: false }).format(new Date()));
  if (h < 11 || h > 12) { console.log(`В София е ${h} ч. – ежедневният сигнал е между 11:00 и 12:59.`); process.exit(0); }
}
// План: сигнал само в дните, в които устройството ще има ново напомняне (иначе Chrome показва
// „This site has been updated in the background“). Ако план няма или не се чете – пращаме както преди.
if ((PUSH_TYPE || 'daily') === 'daily' && process.env.PLAN_FILE && process.env.ODO_SECRET) {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    if (existsSync(process.env.PLAN_FILE)) {
      const { webcrypto: c } = await import('node:crypto');
      const f = JSON.parse(readFileSync(process.env.PLAN_FILE, 'utf8')), b = s => new Uint8Array(Buffer.from(s, 'base64'));
      const base = await c.subtle.importKey('raw', new TextEncoder().encode(process.env.ODO_SECRET), 'PBKDF2', false, ['deriveKey']);
      const key = await c.subtle.deriveKey({ name: 'PBKDF2', salt: b(f.salt), iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const plan = JSON.parse(new TextDecoder().decode(await c.subtle.decrypt({ name: 'AES-GCM', iv: b(f.iv) }, key, b(f.ct))));
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia' }).format(new Date());
      if (plan && Array.isArray(plan.days) && plan.until >= today) {
        if (!plan.days.includes(today)) { console.log('Днес няма нови напомняния по плана – сигнал не се праща.'); process.exit(0); }
        console.log('Днес има ново напомняне по плана.');
      } else console.log('Планът е изтекъл – пращаме без план.');
    } else console.log('Още няма план – пращаме без план.');
  } catch (e) { console.log('Планът не може да се прочете – пращаме без план.'); }
}
const subs = parseSubs(PUSH_SUBSCRIPTIONS);
const payload = JSON.stringify({ type: PUSH_TYPE || 'daily' });
let ok = 0, gone = 0, failed = 0;
for (const [i, s] of subs.entries()) {
  try {
    await webpush.sendNotification(s, payload, { TTL: 12 * 3600, urgency: 'normal' });
    ok++;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) { gone++; console.log(`Устройство ${i + 1}: абонаментът е изтекъл – махнете този ред от PUSH_SUBSCRIPTIONS и включете известията отново на устройството.`); }
    else { failed++; console.log(`Устройство ${i + 1}: грешка ${e.statusCode || ''} ${e.body || e.message}`); }
  }
}
console.log(`Изпратени: ${ok}, изтекли: ${gone}, грешки: ${failed}`);
if (failed && !ok) process.exit(1);
