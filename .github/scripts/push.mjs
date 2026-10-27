// Изпраща ежедневния сигнал за известия до всички регистрирани устройства.
// Сигналът не съдържа данни от книжката – устройството само решава какво да покаже.
import webpush from 'web-push';

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
// Ежедневният сигнал тръгва само между 11:00 и 12:59 българско време.
if ((PUSH_TYPE || 'daily') === 'daily' && process.env.GITHUB_EVENT_NAME === 'schedule') {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', hour12: false }).format(new Date()));
  if (h < 11 || h > 12) { console.log(`В София е ${h} ч. – не е време за известия.`); process.exit(0); }
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
