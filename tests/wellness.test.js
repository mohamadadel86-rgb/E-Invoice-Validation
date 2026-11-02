/* تذكيرات الراحة: دقة مواقيت الصلاة، والفحص الصارم للإعدادات، وأن كل مستخدم يرى إعداداته هو فقط */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Prayer = require('../app/js/prayer');
const { startApp, Client, loggedIn, makeUser, ADMIN_PW, AUD_PW } = require('./helpers');

async function withApp(opts, fn) {
  const app = await startApp(opts);
  try { return await fn(app); } finally { app.cleanup(); }
}

const hm = (ms, tz) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
const toMin = (s) => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const near = (ms, tz, expected, label) => assert.ok(Math.abs(toMin(hm(ms, tz)) - toMin(expected)) <= 2, `${label}: ${hm(ms, tz)} بدل ${expected}`);

test('مواقيت الصلاة: القاهرة بطريقة الهيئة المصرية (شتوي وصيفي) في حدود دقيقتين', () => {
  const pr = { country: 'EG', city: 'cairo', method: 'egypt', asr: 'std' };
  const place = Prayer.place(pr);
  const w = Prayer.times({ y: 2026, m: 11, d: 2 }, place, 'egypt', 'std');
  near(w.fajr, place.tz, '04:42', 'فجر نوفمبر'); near(w.dhuhr, place.tz, '11:39', 'ظهر نوفمبر');
  near(w.asr, place.tz, '14:45', 'عصر نوفمبر'); near(w.maghrib, place.tz, '17:08', 'مغرب نوفمبر'); near(w.isha, place.tz, '18:26', 'عشاء نوفمبر');
  // التوقيت الصيفي في مصر (UTC+3) يُحسب تلقائياً من منطقة الدولة
  const s = Prayer.times({ y: 2026, m: 6, d: 21 }, place, 'egypt', 'std');
  near(s.fajr, place.tz, '04:08', 'فجر يونيو'); near(s.maghrib, place.tz, '19:59', 'مغرب يونيو');
  const hanafi = Prayer.times({ y: 2026, m: 11, d: 2 }, place, 'egypt', 'hanafi');
  assert.ok(hanafi.asr - w.asr > 30 * 60000, 'العصر الحنفي متأخر عن الشافعي');
});

test('مواقيت الصلاة: أم القرى العشاء بعد المغرب بـ 90 دقيقة، والترتيب سليم في كل الدول', () => {
  const place = Prayer.place({ country: 'SA', city: 'makkah' });
  const t = Prayer.times({ y: 2026, m: 11, d: 2 }, place, 'ummalqura', 'std');
  assert.equal(t.isha - t.maghrib, 90 * 60000);
  for (const [cc, c] of Object.entries(Prayer.COUNTRIES)) {
    assert.ok(Prayer.METHODS[c.method], cc + ' طريقة معروفة');
    for (const city of c.cities) {
      for (const m of [1, 6]) {
        const x = Prayer.times({ y: 2026, m, d: 21 }, { lat: city[2], lng: city[3] }, c.method, 'std');
        const seq = [x.fajr, x.sunrise, x.dhuhr, x.asr, x.maghrib, x.isha];
        assert.ok(seq.every(Number.isFinite) && seq.every((v, i) => i === 0 || v > seq[i - 1]), `${cc}/${city[0]} شهر ${m}`);
      }
    }
  }
  const nx = Prayer.next({ country: 'EG', city: 'cairo', method: 'egypt', asr: 'std' }, Date.UTC(2026, 10, 2, 21, 0));
  assert.equal(nx.key, 'fajr', 'بعد العشاء: الصلاة الجاية فجر اليوم التالي');
});

test('إعدادات التذكيرات: الافتراضي مقفول، والفحص يرفض أي قيمة غريبة', () => {
  const d = Prayer.clean({});
  assert.equal(d.prayer.on, false); assert.equal(d.water.on, false); assert.equal(d.move.on, false); assert.equal(d.eye.on, false);
  assert.equal(d.prayer.stages.fajr.iqamaMin, 20);
  const bad = [
    { prayer: { country: 'XX' } }, { prayer: { country: 'EG', city: 'paris' } }, { prayer: { method: 'nope' } },
    { prayer: { asr: 'x' } }, { prayer: { stages: { fajr: { preMin: 0 } } } }, { prayer: { stages: { asr: { iqamaMin: 61 } } } },
    { prayer: { stages: { isha: { adhan: 'yes' } } } }, { water: { min: 5 } }, { eye: { min: 1.5 } }, { sound: 'adhan.mp3' },
    { prayer: { country: 'EG', city: 'custom', lat: 95, lng: 31 } }, { prayer: { country: 'EG', city: 'custom', lat: 30, lng: '31' } },
    { prayer: { country: 'US', city: 'custom', lat: 40, lng: -74, tz: 'Africa/Cairo' } }, [], null,
  ];
  for (const b of bad) assert.throws(() => Prayer.clean(b), (e) => e.status === 400, JSON.stringify(b));
  const us = Prayer.clean({ prayer: { country: 'US', city: 'custom', lat: 40.123456, lng: -74, tz: 'America/Chicago' } });
  assert.equal(us.prayer.lat, 40.1235); assert.equal(us.prayer.tz, 'America/Chicago');
  assert.equal(Prayer.clean({ prayer: { country: 'SA' } }).prayer.method, 'ummalqura', 'طريقة الدولة الافتراضية');
});

test('إعدادات التذكيرات على الخادم: شخصية لكل مستخدم، ومحمية بالدخول والفحص', async () => {
  await withApp({ fixture: true }, async (app) => {
    assert.equal((await new Client(app).get('/api/v2/me/wellness')).status, 401, 'بدون دخول');
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const def = await aud.get('/api/v2/me/wellness');
    assert.equal(def.status, 200);
    assert.equal(def.json.value.prayer.on, false, 'مقفولة افتراضياً');

    const mine = { prayer: { on: true, country: 'EG', city: 'alex', stages: { fajr: { iqama: false } } }, water: { on: true, min: 45 }, sound: 'none' };
    const put = await aud.put('/api/v2/me/wellness', { value: mine });
    assert.equal(put.status, 200);
    const back = (await aud.get('/api/v2/me/wellness')).json.value;
    assert.equal(back.prayer.city, 'alex'); assert.equal(back.prayer.stages.fajr.iqama, false); assert.equal(back.water.min, 45); assert.equal(back.sound, 'none');
    assert.equal((await admin.get('/api/v2/me/wellness')).json.value.prayer.on, false, 'المدير ما يشوفش إعدادات غيره ولا تتأثر إعداداته');

    assert.equal((await aud.put('/api/v2/me/wellness', { value: { water: { min: 1 } } })).status, 400);
    assert.equal((await aud.put('/api/v2/me/wellness', { value: { prayer: { country: '__proto__' } } })).status, 400);
    assert.equal((await aud.post('/api/v2/me/wellness', { value: {} })).status, 405);
    assert.equal((await aud.get('/api/v2/me/wellness')).json.value.water.min, 45, 'الطلب المرفوض ما غيّرش حاجة');
    const col = await admin.get('/api/v2/col/wellness');
    assert.ok(col.status === 403 || col.status === 404, 'مش متاحة كمجموعة بيانات عامة');

    // حذف مستخدم عنده إعدادات تذكيرات يشتغل عادي، ومستخدم جديد بنفس الاسم يبدأ من الافتراضي
    const tmp = await makeUser(admin, 'tmpw', { envelopes: true });
    const tc = await loggedIn(app, 'tmpw', tmp.password);
    assert.equal((await tc.put('/api/v2/me/wellness', { value: { eye: { on: true } } })).status, 200);
    assert.equal((await admin.del('/api/v2/users/' + tmp.id)).status, 200);
    const again = await makeUser(admin, 'tmpw', { envelopes: true });
    const tc2 = await loggedIn(app, 'tmpw', again.password);
    assert.equal((await tc2.get('/api/v2/me/wellness')).json.value.eye.on, false);
  });
});
