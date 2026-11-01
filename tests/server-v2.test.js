/* اختبارات المرحلة A: الدخول والجلسات والصلاحيات والأسرار على الخادم (/api/v2)
 * التشغيل:  node --test
 * كل اختبار يحاول التجاوز كمستخدم غير مخوّل، والمطلوب أن يُرفض. لا يلمس بيانات المستخدم (مجلدات مؤقتة).
 * ملف التجربة tests/fixtures/v1-browser.einv أنشأه كود المتصفح الحقيقي، فاختبار التوافق حقيقي (admin / aud). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { startApp, Client, loggedIn, makeUser, ADMIN_PW, AUD_PW, sleep } = H;

const policy = require('../server/policy');

async function withApp(opts, fn) {
  const app = await startApp(opts);
  try { return await fn(app); } finally { app.cleanup(); }
}

/* ============ التوافق مع ملف المتصفح ============ */
test('توافق: الخادم يفتح ملف أنشأه كود المتصفح الحقيقي، والأسرار لا تخرج منه أبداً', async () => {
  await withApp({ fixture: true }, async (app) => {
    const anon = new Client(app);
    const st = await anon.get('/api/v2/status');
    assert.equal(st.status, 200);
    assert.equal(st.json.needsSetup, false);

    const wrongUser = await new Client(app).login('nobody', 'Whatever-123');
    const wrongPass = await new Client(app).login('admin', 'Wrong-Pass-123');
    assert.equal(wrongUser.status, 401);
    assert.equal(wrongPass.status, 401);
    assert.deepEqual(Object.keys(wrongUser.json).sort(), Object.keys(wrongPass.json).sort(), 'نفس شكل الرد لاسم موجود وغير موجود (لا كشف للأسماء)');
    assert.equal(wrongUser.json.message, wrongPass.json.message);

    const admin = new Client(app);
    const r = await admin.login('admin', ADMIN_PW);
    assert.equal(r.status, 200);
    assert.equal(r.json.user.role, 'admin');
    assert.equal(r.json.user.perms.users, true);
    assert.equal(r.json.user.weakPassword, false);

    const env = await admin.get('/api/v2/col/envelopes');
    assert.equal(env.json.value[0].supplier, 'مورد-تجربة-سري');
    const quotes = await admin.get('/api/v2/col/quotes');
    assert.equal(quotes.json.value.length, 1);
    const act = await admin.get('/api/v2/activity');
    assert.ok(act.json.value.some((a) => a.action === 'إنشاء ظرف'));

    const settings = await admin.get('/api/v2/col/settings');
    assert.equal(settings.json.value.ai.gemini.hasKey, true);
    assert.equal(settings.json.value.eta.hasSecret, true);
    assert.equal(settings.json.value.eta.clientId, 'client-id-abc');
    assert.doesNotMatch(settings.text, /SECRET-KEY-123|ETA-SECRET-XYZ/, 'الأسرار لا تظهر في رد الإعدادات حتى للمدير');
    assert.doesNotMatch(admin.seen.join('\n'), /SECRET-KEY-123|ETA-SECRET-XYZ|"wrap"|"salt"/, 'لا أسرار ولا مفاتيح مغلّفة في أي رد');
  });
});

test('توافق: الملف يظل بصيغة المتصفح (للرجوع للنسخة القديمة) والبيانات مشفرة على القرص', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const q = (await admin.get('/api/v2/col/quotes')).json.value;
    q[0].items.push({ id: 'i2', no: '2', name: 'صنف-سري-جديد-777', spec: '', unit: 'عدد', price: 5, vat: 14 });
    assert.equal((await admin.put('/api/v2/col/quotes', { value: q })).status, 200);
    const s = await admin.put('/api/v2/col/settings', { value: { ai: { gemini: { key: 'TOP-SECRET-AAA' } } } });
    assert.equal(s.status, 200);
    const text = fs.readFileSync(app.mainFile, 'utf8');
    const obj = JSON.parse(text);
    assert.equal(obj.format, 'einvoice-validation-backup');
    assert.equal(obj.version, 1);
    assert.ok(obj.data['c:envelopes'].iv && obj.data['c:envelopes'].ct, 'صندوق مشفر بنفس بنية المتصفح');
    assert.ok(obj.data.users[0].wrap.salt && obj.data.users[0].wrap.iter === 310000);
    for (const secret of ['مورد-تجربة-سري', 'صنف-سري-جديد-777', 'TOP-SECRET-AAA', 'SECRET-KEY-123', 'ETA-SECRET-XYZ']) assert.ok(!text.includes(secret), 'ظهر نص غير مشفر على القرص: ' + secret);
    const day = fs.readdirSync(path.join(app.dataDir, 'نسخ يومية'));
    assert.equal(day.length, 1, 'نسخة يومية');
  });
});

/* ============ الإعداد الأول ============ */
test('الإعداد الأول: مرة واحدة فقط، ويفرض سياسة كلمة المرور، ويدخل المدير تلقائياً', async () => {
  await withApp({}, async (app) => {
    const c = new Client(app);
    assert.equal((await c.get('/api/v2/status')).json.needsSetup, true);
    assert.equal((await c.login('admin', 'Whatever-123')).status, 409, 'لا دخول قبل الإعداد');
    for (const pw of ['1234', 'abcdefgh', '12345678', 'Password123']) {
      const r = await c.post('/api/v2/setup', { username: 'admin', displayName: 'م', password: pw });
      assert.equal(r.status, 400, 'كلمة ضعيفة: ' + pw);
    }
    assert.equal((await c.post('/api/v2/setup', { username: 'bad<name>', displayName: 'م', password: 'Good-Pass-2026' })).status, 400, 'اسم دخول بحروف غير مسموحة');
    assert.equal(fs.existsSync(app.mainFile), false, 'لا يُنشأ شيء بعد الرفض');
    const ok = await c.post('/api/v2/setup', { username: 'admin', displayName: 'المدير', password: 'Good-Pass-2026' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.role, 'admin');
    assert.equal((await c.get('/api/v2/me')).status, 200, 'دخل تلقائياً');
    assert.equal((await new Client(app).post('/api/v2/setup', { username: 'x', displayName: 'x', password: 'Good-Pass-2027' })).status, 409, 'لا إعداد ثانٍ');
    const settings = (await c.get('/api/v2/col/settings')).json.value;
    assert.equal(settings.categories.length, 4);
    assert.equal(settings.whtRate, 1);
  });
});

/* ============ الجلسات ============ */
test('الجلسات: كوكي HttpOnly، ومعرّف جديد عند كل دخول (Session Fixation)، وتسجيل الخروج يُبطلها', async () => {
  await withApp({ fixture: true }, async (app) => {
    const anon = new Client(app);
    for (const p of ['/api/v2/me', '/api/v2/col/quotes', '/api/v2/users', '/api/v2/activity']) assert.equal((await anon.get(p)).status, 401, p + ' بدون جلسة');
    assert.equal((await new Client(app).call('GET', '/api/v2/me', undefined, { Cookie: 'einv_s=' + 'ab'.repeat(32) })).status, 401, 'جلسة مزوّرة');

    const c = new Client(app);
    const r1 = await c.login('admin', ADMIN_PW);
    assert.match(r1.setCookie, /HttpOnly/);
    assert.match(r1.setCookie, /SameSite=Strict/);
    const sid1 = c.sid;
    assert.match(sid1, /^[0-9a-f]{64}$/);
    assert.equal((await c.get('/api/v2/me')).status, 200);

    // دخول ثانٍ بنفس الكوكي: يُنشأ معرّف جديد ويُلغى القديم
    const r2 = await c.login('admin', ADMIN_PW);
    assert.equal(r2.status, 200);
    assert.notEqual(c.sid, sid1);
    const old = new Client(app); old.sid = sid1;
    assert.equal((await old.get('/api/v2/me')).status, 401, 'المعرّف القديم لم يعد صالحاً');

    const out = await c.post('/api/v2/logout');
    assert.equal(out.status, 200);
    assert.match(out.setCookie, /Max-Age=0/);
    const after = new Client(app); after.sid = c.sid;
    assert.equal((await after.get('/api/v2/me')).status, 401);
  });
});

test('الجلسات: تنتهي بعد مدة الخمول على الخادم، ويمكن الدخول من جديد بعدها', async () => {
  await withApp({ fixture: true, env: { EINVOICE_TEST_IDLE_MS: '400' } }, async (app) => {
    const c = await loggedIn(app, 'admin', ADMIN_PW);
    assert.equal((await c.get('/api/v2/me')).status, 200);
    await sleep(900);
    assert.equal((await c.get('/api/v2/me')).status, 401, 'انتهت بسبب الخمول');
    const again = await loggedIn(app, 'admin', ADMIN_PW);
    assert.equal((await again.get('/api/v2/col/quotes')).status, 200, 'يمكن فتح البيانات من جديد');
  });
});

/* ============ قفل محاولات الدخول (على الخادم، ويبقى بعد إعادة التشغيل) ============ */
test('قفل الدخول: 4 محاولات خاطئة = إيقاف دقيقة، حتى بكلمة الصحيحة، ويبقى بعد إعادة تشغيل الخادم', async () => {
  const app = await startApp({ fixture: true });
  let app2 = null;
  try {
    const c = new Client(app);
    const codes = [];
    for (const u of ['admin', 'nobody', 'admin', 'admin']) codes.push((await c.login(u, 'Wrong-Pass-999')).status);
    assert.deepEqual(codes, [401, 401, 401, 429], 'الرابعة تقفل (وأسماء غير مسجلة تُحسب أيضاً)');
    const locked = await c.login('admin', ADMIN_PW);
    assert.equal(locked.status, 429, 'الكلمة الصحيحة مرفوضة أثناء القفل');
    assert.ok(locked.json.until > Date.now());
    assert.equal((await c.get('/api/v2/status')).json.lockedUntil !== null, true);

    await sleep(800); // الحفظ المؤجل للسجل (الإيقاف القسري على ويندوز لا يحفظ)
    app.stop(); await sleep(300);
    app2 = await startApp({ dir: app.dir, fixture: true });
    const c2 = new Client(app2);
    assert.equal((await c2.login('admin', ADMIN_PW)).status, 429, 'القفل باقٍ بعد إعادة التشغيل (لا يُمسح بمسح بيانات المتصفح)');

    fs.rmSync(path.join(app2.dataDir, '.login-lock.json')); // محاكاة انتهاء الدقيقة
    const ok = await c2.login('admin', ADMIN_PW);
    assert.equal(ok.status, 200);

    // سجل الدخول: المحاولات الفاشلة مسجلة، والنص المكتوب لاسم غير موجود غير مسجل
    const log = (await c2.get('/api/v2/auditlog')).json.value;
    assert.ok(log.some((e) => e.type === 'locked'));
    assert.ok(log.filter((e) => e.type === 'fail').every((e) => e.username === 'admin' || e.username === 'اسم غير مسجل'));
    assert.equal(log.filter((e) => e.username === 'nobody').length, 0, 'الاسم غير المسجل لا يُحفظ');
  } finally { app.cleanup(); if (app2) app2.cleanup(); }
});

test('سجل الدخول: يكتبه الخادم (جلسات + خروج)، ولا يقرؤه إلا من لديه صلاحية المستخدمين', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    assert.equal((await aud.get('/api/v2/auditlog')).status, 403);
    let log = (await admin.get('/api/v2/auditlog')).json.value;
    const mine = log.filter((e) => e.type === 'session' && e.username === 'aud').pop();
    assert.ok(mine && mine.end === null, 'جلسة مفتوحة');
    assert.equal(mine.role, 'auditor');
    await aud.post('/api/v2/logout');
    log = (await admin.get('/api/v2/auditlog')).json.value;
    const done = log.find((e) => e.id === mine.id);
    assert.ok(done.end >= done.at && done.endReason === 'تسجيل خروج');
  });
});

/* ============ مصفوفة الصلاحيات ============ */
test('الصلاحيات: مصفوفة كاملة (كل مستخدم × كل مورد) مفروضة على الخادم', async () => {
  const ai = await H.startMockAi();
  try {
    await withApp({ fixture: true, env: { EINVOICE_TEST_AI_BASE: `http://127.0.0.1:${ai.port}` } }, async (app) => {
      const admin = await loggedIn(app, 'admin', ADMIN_PW);
      const users = {
        admin: admin,
        aud: await loggedIn(app, 'aud', AUD_PW),
      };
      const defs = { quo: { quotes: true }, set: { settings: true }, usr: { users: true }, apr: { envelopes: true, approve: true }, non: {} };
      for (const [name, perms] of Object.entries(defs)) { const u = await makeUser(admin, name, perms); users[name] = await loggedIn(app, name, u.password); }
      const snap = {
        settings: (await admin.get('/api/v2/col/settings')).json.value,
        quotes: (await admin.get('/api/v2/col/quotes')).json.value,
        envelopes: (await admin.get('/api/v2/col/envelopes')).json.value,
        mappings: (await admin.get('/api/v2/col/mappings')).json.value,
      };
      const A = (...n) => new Set(n);
      const rows = [
        ['GET settings', (c) => c.get('/api/v2/col/settings'), A('admin', 'aud', 'quo', 'set', 'usr', 'apr', 'non')],
        ['PUT settings', (c) => c.put('/api/v2/col/settings', { value: snap.settings }), A('admin', 'set')],
        ['GET quotes', (c) => c.get('/api/v2/col/quotes'), A('admin', 'aud', 'quo', 'set', 'usr', 'apr', 'non')],
        ['PUT quotes', (c) => c.put('/api/v2/col/quotes', { value: snap.quotes }), A('admin', 'quo', 'apr')], // apr: بلا تغيير فعلي (قاعدة ملء ق.م أدناه)
        ['GET envelopes', (c) => c.get('/api/v2/col/envelopes'), A('admin', 'aud', 'apr')],
        ['PUT envelopes', (c) => c.put('/api/v2/col/envelopes', { value: snap.envelopes }), A('admin', 'aud', 'apr')],
        ['GET mappings', (c) => c.get('/api/v2/col/mappings'), A('admin', 'aud', 'set', 'apr')],
        ['PUT mappings', (c) => c.put('/api/v2/col/mappings', { value: snap.mappings }), A('admin', 'aud', 'set', 'apr')],
        ['GET users', (c) => c.get('/api/v2/users'), A('admin', 'usr')],
        ['GET activity', (c) => c.get('/api/v2/activity'), A('admin', 'usr')],
        ['GET auditlog', (c) => c.get('/api/v2/auditlog'), A('admin', 'usr')],
        ['GET backup', (c) => c.get('/api/v2/backup'), A('admin', 'usr')],
        ['POST ai/call', (c) => c.post('/api/v2/ai/call', { provider: 'gemini', system: 's', prompt: 'p' }), A('admin', 'aud', 'quo', 'set', 'apr')],
        ['POST eta', (c) => c.post('/api/v2/eta', { path: '/api/v1.0/documents/submit', query: {} }), A('admin', 'aud', 'apr')],
        ['POST eta/test', (c) => c.post('/api/v2/eta/test', {}), A('__none__')], // الاختبار بشبكة حقيقية: نتأكد فقط من الرفض لغير المخوّلين أدناه
        ['GET ai/status', (c) => c.get('/api/v2/ai/status'), A('admin', 'aud', 'quo', 'set', 'usr', 'apr', 'non')],
        ['GET eta/status', (c) => c.get('/api/v2/eta/status'), A('admin', 'aud', 'quo', 'set', 'usr', 'apr', 'non')],
        ['POST activity', (c) => c.post('/api/v2/activity', { section: 'quotes', action: 'تجربة', details: '' }), A('admin', 'aud', 'quo', 'set', 'usr', 'apr', 'non')],
      ];
      for (const [label, fn, okSet] of rows) {
        for (const [name, c] of Object.entries(users)) {
          if (label === 'POST eta/test' && (name === 'admin' || name === 'set')) continue; // مسموح لهما، ولا نتصل بشبكة حقيقية
          const r = await fn(c);
          const expectOk = okSet.has(name);
          assert.equal(r.status === 403, !expectOk, `${label} كـ ${name}: وجدنا ${r.status} (متوقع ${expectOk ? 'مسموح' : '403'})`);
          if (expectOk) assert.ok(r.status >= 200 && r.status < 300, `${label} كـ ${name}: ${r.status} ${r.text.slice(0, 120)}`);
        }
      }
      // الاسترجاع: للمدير فقط (حتى صاحب صلاحية المستخدمين)
      for (const [name, c] of Object.entries(users)) {
        const r = await c.post('/api/v2/restore', 'not-a-backup');
        assert.equal(r.status, name === 'admin' ? 400 : 403, `restore كـ ${name}: ${r.status}`);
      }
      // الإعدادات: من لا يملك صلاحية الإعدادات لا يرى حتى إعدادات الربط
      const plain = (await users.aud.get('/api/v2/col/settings')).json.value;
      assert.equal(plain.ai, undefined);
      assert.equal(plain.eta, undefined);
      assert.ok(Array.isArray(plain.categories));
      const cfg = (await users.set.get('/api/v2/col/settings')).json.value;
      assert.ok(cfg.ai.gemini.hasKey !== undefined && cfg.eta.hasSecret !== undefined);
      // مجموعات غير مسموحة عبر مسار البيانات العام
      for (const n of ['profiles', 'users', 'activity', 'auditlog', 'constructor', '__proto__']) assert.ok([404].includes((await admin.get('/api/v2/col/' + n)).status), n + ' لا تُقرأ كمجموعة');
    });
  } finally { ai.close(); }
});

/* ============ إدارة المستخدمين (نفس قواعد الواجهة لكن على الخادم) ============ */
test('المستخدمون: المراجع لا يرقّي نفسه ولا يلمس المدير، وتغيير كلمة مروره يحتاج القديمة', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const users = (await admin.get('/api/v2/users')).json.value;
    const adminId = users.find((u) => u.username === 'admin').id;
    const audId = users.find((u) => u.username === 'aud').id;
    assert.ok(!JSON.stringify(users).includes('wrap'), 'قائمة المستخدمين بلا أسرار');

    const aud = await loggedIn(app, 'aud', AUD_PW);
    assert.equal((await aud.get('/api/v2/users')).status, 403);
    assert.equal((await aud.post('/api/v2/users', { username: 'evil', password: 'Evil-Pass-2026', role: 'admin', perms: {} })).status, 403);
    assert.equal((await aud.put('/api/v2/users/' + audId, { displayName: 'x', role: 'admin', perms: {} })).status, 403, 'ترقية النفس لمدير');
    assert.equal((await aud.put('/api/v2/users/' + audId, { displayName: 'x', role: 'auditor', perms: { users: true, settings: true } })).status, 403, 'رفع صلاحيات النفس');
    assert.equal((await aud.post('/api/v2/users/' + adminId + '/password', { password: 'Hacked-Pass-2026', oldPassword: AUD_PW })).status, 403, 'تغيير كلمة مرور المدير');
    assert.equal((await aud.del('/api/v2/users/' + adminId)).status, 403);
    assert.equal((await new Client(app).login('admin', ADMIN_PW)).status, 200, 'كلمة مرور المدير ما تغيّرت');

    // تغيير كلمة مروره بنفسه: لازم القديمة، والسياسة، وتُنهي جلساته الأخرى
    const other = await loggedIn(app, 'aud', AUD_PW); // جلسة أخرى لنفس المستخدم
    assert.equal((await aud.post('/api/v2/users/' + audId + '/password', { password: 'Brand-New-2026x' })).status, 403, 'بدون القديمة');
    assert.equal((await aud.post('/api/v2/users/' + audId + '/password', { password: 'Brand-New-2026x', oldPassword: 'wrong' })).status, 403, 'قديمة خطأ');
    assert.equal((await aud.post('/api/v2/users/' + audId + '/password', { password: '1234', oldPassword: AUD_PW })).status, 400, 'ضعيفة');
    assert.equal((await aud.post('/api/v2/users/' + audId + '/password', { password: 'Brand-New-2026x', oldPassword: AUD_PW })).status, 200);
    assert.equal((await aud.get('/api/v2/me')).status, 200, 'جلسته الحالية تبقى');
    assert.equal((await other.get('/api/v2/me')).status, 401, 'جلسته الأخرى انتهت');
    assert.equal((await new Client(app).login('aud', AUD_PW)).status, 401, 'القديمة لا تعمل');
    assert.equal((await new Client(app).login('aud', 'Brand-New-2026x')).status, 200);
  });
});

test('المستخدمون: صاحب صلاحية "المستخدمين" (غير مدير) لا يمنح مدير ولا صلاحية لا يملكها ولا يمس المدير', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const adminId = (await admin.get('/api/v2/users')).json.value.find((u) => u.username === 'admin').id;
    const usr = await makeUser(admin, 'usr', { users: true });
    const c = await loggedIn(app, 'usr', usr.password);
    assert.equal((await c.post('/api/v2/users', { username: 'e1', password: 'Evil-Pass-2026', role: 'admin', perms: {} })).status, 403, 'منح مدير');
    assert.equal((await c.post('/api/v2/users', { username: 'e2', password: 'Evil-Pass-2026', role: 'auditor', perms: { settings: true } })).status, 403, 'صلاحية لا يملكها');
    assert.equal((await c.put('/api/v2/users/' + usr.id, { displayName: 'x', role: 'auditor', perms: { users: true, settings: true } })).status, 403, 'يرفع صلاحياته');
    assert.equal((await c.put('/api/v2/users/' + usr.id, { displayName: 'x', role: 'admin', perms: { users: true } })).status, 403, 'يرقّي نفسه');
    assert.equal((await c.put('/api/v2/users/' + adminId, { displayName: 'x', role: 'auditor', perms: {} })).status, 403, 'يعدّل المدير');
    assert.equal((await c.post('/api/v2/users/' + adminId + '/password', { password: 'Hacked-Pass-2026' })).status, 403, 'كلمة مرور المدير');
    assert.equal((await c.del('/api/v2/users/' + adminId)).status, 403, 'يحذف المدير');
    // المسموح: مراجع بصلاحية يملكها، ثم حذفه، وتعيين كلمة مرور لمراجع
    const ok = await c.post('/api/v2/users', { username: 'ok1', displayName: 'ok', password: 'Okay-Pass-2026', role: 'auditor', perms: { users: true } });
    assert.equal(ok.status, 200);
    assert.equal((await c.post('/api/v2/users/' + ok.json.id + '/password', { password: 'Okay-Pass-2027' })).status, 200);
    assert.equal((await c.del('/api/v2/users/' + ok.json.id)).status, 200);
    assert.equal((await new Client(app).login('admin', ADMIN_PW)).status, 200, 'المدير سليم');
  });
});

test('المستخدمون: قواعد المدير (آخر مدير، أدوار وصلاحيات مسموحة فقط، تكرار، سياسة كلمة المرور، إنهاء جلسات المحذوف)', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const adminId = (await admin.get('/api/v2/users')).json.value.find((u) => u.username === 'admin').id;
    assert.equal((await admin.put('/api/v2/users/' + adminId, { displayName: 'x', role: 'auditor', perms: {} })).status, 403, 'إزالة آخر مدير');
    assert.equal((await admin.del('/api/v2/users/' + adminId)).status, 403, 'حذف النفس');
    const base = { displayName: 'p', password: 'Valid-Pass-2026', perms: { envelopes: true } };
    assert.equal((await admin.post('/api/v2/users', { ...base, username: 'weird', role: 'superuser' })).status, 400, 'دور غير معروف');
    assert.equal((await admin.post('/api/v2/users', { ...base, username: 'weak', role: 'auditor', password: '1234' })).status, 400, 'كلمة ضعيفة');
    assert.equal((await admin.post('/api/v2/users', { ...base, username: 'AUD', role: 'auditor' })).status, 409, 'تكرار بغير حساسية الحروف');
    assert.equal((await admin.post('/api/v2/users', { ...base, username: '../x', role: 'auditor' })).status, 400, 'اسم بحروف غير مسموحة');
    const p1 = await admin.post('/api/v2/users', { ...base, username: 'p1', role: 'auditor', perms: { envelopes: true, hacked: true, approve: 'yes' } });
    assert.equal(p1.status, 200);
    const row = (await admin.get('/api/v2/users')).json.value.find((u) => u.id === p1.json.id);
    assert.deepEqual(Object.keys(row.perms).sort(), require('../server/policy').PERM_KEYS.slice().sort(), 'صلاحيات خارج القائمة تُحذف');
    assert.ok(!('hacked' in row.perms));
    assert.equal(row.perms.approve, false, 'قيمة غير منطقية صحيحة لا تُقبل');
    // مدير ثانٍ: يمكن إزالته ثم يبقى مدير واحد
    const a2 = await admin.post('/api/v2/users', { ...base, username: 'admin2', role: 'admin', perms: {} });
    assert.equal(a2.status, 200);
    assert.equal((await admin.put('/api/v2/users/' + a2.json.id, { displayName: 'a2', role: 'auditor', perms: {} })).status, 200);
    // حذف مستخدم يُنهي جلساته فوراً
    const victim = await makeUser(admin, 'victim', { envelopes: true });
    const vc = await loggedIn(app, 'victim', victim.password);
    assert.equal((await vc.get('/api/v2/me')).status, 200);
    assert.equal((await admin.del('/api/v2/users/' + victim.id)).status, 200);
    assert.equal((await vc.get('/api/v2/me')).status, 401, 'جلسة المحذوف انتهت');
    assert.equal((await new Client(app).login('victim', victim.password)).status, 401);
    // تغيير كلمة مرور مستخدم بيد المدير يُنهي جلساته
    const v2 = await makeUser(admin, 'v2', { envelopes: true });
    const v2c = await loggedIn(app, 'v2', v2.password);
    assert.equal((await admin.post('/api/v2/users/' + v2.id + '/password', { password: 'Reset-By-Admin-26' })).status, 200);
    assert.equal((await v2c.get('/api/v2/me')).status, 401);
    // الصلاحيات تسري فوراً بلا إعادة دخول: ننزع صلاحية الأظرف من v2 وهو داخل
    const v2d = await loggedIn(app, 'v2', 'Reset-By-Admin-26');
    assert.equal((await v2d.get('/api/v2/col/envelopes')).status, 200);
    assert.equal((await admin.put('/api/v2/users/' + v2.id, { displayName: 'v2', role: 'auditor', perms: {} })).status, 200);
    assert.equal((await v2d.get('/api/v2/col/envelopes')).status, 403, 'سحب الصلاحية فوري');
  });
});

test('سياسة كلمة المرور على الخادم تطابق الواجهة (نفس الحالات ونفس قائمة الكلمات الشائعة)', () => {
  const dbjs = fs.readFileSync(path.join(H.ROOT, 'app', 'js', 'db.js'), 'utf8');
  const m = dbjs.match(/DB\.COMMON_PASSWORDS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, 'قائمة الواجهة غير موجودة');
  const clientList = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  assert.deepEqual([...policy.COMMON].sort(), clientList, 'قائمتا الكلمات الشائعة يجب أن تتطابقا');
  assert.match(dbjs, /DB\.PASSWORD_MIN = 8;/);
  assert.equal(policy.PASSWORD_MIN, 8);
  const bad = ['1234', '12345', '1234567', '12345678', '123456789012', 'abcdefgh', 'ABCDEFGHIJ', '11111111', 'abc12345', 'Abc12345', 'Password123', 'PASSWORD1', 'admin1234', 'Short1', '', null, undefined, 12345678, 'a'.repeat(129) + '1'];
  for (const p of bad) assert.ok(policy.passwordIssue(p), 'كان يجب رفض ' + JSON.stringify(p));
  const good = ['Egypt2026x', 'Mgr-Admin2026', 'abcd1234xyz', 'كلمة_سر_2026', 'مرور12345', 'a'.repeat(127) + '1', 'My pass 2026'];
  for (const p of good) assert.equal(policy.passwordIssue(p), '', 'كان يجب قبول ' + p);
});

/* ============ الأسرار (كتابة فقط) والوسطاء ============ */
test('الأسرار: مفاتيح الذكاء الاصطناعي تُكتب ولا تُقرأ، وتُستعمل من الخادم فقط (وتُحفظ عند تعديل غيرها)', async () => {
  const ai = await H.startMockAi();
  try {
    await withApp({ fixture: true, env: { EINVOICE_TEST_AI_BASE: `http://127.0.0.1:${ai.port}` } }, async (app) => {
      const admin = await loggedIn(app, 'admin', ADMIN_PW);
      const setU = await makeUser(admin, 'setu', { settings: true });
      const aud = await loggedIn(app, 'aud', AUD_PW);
      const setc = await loggedIn(app, 'setu', setU.password);
      assert.equal((await aud.put('/api/v2/col/settings', { value: { ai: { gemini: { key: 'STOLEN' } } } })).status, 403);
      const r = await setc.put('/api/v2/col/settings', { value: { ai: { gemini: { key: 'G-KEY-1' }, claude: { key: 'C-KEY-1' }, openai: { key: 'O-KEY-1' } } } });
      assert.equal(r.status, 200);
      const get = await setc.get('/api/v2/col/settings');
      assert.doesNotMatch(get.text, /G-KEY-1|C-KEY-1|O-KEY-1/);
      assert.deepEqual([get.json.value.ai.gemini.hasKey, get.json.value.ai.claude.hasKey, get.json.value.ai.openai.hasKey], [true, true, true]);

      // الاستخدام عبر الخادم: كل مزود يستلم مفتاحه من الخادم
      const call = (prov) => aud.post('/api/v2/ai/call', { provider: prov, system: 'sys', prompt: 'hi' });
      const g = await call('gemini'), c = await call('claude'), o = await call('openai');
      assert.deepEqual([g.json.ok, c.json.ok, o.json.ok], [true, true, true]);
      assert.equal(ai.state.calls.find((x) => x.gKey).gKey, 'G-KEY-1');
      assert.equal(ai.state.calls.find((x) => x.cKey).cKey, 'C-KEY-1');
      assert.equal(ai.state.calls.find((x) => x.oAuth).oAuth, 'Bearer O-KEY-1');
      assert.doesNotMatch([g.text, c.text, o.text, aud.seen.join('')].join('\n'), /G-KEY-1|C-KEY-1|O-KEY-1/, 'المفاتيح لا تصل المتصفح');

      // تعديل إعداد آخر لا يمسح المفتاح
      assert.equal((await setc.put('/api/v2/col/settings', { value: { whtRate: 2 } })).status, 200);
      ai.state.calls.length = 0;
      await call('gemini');
      assert.equal(ai.state.calls[0].gKey, 'G-KEY-1', 'المفتاح بقي بعد تعديل الإعدادات الأخرى');

      // clearKey يمسح، وبعده لا اتصال
      assert.equal((await setc.put('/api/v2/col/settings', { value: { ai: { gemini: { clearKey: true } } } })).status, 200);
      ai.state.calls.length = 0;
      const none = await call('gemini');
      assert.equal(none.json.ok, false);
      assert.match(none.json.message, /مفتاح/);
      assert.equal(ai.state.calls.length, 0, 'لا اتصال بلا مفتاح');

      // تحقق المدخلات
      for (const bad of [
        { provider: 'evil', system: 's', prompt: 'p' },
        { provider: 'gemini', model: '../../etc', system: 's', prompt: 'p' },
        { provider: 'claude', model: 'a b', system: 's', prompt: 'p' },
        { provider: 'claude', system: 's', prompt: 'p', images: [{ mime: 'image/svg+xml', data: 'AAAA' }] },
        { provider: 'claude', system: 's', prompt: 'p', images: Array.from({ length: 13 }, () => ({ mime: 'image/png', data: 'AAAA' })) },
        { provider: 'claude', system: 's', prompt: 'p', images: [{ mime: 'image/png', data: 'not base64!!' }] },
        { provider: 'claude', system: 5, prompt: 'p' },
      ]) assert.equal((await aud.post('/api/v2/ai/call', bad)).status, 400, JSON.stringify(bad).slice(0, 80));

      // إعدادات غير صالحة
      for (const bad of [{ whtRate: 500 }, { ai: { active: 'evil' } }, { ai: { gemini: { model: '../x' } } }, { eta: { env: 'http://evil.example' } }, { idleMinutes: 1 }, { categories: [{ id: 'a', name: 'x' }, { id: 'a', name: 'y' }] }]) {
        assert.equal((await setc.put('/api/v2/col/settings', { value: bad })).status, 400, JSON.stringify(bad));
      }
    });
  } finally { ai.close(); }
});

test('الأسرار: أخطاء المزود تعبر كما هي، وحد معدل الطلبات لكل جلسة', async () => {
  const ai = await H.startMockAi();
  try {
    await withApp({ fixture: true, env: { EINVOICE_TEST_AI_BASE: `http://127.0.0.1:${ai.port}` } }, async (app) => {
      const aud = await loggedIn(app, 'aud', AUD_PW);
      const err = await aud.post('/api/v2/ai/call', { provider: 'gemini', system: 's', prompt: 'FORCE-429' });
      assert.equal(err.status, 200);
      assert.equal(err.json.ok, false);
      assert.equal(err.json.status, 429, 'حالة المزود الحقيقية ليستعملها المتصفح في إعادة المحاولة');
      assert.match(err.json.message, /quota/);
      let limited = 0;
      for (let i = 0; i < 125; i++) if ((await aud.post('/api/v2/ai/call', { provider: 'gemini', system: 's', prompt: 'x' })).status === 429) limited++;
      assert.ok(limited >= 4, 'بعد 120 طلب في 10 دقائق يُرفض: ' + limited);
    });
  } finally { ai.close(); }
});

test('الضرائب: الاعتمادات من إعدادات الخادم فقط (لا تُقبل من الطلب)، والمسارات المسموحة فقط', async () => {
  const eta = await H.startMockEta();
  try {
    await withApp({ fixture: true, env: { EINVOICE_TEST_ETA_BASE: `http://127.0.0.1:${eta.port}` } }, async (app) => {
      const admin = await loggedIn(app, 'admin', ADMIN_PW);
      const aud = await loggedIn(app, 'aud', AUD_PW);
      const usr = await makeUser(admin, 'usr', { users: true });
      const usrc = await loggedIn(app, 'usr', usr.password);
      const save = await admin.put('/api/v2/col/settings', { value: { eta: { env: 'test', clientId: 'cid', clientSecret: 'good', receiverId: '123456789' } } });
      assert.equal(save.status, 200);
      assert.equal((await aud.get('/api/v2/eta/status')).json.ready, true);
      const search = { path: '/api/v1.0/documents/search', query: { issuerId: '444444444' } };
      const ok = await aud.post('/api/v2/eta', { ...search, clientId: 'attacker', clientSecret: 'x', env: 'prod' });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.status, 200);
      assert.ok(eta.state.tokenCalls.every((t) => t.id === 'cid' && t.secret === 'good'), 'استُعملت اعتمادات الخادم فقط، لا ما أرسله الطلب');
      assert.doesNotMatch(aud.seen.join(''), /good/, 'السر لا يصل المتصفح');
      assert.equal((await usrc.post('/api/v2/eta', search)).status, 403);
      for (const bad of ['/api/v1.0/documents/submit', '//evil.example.com/x', '/api/v1.0/documents/../../x/details', '/api/v1.0/documents/ABCDEFG/cancel']) {
        const r = await aud.post('/api/v2/eta', { path: bad, query: {} });
        assert.equal(r.json.ok, false, bad);
        assert.equal(r.json.status, 400, bad);
      }
      // الاختبار: للإعدادات فقط
      assert.equal((await aud.post('/api/v2/eta/test', {})).status, 403);
      assert.equal((await admin.post('/api/v2/eta/test', {})).json.ok, true);
      // سر خاطئ مخزّن: خطأ من الضرائب لا يختلط بخطأ الدخول (401 هنا ليس "سجّل الدخول")
      await admin.put('/api/v2/col/settings', { value: { eta: { clientSecret: 'bad-secret' } } });
      const bad = await aud.post('/api/v2/eta', search);
      assert.equal(bad.status, 200);
      assert.equal(bad.json.ok, false);
      assert.equal(bad.json.status, 401);
      assert.equal((await aud.get('/api/v2/me')).status, 200, 'الجلسة سليمة');
    });
  } finally { eta.close(); }
});

/* ============ الأظرف: قفل المعتمد وصلاحية الاعتماد ============ */
test('الأظرف: الاعتماد وإعادة الفتح بصلاحية "الاعتماد"، والمعتمد مقفول، وهوية المعتمِد من الخادم', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const apr = await makeUser(admin, 'apr', { envelopes: true, approve: true });
    const aprc = await loggedIn(app, 'apr', apr.password);
    const env = (await aud.get('/api/v2/col/envelopes')).json.value;
    const e1 = env.find((e) => e.id === 'e1');
    assert.equal(e1.status, 'draft');
    const put = (c, list) => c.put('/api/v2/col/envelopes', { value: list });
    const withE1 = (patch) => env.map((e) => (e.id === 'e1' ? { ...e, ...patch } : e));

    assert.equal((await put(aud, withE1({ status: 'approved', approvedBy: 'fake' }))).status, 403, 'المراجع لا يعتمد');
    assert.equal((await put(aud, withE1({ status: 'weird' }))).status, 400, 'حالة غير معروفة');
    assert.equal((await put(aud, [env[0], env[0]])).status, 400, 'معرّف مكرر');
    // حفظ عادي لمراجع (تعديل مسودة) ويُختم updatedBy
    assert.equal((await put(aud, withE1({ supplier: 'مورد معدّل', updatedBy: 'fake' }))).status, 200);
    let cur = (await admin.get('/api/v2/col/envelopes')).json.value.find((e) => e.id === 'e1');
    assert.equal(cur.supplier, 'مورد معدّل');
    assert.equal(cur.updatedBy, 'aud', 'الخادم يختم من عدّل بدل ما يرسله المتصفح');

    // الاعتماد: بصلاحية الاعتماد فقط، والهوية من الجلسة
    const approvedList = (await admin.get('/api/v2/col/envelopes')).json.value.map((e) => (e.id === 'e1' ? { ...e, status: 'approved', approvedBy: 'someone-else', approvedAt: '2000-01-01T00:00:00.000Z' } : e));
    assert.equal((await put(aprc, approvedList)).status, 200);
    cur = (await admin.get('/api/v2/col/envelopes')).json.value.find((e) => e.id === 'e1');
    assert.equal(cur.status, 'approved');
    assert.equal(cur.approvedBy, 'apr');
    assert.notEqual(cur.approvedAt, '2000-01-01T00:00:00.000Z');

    // المعتمد مقفول
    const list = (await admin.get('/api/v2/col/envelopes')).json.value;
    assert.equal((await put(aud, list.map((e) => (e.id === 'e1' ? { ...e, supplier: 'تعديل بعد الاعتماد' } : e)))).status, 403, 'تعديل المعتمد');
    assert.equal((await put(aud, list.map((e) => (e.id === 'e1' ? { ...e, approvedBy: 'aud' } : e)))).status, 403, 'تزوير المعتمِد');
    assert.equal((await put(aud, list)).status, 200, 'حفظ بلا تغيير مسموح');
    assert.equal((await put(aud, list.map((e) => (e.id === 'e1' ? { ...e, status: 'draft' } : e)))).status, 403, 'مراجع لا يعيد الفتح');
    assert.equal((await put(aud, list.filter((e) => e.id !== 'e1'))).status, 403, 'مراجع لا يحذف معتمداً');
    assert.equal((await put(aprc, list.filter((e) => e.id !== 'e1'))).status, 403, 'صاحب الاعتماد لا يحذف معتمداً (للمدير فقط)');

    // سجل النشاط يكتبه الخادم تلقائياً للاعتماد
    const act = (await admin.get('/api/v2/activity')).json.value;
    const ap = act.find((a) => a.action === 'اعتماد ظرف');
    assert.ok(ap && ap.username === 'apr', 'سجل اعتماد باسم المعتمِد الحقيقي');

    // إعادة الفتح بصلاحية الاعتماد
    assert.equal((await put(aprc, list.map((e) => (e.id === 'e1' ? { ...e, status: 'draft' } : e)))).status, 200);
    cur = (await admin.get('/api/v2/col/envelopes')).json.value.find((e) => e.id === 'e1');
    assert.equal(cur.status, 'draft');
    assert.equal(cur.reopenedBy, 'apr');
    assert.ok((await admin.get('/api/v2/activity')).json.value.some((a) => a.action === 'إعادة فتح ظرف معتمد'));

    // إنشاء ظرف جديد: لا يُنشأ معتمداً من غير صلاحية، والهوية تُختم
    const fresh = { id: 'e9', supplier: 'جديد', month: '2026-09', category: 'general', status: 'draft', invoices: [], createdBy: 'fake' };
    const base = (await admin.get('/api/v2/col/envelopes')).json.value;
    assert.equal((await put(aud, [...base, { ...fresh, status: 'approved' }])).status, 403);
    assert.equal((await put(aud, [...base, fresh])).status, 200);
    assert.equal((await admin.get('/api/v2/col/envelopes')).json.value.find((e) => e.id === 'e9').createdBy, 'aud');

    // المدير يحذف المعتمد
    assert.equal((await put(aprc, (await admin.get('/api/v2/col/envelopes')).json.value.map((e) => (e.id === 'e9' ? { ...e, status: 'approved' } : e)))).status, 200);
    const l2 = (await admin.get('/api/v2/col/envelopes')).json.value;
    assert.equal((await put(admin, l2.filter((e) => e.id !== 'e9'))).status, 200, 'المدير يحذف المعتمد');
    assert.ok((await admin.get('/api/v2/activity')).json.value.some((a) => a.action === 'حذف ظرف معتمد'));
  });
});

test('عروض الأسعار: صاحب "الاعتماد" يملأ ق.م الفارغة فقط ولا يغيّر أي شيء آخر', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const quo = await makeUser(admin, 'quo', { quotes: true });
    const apr = await makeUser(admin, 'apr', { envelopes: true, approve: true });
    const aprc = await loggedIn(app, 'apr', apr.password);
    const base = (await admin.get('/api/v2/col/quotes')).json.value;
    base[0].items = [{ id: 'i1', no: '1', name: 'صنف', spec: '', unit: 'عدد', price: 2.2, vat: null }, { id: 'i2', no: '2', name: 'صنف ٢', spec: '', unit: 'عدد', price: 5, vat: 14 }];
    assert.equal((await admin.put('/api/v2/col/quotes', { value: base })).status, 200);
    const mut = (fn) => { const c = structuredClone(base); fn(c); return c; };
    const put = (c, v) => c.put('/api/v2/col/quotes', { value: v });
    assert.equal((await put(aprc, mut((c) => { c[0].items[0].vat = 14; }))).status, 200, 'ملء ق.م الفارغة');
    const cur = (await admin.get('/api/v2/col/quotes')).json.value;
    assert.equal(cur[0].items[0].vat, 14);
    const cases = {
      'تغيير سعر': (c) => { c[0].items[0].price = 1; },
      'تغيير ق.م موجودة': (c) => { c[0].items[1].vat = 0; },
      'ق.م غير منطقية': (c) => { c[0].items[0].vat = 500; },
      'ق.م نص': (c) => { c[0].items[0].vat = '14'; },
      'تغيير الاسم مع ق.م': (c) => { c[0].items[0].name = 'x'; c[0].items[0].vat = 0; },
      'إضافة صنف': (c) => { c[0].items.push({ id: 'i3', name: 'z', price: 1, vat: 14 }); },
      'حذف صنف': (c) => { c[0].items.pop(); },
      'حذف عرض': (c) => { c.pop(); },
      'تغيير حالة العرض': (c) => { c[0].status = 'draft'; },
    };
    for (const [label, fn] of Object.entries(cases)) {
      assert.equal((await admin.put('/api/v2/col/quotes', { value: base })).status, 200); // نعيد i1 إلى ق.م فارغة قبل كل محاولة
      const attempt = structuredClone(base); fn(attempt);
      assert.equal((await put(aprc, attempt)).status, 403, label);
    }
    assert.equal((await put(aud, mut(() => {}))).status, 403, 'مراجع بلا اعتماد ولا عروض');
    assert.equal((await put(await loggedIn(app, 'quo', quo.password), mut((c) => { c[0].items[0].price = 3; }))).status, 200, 'صاحب العروض يعدّل كل شيء');
  });
});

test('سجل النشاط: سجل عنصر واحد لأصحاب الأظرف/العروض، والسجل الكامل لصلاحية المستخدمين', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const non = await makeUser(admin, 'non', {});
    const nonc = await loggedIn(app, 'non', non.password);
    await aud.post('/api/v2/activity', { section: 'envelopes', action: 'تجربة', target: { type: 'envelope', id: 'e1', label: 'ظرف' }, details: 'x' });
    await aud.post('/api/v2/activity', { section: 'envelopes', action: 'تجربة ٢', target: { type: 'envelope', id: 'e2', label: 'ظرف ٢' }, details: 'y' });
    const one = await aud.get('/api/v2/activity?target=e1');
    assert.equal(one.status, 200);
    assert.ok(one.json.value.length >= 1 && one.json.value.every((a) => a.targetId === 'e1'));
    assert.equal((await nonc.get('/api/v2/activity?target=e1')).status, 403);
    assert.equal((await aud.get('/api/v2/activity')).status, 403, 'السجل الكامل ما زال مقيّداً');
    assert.equal((await aud.get('/api/v2/me')).json.logId !== undefined, true);
  });
});

test('التزامن: رقم النسخة يمنع الكتابة فوق شغل أحدث (409)', async () => {
  await withApp({ fixture: true }, async (app) => {
    const a = await loggedIn(app, 'admin', ADMIN_PW);
    const b = await loggedIn(app, 'aud', AUD_PW);
    const first = await b.get('/api/v2/col/envelopes');
    const rev0 = first.json.rev;
    const list = first.json.value;
    assert.equal((await a.put('/api/v2/col/envelopes', { value: list }, { 'If-Match': `"${rev0}"` })).status, 200);
    const stale = await b.put('/api/v2/col/envelopes', { value: list }, { 'If-Match': `"${rev0}"` });
    assert.equal(stale.status, 409, 'نسخة قديمة');
    assert.ok(stale.json.rev > rev0);
    assert.equal((await b.put('/api/v2/col/envelopes', { value: list }, { 'If-Match': `"${stale.json.rev}"` })).status, 200);
  });
});

/* ============ سجل النشاط (لا يُزوَّر) والصور ============ */
test('سجل النشاط: الهوية والوقت من الجلسة، ولا تعديل ولا حذف، ويُقرأ بصلاحية المستخدمين فقط', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const forged = await aud.post('/api/v2/activity', { section: 'envelopes', action: 'تعديل الكمية المستلمة', target: { type: 'envelope', id: 'e1', label: 'ظرف' }, details: 'من 400 إلى 300', username: 'admin', userId: 'x', displayName: 'المدير', at: 1 });
    assert.equal(forged.status, 200);
    const entry = (await admin.get('/api/v2/activity')).json.value.find((a) => a.action === 'تعديل الكمية المستلمة');
    assert.equal(entry.username, 'aud', 'يتجاهل الهوية المرسلة');
    assert.notEqual(entry.userId, 'x');
    assert.ok(entry.at > Date.now() - 60000, 'الوقت من الخادم');
    for (const bad of [{ section: 'evil', action: 'x' }, { section: 'users', action: '' }, { section: 'users', action: 'x'.repeat(101) }, { section: 'users', action: 'x', details: 'y'.repeat(4001) }, { section: 'users', action: 'x', target: { type: 't', id: 'i', label: 'l'.repeat(301) } }]) {
      assert.equal((await aud.post('/api/v2/activity', bad)).status, 400, JSON.stringify(bad).slice(0, 60));
    }
    assert.equal((await aud.get('/api/v2/activity')).status, 403);
    for (const m of ['PUT', 'DELETE']) assert.ok([404, 405].includes((await aud.call(m, '/api/v2/activity', {})).status), m + ' غير مدعوم');
    assert.equal((await aud.del('/api/v2/activity/' + entry.id)).status, 404);
  });
});

test('صور عروض الأسعار: القراءة للجميع، والكتابة بصلاحية العروض، وتحقق من النوع والحجم والمسار', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const img = { mime: 'image/jpeg', data: Buffer.from('fake-jpeg-bytes').toString('base64') };
    assert.equal((await aud.put('/api/v2/img/q1/0', img)).status, 403, 'مراجع بلا صلاحية العروض');
    assert.equal((await admin.put('/api/v2/img/q1/0', img)).status, 200);
    const got = await aud.get('/api/v2/img/q1/0');
    assert.equal(got.status, 200);
    assert.deepEqual(got.json, img);
    assert.equal((await aud.get('/api/v2/img/q1/5')).status, 404);
    assert.equal((await admin.put('/api/v2/img/q1/1', { mime: 'image/svg+xml', data: 'AAAA' })).status, 400, 'SVG يُرفض');
    assert.equal((await admin.put('/api/v2/img/q1/1', { mime: 'image/png', data: 'x'.repeat(9 * 1024 * 1024) })).status, 400, 'حد الحجم');
    for (const p of ['/api/v2/img/..%2f..%2fx/0', '/api/v2/img/q1/abc', '/api/v2/img/q1/1000']) assert.equal((await admin.get(p)).status, 404, p);
    assert.equal((await aud.del('/api/v2/img/q1/0')).status, 403);
    assert.equal((await admin.del('/api/v2/img/q1/0')).status, 200);
    assert.equal((await aud.get('/api/v2/img/q1/0')).status, 404);
    // الصور مشفرة على القرص
    await admin.put('/api/v2/img/q1/2', img);
    assert.ok(!fs.readFileSync(app.mainFile, 'utf8').includes(img.data), 'الصورة غير مشفرة على القرص');
  });
});

/* ============ النسخ الاحتياطي والاسترجاع ============ */
test('النسخ الاحتياطي: التصدير بصلاحية المستخدمين، والاسترجاع للمدير فقط مع نسخة أمان وإنهاء كل الجلسات', async () => {
  await withApp({}, async (app) => {
    const admin = new Client(app);
    assert.equal((await admin.post('/api/v2/setup', { username: 'boss', displayName: 'Boss', password: 'Boss-Setup-2026' })).status, 200);
    await admin.put('/api/v2/col/quotes', { value: [{ id: 'qa', month: '2026-01', category: 'general', items: [] }] });
    const usr = await makeUser(admin, 'usr', { users: true });
    const usrc = await loggedIn(app, 'usr', usr.password);
    const bk = await usrc.get('/api/v2/backup');
    assert.equal(bk.status, 200);
    assert.equal(JSON.parse(bk.text).format, 'einvoice-validation-backup');

    // استرجاع ملف التجربة (له مدير آخر ومفتاح رئيسي مختلف)
    const fixtureText = fs.readFileSync(H.FIXTURE, 'utf8');
    assert.equal((await usrc.post('/api/v2/restore', fixtureText)).status, 403, 'غير المدير لا يسترجع');
    assert.equal((await admin.post('/api/v2/restore', '{"format":"einvoice-validation-backup","data":{"users":[]}}')).status, 400, 'ملف بلا مستخدمين');
    assert.equal((await admin.post('/api/v2/restore', fixtureText.replace('"wrap":{"salt"', '"wrap":{"x"'))).status, 400, 'ملف تالف');
    const before = fs.readFileSync(app.mainFile, 'utf8');
    const rs = await admin.post('/api/v2/restore', fixtureText);
    assert.equal(rs.status, 200);
    assert.equal(rs.json.needsLogin, true);
    assert.ok(rs.json.safetyCopy, 'نسخة أمان قبل الاستبدال');
    const safe = fs.readdirSync(path.join(app.dataDir, 'نسخ أمان'));
    assert.equal(safe.length, 1);
    const sc = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'نسخ أمان', safe[0]), 'utf8')), bf = JSON.parse(before);
    assert.deepEqual(sc.data.users, bf.data.users, 'نسخة الأمان تحمل مستخدمي ما قبل الاسترجاع');
    for (const k of ['c:settings', 'c:quotes', 'c:envelopes', 'c:profiles']) assert.deepEqual(sc.data[k], bf.data[k], 'نسخة الأمان: ' + k);
    assert.equal((await admin.get('/api/v2/me')).status, 401, 'كل الجلسات انتهت');
    assert.equal((await usrc.get('/api/v2/me')).status, 401);
    assert.equal((await new Client(app).login('boss', 'Boss-Setup-2026')).status, 401, 'المستخدمون القدامى انتهوا');
    const back = await loggedIn(app, 'admin', ADMIN_PW);
    assert.equal((await back.get('/api/v2/col/envelopes')).json.value[0].supplier, 'مورد-تجربة-سري');
    const log = (await back.get('/api/v2/auditlog')).json.value;
    assert.ok(log.some((e) => e.type === 'restore' && e.username === 'boss'), 'سُجّل من نفّذ الاسترجاع');
  });
});

/* ============ سلامة البيانات ============ */
test('سلامة البيانات: لا يُكتب فوق ملف تغيّر من خارج الخادم (خطأ فقد بيانات اكتُشف أثناء التطوير)', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    assert.equal((await admin.put('/api/v2/col/quotes', { value: [{ id: 'q1', items: [] }] })).status, 200);
    // الملف يتغيّر من خارج الخادم (نسخ يدوي أو برنامج آخر أو نسخة قديمة من البرنامج)
    const external = JSON.stringify({ ...JSON.parse(fs.readFileSync(H.FIXTURE, 'utf8')), exportedAt: '2001-01-01T00:00:00.000Z' });
    await sleep(30);
    fs.writeFileSync(app.mainFile, external);
    // أي طلب جديد أو قراءة قديمة: يجب ألا يُكتب فوق ما كُتب
    assert.equal((await admin.get('/api/v2/me')).status, 401, 'الجلسات انتهت لأن الملف تغيّر من خارج الخادم');
    assert.equal((await aud.get('/api/v2/me')).status, 401);
    const legacy = { text: fs.readFileSync(app.mainFile, 'utf8') };
    // الخادم قد يغلق جلسات السجل القديمة المفتوحة فقط؛ البيانات المشفرة والمستخدمون يجب أن تبقى كما كتبتها النسخة القديمة
    const same = (txt) => { const a = JSON.parse(txt).data, b = JSON.parse(external).data; for (const k of Object.keys(b)) if (k !== 'auditlog') assert.deepEqual(a[k], b[k], k); };
    same(legacy.text);
    await sleep(700); // لو بقي حفظ مؤجل في الذاكرة لا يجب أن يكتب حالة قديمة
    same(fs.readFileSync(app.mainFile, 'utf8'));
    assert.equal((await new Client(app).login('admin', ADMIN_PW)).status, 200, 'ويمكن الدخول والعمل من جديد على الملف الجديد');
  });
});

test('سلامة البيانات: ملف تالف لا يُكتب فوقه أبداً ولا يُنشأ إعداد جديد فوقه', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'einv-corrupt-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const bad = 'هذا ليس ملف بيانات {{{';
  fs.writeFileSync(path.join(dir, 'data', 'einvoice-data.einv'), bad);
  const app = await startApp({ dir });
  try {
    const c = new Client(app);
    const st = await c.get('/api/v2/status');
    assert.equal(st.json.needsSetup, false);
    assert.ok(st.json.corrupt);
    assert.equal((await c.post('/api/v2/setup', { username: 'admin', displayName: 'a', password: 'Good-Pass-2026' })).status, 503);
    assert.equal((await c.login('admin', 'Good-Pass-2026')).status, 503);
    await sleep(600);
    assert.equal(fs.readFileSync(app.mainFile, 'utf8'), bad, 'الملف التالف كما هو');
  } finally { app.cleanup(); }
});

test('الحماية القديمة باقية: كل نقاط /api/v2 تتطلب التوكن والترويسات مثل غيرها', async () => {
  await withApp({ fixture: true }, async (app) => {
    const raw = (p, headers) => H.request(app.port, 'GET', p, { headers });
    assert.equal((await raw('/api/v2/status', {})).status, 403, 'بدون توكن');
    assert.equal((await raw('/api/v2/status', { 'X-EInvoice-Token': app.token })).status, 403, 'بدون ترويسة التطبيق');
    assert.equal((await raw('/api/v2/status', { 'X-EInvoice-Token': app.token, 'X-EInvoice-App': '1', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await raw('/api/v2/status', { 'X-EInvoice-Token': app.token, 'X-EInvoice-App': '1' })).status, 200);
    assert.equal((await H.request(app.port, 'GET', '/server/api2.js', { headers: { 'X-EInvoice-Token': app.token } })).status, 404, 'كود الخادم لا يُقدَّم');
    assert.equal((await H.request(app.port, 'GET', '/tests/fixtures/v1-browser.einv', { headers: { 'X-EInvoice-Token': app.token } })).status, 404);
  });
});

/* ============ الضوابط الرقابية: الفصل بين المُعِد والمعتمِد، إقفال الفترة، متابعة الإشعار الدائن، النسخ لمكان ثانٍ ============ */
test('الفصل بين المُعِد والمعتمِد: من شارك في إعداد الظرف لا يعتمده، والقائمة يحددها الخادم', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const apr = await makeUser(admin, 'apr', { envelopes: true, approve: true });
    const aprc = await loggedIn(app, 'apr', apr.password);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const put = (c, list) => c.put('/api/v2/col/envelopes', { value: list });
    const get = async () => (await admin.get('/api/v2/col/envelopes')).json.value;
    assert.equal((await admin.put('/api/v2/col/settings', { value: { segregation: true } })).status, 200);
    assert.equal((await aud.get('/api/v2/col/settings')).json.value.segregation, true, 'الإعداد ظاهر لكل المستخدمين');
    let list = await get();
    assert.equal((await put(aprc, list.map((e) => (e.id === 'e1' ? { ...e, supplier: 'عدّله المعتمد' } : e)))).status, 200);
    list = await get();
    assert.ok(list.find((e) => e.id === 'e1').preparers.includes('apr'));
    const r = await put(aprc, list.map((e) => (e.id === 'e1' ? { ...e, status: 'approved' } : e)));
    assert.equal(r.status, 403);
    assert.match(r.json.message, /الفصل/);
    const forged = await put(aprc, list.map((e) => (e.id === 'e1' ? { ...e, preparers: [], status: 'approved' } : e)));
    assert.equal(forged.status, 403, 'الخادم يتجاهل preparers المرسلة');
    const apr2 = await makeUser(admin, 'apr2', { envelopes: true, approve: true });
    const apr2c = await loggedIn(app, 'apr2', apr2.password);
    assert.equal((await put(apr2c, (await get()).map((e) => (e.id === 'e1' ? { ...e, status: 'approved' } : e)))).status, 200);
    await admin.put('/api/v2/col/settings', { value: { segregation: false } });
    const l2 = await get();
    assert.equal((await put(apr2c, l2.map((e) => (e.id === 'e1' ? { ...e, status: 'draft' } : e)))).status, 200);
    assert.equal((await put(aprc, (await get()).map((e) => (e.id === 'e1' ? { ...e, status: 'approved' } : e)))).status, 200);
  });
});

test('إقفال الفترة: للمدير فقط، يمنع أي تعديل في أظرف وعروض الشهر، والفتح بسبب مكتوب ومسجل', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const set = await makeUser(admin, 'set', { settings: true, approve: true, envelopes: true });
    const setc = await loggedIn(app, 'set', set.password);
    const env = (await admin.get('/api/v2/col/envelopes')).json.value;
    const month = env[0].month;
    assert.equal((await setc.post('/api/v2/period', { month, action: 'close' })).status, 403, 'غير المدير لا يقفل');
    assert.equal((await admin.post('/api/v2/period', { month, action: 'close' })).status, 409, 'لا إقفال وفيه أظرف غير معتمدة');
    assert.equal((await admin.put('/api/v2/col/envelopes', { value: env.map((e) => ({ ...e, status: 'approved' })) })).status, 200);
    const closed = await admin.post('/api/v2/period', { month, action: 'close', reason: 'إقفال شهري' });
    assert.equal(closed.status, 200);
    assert.ok(closed.json.closedMonths.includes(month));
    await setc.put('/api/v2/col/settings', { value: { closedMonths: [] } });
    assert.ok((await aud.get('/api/v2/col/settings')).json.value.closedMonths.includes(month), 'الإقفال لا يُلغى من حفظ الإعدادات');
    const cur = (await admin.get('/api/v2/col/envelopes')).json.value;
    assert.equal((await setc.put('/api/v2/col/envelopes', { value: cur.map((e) => ({ ...e, status: 'draft' })) })).status, 403, 'لا إعادة فتح ظرف في شهر مقفل');
    assert.equal((await aud.put('/api/v2/col/envelopes', { value: [] })).status, 403, 'غير المدير لا يحذف ظرفاً في شهر مقفل');
    assert.equal((await aud.put('/api/v2/col/envelopes', { value: [...cur, { id: 'n1', supplier: 'x', month, category: 'general', status: 'draft', invoices: [] }] })).status, 403, 'لا ظرف جديد في شهر مقفل');
    const q = (await admin.get('/api/v2/col/quotes')).json.value;
    const quo = await makeUser(admin, 'quo', { quotes: true });
    const quoc = await loggedIn(app, 'quo', quo.password);
    if (q.some((x) => x.month === month)) assert.equal((await quoc.put('/api/v2/col/quotes', { value: q.map((x) => ({ ...x, title: 'تعديل' })) })).status, 403, 'عروض الشهر المقفل مقفولة لغير المدير');
    const withCn = cur.map((e) => ({ ...e, cn: { docs: [{ uuid: 'C1', internalId: 'CN-1', date: '2026-09-20', total: 50 }], paidAt: '2026-10-05' } }));
    assert.equal((await aud.put('/api/v2/col/envelopes', { value: withCn })).status, 200, 'متابعة الإشعار مسموحة رغم الإقفال');
    const after = (await admin.get('/api/v2/col/envelopes')).json.value[0];
    assert.equal(after.cn.updatedBy, 'aud');
    assert.equal(after.status, 'approved');
    assert.equal((await aud.put('/api/v2/col/envelopes', { value: withCn.map((e) => ({ ...e, cn: { docs: [{ total: -5 }] } })) })).status, 400, 'إشعار بقيمة سالبة');
    assert.equal((await admin.post('/api/v2/period', { month, action: 'open', reason: '' })).status, 400);
    assert.equal((await admin.post('/api/v2/period', { month, action: 'open', reason: 'تصحيح فاتورة مكررة' })).status, 200);
    const act = (await admin.get('/api/v2/activity')).json.value;
    assert.ok(act.some((a) => a.action === 'فتح فترة مقفلة' && a.details === 'تصحيح فاتورة مكررة'));
    assert.equal((await setc.put('/api/v2/col/envelopes', { value: (await admin.get('/api/v2/col/envelopes')).json.value.map((e) => ({ ...e, status: 'draft' })) })).status, 200, 'بعد الفتح يعود التعديل');
  });
});

test('النسخ لمكان ثانٍ: للمدير فقط، يكتب الملف والنسخة اليومية، والاختبار يتأكد أنها تُفك', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const target = path.join(app.dir, 'usb backup');
    assert.equal((await aud.put('/api/v2/mirror', { dir: target })).status, 403);
    assert.equal((await admin.put('/api/v2/mirror', { dir: 'relative/path' })).status, 400);
    assert.equal((await admin.put('/api/v2/mirror', { dir: path.join(app.dataDir, 'inside') })).status, 400, 'ليس داخل مجلد البيانات');
    assert.equal((await admin.put('/api/v2/mirror', { dir: target })).status, 200, 'مسار فيه مسافة مقبول');
    await admin.put('/api/v2/col/quotes', { value: (await admin.get('/api/v2/col/quotes')).json.value });
    const t = await admin.post('/api/v2/mirror/test', {});
    assert.equal(t.json.ok, true, JSON.stringify(t.json));
    assert.ok(fs.existsSync(path.join(target, 'einvoice-data.einv')));
    assert.ok(fs.readdirSync(path.join(target, 'نسخ يومية')).length >= 1);
    assert.ok(!fs.readFileSync(path.join(target, 'einvoice-data.einv'), 'utf8').includes('مورد-تجربة-سري'), 'النسخة مشفرة');
    assert.equal((await admin.get('/api/v2/mirror')).json.dir, target);
  });
});

test('المطاعم: قائمة في الإعدادات، ووسم الفاتورة بمطعم مسموح بعد الاعتماد وممنوع في شهر مقفل', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    assert.equal((await aud.put('/api/v2/col/settings', { value: { restaurants: [{ id: 'r1', name: 'فرع' }] } })).status, 403);
    assert.equal((await admin.put('/api/v2/col/settings', { value: { restaurants: [{ id: 'r1', name: 'فرع' }, { id: 'r2', name: 'فرع' }] } })).status, 400, 'اسم مكرر');
    assert.equal((await admin.put('/api/v2/col/settings', { value: { restaurants: [{ id: 'r1', name: 'فرع المعادي' }, { id: 'r2', name: 'فرع الزمالك' }] } })).status, 200);
    assert.equal((await aud.get('/api/v2/col/settings')).json.value.restaurants.length, 2, 'القائمة ظاهرة للجميع');
    const get = async () => (await admin.get('/api/v2/col/envelopes')).json.value;
    let list = await get();
    if (!list[0].invoices.length) list[0].invoices = [{ id: 'iv1', internalID: '1', lines: [] }];
    assert.equal((await admin.put('/api/v2/col/envelopes', { value: list.map((e) => ({ ...e, status: 'approved' })) })).status, 200);
    list = await get();
    const tagged = list.map((e) => ({ ...e, invoices: e.invoices.map((i) => ({ ...i, restaurantId: 'r1' })) }));
    assert.equal((await aud.put('/api/v2/col/envelopes', { value: tagged })).status, 200, 'الوسم مسموح بعد الاعتماد');
    assert.equal((await get())[0].invoices[0].restaurantId, 'r1');
    const sneaky = tagged.map((e) => ({ ...e, invoices: e.invoices.map((i) => ({ ...i, restaurantId: 'r2', internalID: 'مزوّر' })) }));
    assert.equal((await aud.put('/api/v2/col/envelopes', { value: sneaky })).status, 403, 'تعديل غير الوسم ممنوع بعد الاعتماد');
    assert.equal((await admin.post('/api/v2/period', { month: list[0].month, action: 'close' })).status, 200);
    const cur = await get();
    assert.equal((await aud.put('/api/v2/col/envelopes', { value: cur.map((e) => ({ ...e, invoices: e.invoices.map((i) => ({ ...i, restaurantId: 'r2' })) })) })).status, 403, 'الوسم ممنوع في شهر مقفل');
    assert.equal((await aud.put('/api/v2/col/envelopes', { value: cur.map((e) => ({ ...e, invoices: e.invoices.map((i) => { const x = { ...i }; return x; }), cn: { docs: [], paidAt: '2026-10-01' } })) })).status, 200, 'حفظ آخر في الشهر المقفل (متابعة الإشعار) لا يتعطل بسبب الوسم');
  });
});

test('المدير يتخطى كل القيود (شهر مقفل، ظرف معتمد، الفصل بين المُعِد والمعتمِد) وكل تخطٍّ يُسجل باسمه', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const get = async () => (await admin.get('/api/v2/col/envelopes')).json.value;
    await admin.put('/api/v2/col/settings', { value: { segregation: true } });
    let list = await get();
    // اعتماد ظرف شارك في إعداده
    assert.equal((await admin.put('/api/v2/col/envelopes', { value: list.map((e) => ({ ...e, supplier: 'عدّله المدير' })) })).status, 200);
    assert.equal((await admin.put('/api/v2/col/envelopes', { value: (await get()).map((e) => ({ ...e, status: 'approved' })) })).status, 200, 'المدير يتخطى الفصل');
    // تعديل محتوى ظرف معتمد مباشرة: يبقى معتمداً
    assert.equal((await admin.put('/api/v2/col/envelopes', { value: (await get()).map((e) => ({ ...e, supplier: 'تعديل بعد الاعتماد', approvedBy: 'مزوّر' })) })).status, 200);
    let e = (await get())[0];
    assert.equal(e.supplier, 'تعديل بعد الاعتماد');
    assert.equal(e.status, 'approved');
    assert.equal(e.approvedBy, 'admin', 'المعتمِد الأصلي محفوظ ولا يُزوّر');
    // شهر مقفل: تعديل وحذف وعروض أسعار
    assert.equal((await admin.post('/api/v2/period', { month: e.month, action: 'close', reason: '' })).status, 200);
    assert.equal((await admin.put('/api/v2/col/envelopes', { value: (await get()).map((x) => ({ ...x, supplier: 'في شهر مقفل' })) })).status, 200);
    const q = (await admin.get('/api/v2/col/quotes')).json.value;
    assert.equal((await admin.put('/api/v2/col/quotes', { value: q.map((x) => ({ ...x, title: 'تعديل المدير' })) })).status, 200);
    assert.equal((await admin.put('/api/v2/col/envelopes', { value: [] })).status, 200, 'المدير يحذف حتى من شهر مقفل');
    const act = (await admin.get('/api/v2/activity')).json.value.filter((a) => a.action === 'تخطٍّ بصلاحية المدير');
    for (const w of ['الفصل', 'ظرف معتمد', 'شهر مقفل', 'حذف ظرف']) assert.ok(act.some((a) => a.details.includes(w) && a.username === 'admin'), 'سُجل: ' + w);
    // غير المدير ما زال ممنوعاً
    const aud = await loggedIn(app, 'aud', AUD_PW);
    assert.equal((await aud.put('/api/v2/col/envelopes', { value: [{ id: 'z', supplier: 'x', month: e.month, category: 'general', status: 'draft', invoices: [] }] })).status, 403);
  });
});

test('الصلاحيات المفصّلة: كل بند بصلاحية منفصلة، والحسابات القديمة تحتفظ بما كانت تملكه', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const mk = async (name, perms) => { const u = await makeUser(admin, name, perms); return loggedIn(app, name, u.password); };
    const cnOnly = await mk('cnonly', { cn: true });
    const repOnly = await mk('reponly', { reports: true });
    const logOnly = await mk('logonly', { logs: true });
    const bakOnly = await mk('bakonly', { backup: true });
    const aiOnly = await mk('aionly', { settingsAi: true });
    const genOnly = await mk('genonly', { settingsGeneral: true });
    const envNoDel = await mk('envnodel', { envelopes: true, envDelete: false, cn: false, reports: false });
    const env = (await admin.get('/api/v2/col/envelopes')).json.value;
    // الإشعارات الدائنة فقط: يقرأ الأظرف ويعدّل متابعة الإشعار، ولا يعدّل المحتوى
    assert.equal((await cnOnly.get('/api/v2/col/envelopes')).status, 200);
    assert.equal((await cnOnly.put('/api/v2/col/envelopes', { value: env.map((e) => ({ ...e, cn: { docs: [], paidAt: '2026-10-01' } })) })).status, 200);
    assert.equal((await cnOnly.put('/api/v2/col/envelopes', { value: env.map((e) => ({ ...e, supplier: 'x' })) })).status, 403);
    // مراجعة الأظرف بدون الإشعارات الدائنة ولا الحذف
    const cur = (await admin.get('/api/v2/col/envelopes')).json.value;
    assert.equal((await envNoDel.put('/api/v2/col/envelopes', { value: cur.map((e) => ({ ...e, cn: { docs: [], paidAt: '2026-11-01' } })) })).status, 403, 'بدون صلاحية الإشعارات');
    assert.equal((await envNoDel.put('/api/v2/col/envelopes', { value: [] })).status, 403, 'بدون صلاحية الحذف');
    assert.equal((await envNoDel.put('/api/v2/col/envelopes', { value: cur.map((e) => ({ ...e, supplier: 'تعديل مسموح' })) })).status, 200);
    // التقارير فقط: قراءة بلا كتابة
    assert.equal((await repOnly.get('/api/v2/col/envelopes')).status, 200);
    assert.equal((await repOnly.put('/api/v2/col/envelopes', { value: cur })).status, 403);
    // السجلات والنسخ الاحتياطي منفصلة عن إدارة المستخدمين
    assert.equal((await logOnly.get('/api/v2/auditlog')).status, 200);
    assert.equal((await logOnly.get('/api/v2/users')).status, 403);
    assert.equal((await logOnly.get('/api/v2/backup')).status, 403);
    assert.equal((await bakOnly.get('/api/v2/backup')).status, 200);
    assert.equal((await bakOnly.get('/api/v2/activity')).status, 403);
    // الإعدادات: كل قسم بصلاحيته
    const sAi = (await aiOnly.get('/api/v2/col/settings')).json.value;
    assert.ok(sAi.ai && !sAi.eta, 'يرى قسم الذكاء الاصطناعي فقط');
    assert.equal((await aiOnly.put('/api/v2/col/settings', { value: { ai: { gemini: { key: 'K1' } } } })).status, 200);
    assert.equal((await aiOnly.put('/api/v2/col/settings', { value: { whtRate: 3 } })).status, 403, 'لا يعدّل العامة');
    assert.equal((await aiOnly.put('/api/v2/col/settings', { value: { eta: { clientSecret: 'X' } } })).status, 200, 'قسم الضرائب يُتجاهل بصمت');
    assert.equal((await admin.get('/api/v2/col/settings')).json.value.eta.hasSecret, true, 'السر القديم لم يتغير');
    assert.equal((await genOnly.put('/api/v2/col/settings', { value: { whtRate: 2, restaurants: [{ id: 'r1', name: 'فرع' }] } })).status, 200);
    assert.equal((await genOnly.post('/api/v2/eta/test', {})).status, 403);
    // حساب قديم بصلاحية "الإعدادات" يحتفظ بكل أقسامها
    const legacy = await mk('legacyset', { settings: true });
    const me = (await legacy.get('/api/v2/me')).json.user.perms;
    assert.ok(me.settingsAi && me.settingsEta && me.settingsGeneral && me.mappings && !me.users);
  });
});

test('سجل الموردين بنسبة خصم لكل مورد، ومخزن فواتير المنظومة بصلاحياته', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const rep = await makeUser(admin, 'rep', { reports: true });
    const repc = await loggedIn(app, 'rep', rep.password);
    assert.equal((await aud.put('/api/v2/col/settings', { value: { suppliers: [{ id: '222222222', name: 'x', whtRate: 3 }] } })).status, 403, 'بدون صلاحية الإعدادات العامة');
    for (const bad of [[{ id: '1', name: 'x', whtRate: 1 }], [{ id: '222222222', name: 'x', whtRate: 101 }], [{ id: '222222222', name: 'a' }, { id: '222222222', name: 'b' }], [{ id: '../x', name: 'x' }]]) {
      assert.equal((await admin.put('/api/v2/col/settings', { value: { suppliers: bad } })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await admin.put('/api/v2/col/settings', { value: { suppliers: [{ id: '222222222', name: 'مورد', whtRate: 3 }, { id: '333333333', name: 'معفى', whtRate: 0 }, { id: '444444444', name: 'عام', whtRate: null }] } })).status, 200);
    const s = (await aud.get('/api/v2/col/settings')).json.value;
    assert.deepEqual(s.suppliers.map((x) => x.whtRate), [3, 0, null], 'ظاهر للجميع، والصفر محفوظ');
    const docs = [{ uuid: 'U1', internalId: '1', issuerId: '222222222', issuerName: 'مورد', type: 'i', date: '2026-09-01', net: 100, vat: 14, total: 114, status: 'Valid' }];
    assert.equal((await repc.put('/api/v2/col/etadocs', { value: docs })).status, 403, 'التقارير قراءة فقط');
    assert.equal((await aud.put('/api/v2/col/etadocs', { value: docs })).status, 200);
    assert.equal((await repc.get('/api/v2/col/etadocs')).json.value.length, 1);
    assert.equal((await aud.put('/api/v2/col/etadocs', { value: [...docs, docs[0]] })).status, 400, 'مستند مكرر');
    assert.equal((await aud.put('/api/v2/col/etadocs', { value: [{ uuid: 'U2', net: 'abc' }] })).status, 400);
  });
});
