/* اختبار هجوم: نتصرف كمراجع عادي (صلاحية الأظرف فقط) ونحاول كل ما يخطر على بال مهاجم داخلي.
 * المطلوب: كل محاولة تُرفض، ولا يتسرب سر، ولا يتعطل الخادم. لا يلمس بيانات المستخدم (مجلدات مؤقتة). */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./helpers');
const { startApp, Client, loggedIn, makeUser, ADMIN_PW, AUD_PW, sleep } = H;

const SECRETS = ['SECRET-KEY-123', 'ETA-SECRET-XYZ'];

async function withApp(opts, fn) {
  const app = await startApp(opts);
  try { return await fn(app); } finally { app.cleanup(); }
}
const alive = async (app) => assert.equal((await new Client(app).get('/api/v2/status')).status, 200, 'الخادم ما زال يعمل');

test('هجوم: قراءة ملف البيانات أو الكود أو الأسرار مباشرة بأي مسار', async () => {
  await withApp({ fixture: true }, async (app) => {
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const paths = [
      '/api/data', '/einvoice-data.einv', '/data/einvoice-data.einv', '/' + encodeURIComponent('بيانات البرنامج') + '/einvoice-data.einv',
      '/server.js', '/server/api2.js', '/server/store.js', '/tests/fixtures/v1-browser.einv', '/tests/ui-tests.js', '/tests/ui-tests.html',
      '/.login-lock.json', '/access-token', '/config.json', '/APIs.txt', '/package.json',
      '/app/../server.js', '/app/%2e%2e/server.js', '/app/..%2fserver.js', '/app/%2e%2e%2f%2e%2e%2fserver.js', '/app/js/../../server.js', '/app//..//server.js',
      '/app/js/db.js%00.png', '/app\\..\\server.js', '/%2e%2e/%2e%2e/boot/hosts', '/%2e%2e/%2e%2e/etc/passwd',
    ];
    for (const p of paths) {
      let r;
      try { r = await aud.get(p); } catch (e) { continue; } // قطع الاتصال (مثلاً برنامج حماية على الجهاز يحجب نمط التسلل) = لم يصل الطلب لشيء
      assert.ok([301, 302, 400, 403, 404].includes(r.status), `${p} → ${r.status}`);
      assert.doesNotMatch(r.text, /createApi2|einvoice-validation-backup|"wrap"|SECRET-KEY|ETA-SECRET/, `${p} سرّب محتوى`);
    }
    await alive(app);
  });
});

test('هجوم: الأسرار لا تظهر في أي رد لأي مستخدم (حتى المراجع بعد أن حفظ المدير أسراراً)', async () => {
  await withApp({ fixture: true }, async (app) => {
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const gets = ['/api/v2/me', '/api/v2/status', '/api/v2/col/settings', '/api/v2/col/quotes', '/api/v2/col/envelopes', '/api/v2/col/mappings', '/api/v2/ai/status', '/api/v2/eta/status', '/api/v2/activity?target=e1', '/api/v2/img/q1/0', '/api/v2/users', '/api/v2/auditlog', '/api/v2/info', '/api/v2/backup', '/api/v2/activity'];
    for (const g of gets) { const r = await aud.get(g); assert.doesNotMatch(r.text, /SECRET-KEY-123|ETA-SECRET-XYZ|"wrap"|"salt"/, g + ' سرّب سراً'); }
    // حتى من أخطاء الطلبات
    const bad = await aud.post('/api/v2/ai/call', { provider: 'gemini', system: 's', prompt: 'p' });
    assert.doesNotMatch(aud.seen.join('\n'), /SECRET-KEY-123|ETA-SECRET-XYZ/);
    assert.ok(bad.status);
  });
});

test('هجوم: تجاوز الصلاحيات بحيل المسار والطريقة والرؤوس', async () => {
  await withApp({ fixture: true }, async (app) => {
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const denied = (r, label) => assert.ok([400, 403, 404, 405].includes(r.status), `${label} → ${r.status} ${r.text.slice(0, 80)}`);
    denied(await aud.get('/API/v2/users'), 'حروف كبيرة');
    denied(await aud.get('/api/v2//users'), 'شرطة مزدوجة');
    denied(await aud.get('/api/v2/users/'), 'شرطة أخيرة');
    denied(await aud.get('/api/v2/users?x=1#'), 'ذيل استعلام');
    denied(await aud.get('/api/v2/%75sers'), 'ترميز مئوي');
    denied(await aud.get('/api/v2/col/Settings/../users'), 'مسار نسبي');
    denied(await aud.get('/api/v2/auditlog/'), 'auditlog مع شرطة');
    denied(await aud.call('POST', '/api/v2/users', { username: 'x', password: 'Evil-Pass-2026', role: 'admin', perms: {} }, { 'X-HTTP-Method-Override': 'GET' }), 'method override');
    denied(await aud.call('GET', '/api/v2/users', undefined, { 'X-Forwarded-For': '127.0.0.1', 'X-Original-URL': '/api/v2/me', 'X-User': 'admin', 'X-Role': 'admin' }), 'رؤوس هوية مزوّرة');
    denied(await aud.get('/api/v2/users?role=admin&user=admin&perms=users'), 'معاملات استعلام');
    for (const m of ['TRACE', 'OPTIONS', 'PATCH', 'HEAD']) assert.ok([403, 404, 405, 400, 200].includes((await aud.call(m, '/api/v2/users')).status), m);
    const pol = await aud.call('GET', '/api/v2/users', undefined, { 'X-HTTP-Method-Override': 'PUT' });
    denied(pol, 'override GET');
    await alive(app);
  });
});

test('هجوم: كوكي الجلسة — تخمين، تكرار، حقن، وقيم مشوهة', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const evil = ['', 'admin', '0'.repeat(64), 'A'.repeat(64), 'ab'.repeat(500), '../../x', '%00', 'a b', '"quoted"', admin.sid.slice(0, 63), admin.sid.toUpperCase() === admin.sid ? 'x' : admin.sid.toUpperCase()];
    for (const v of evil) {
      const r = await new Client(app).call('GET', '/api/v2/me', undefined, { Cookie: 'einv_s=' + v });
      assert.equal(r.status, 401, 'قيمة ' + v.slice(0, 20));
    }
    // كوكيان بنفس الاسم: لا تصعيد (يُقبل واحد صالح أو يُرفض، لكن هوية المراجع لا تتحول لمدير)
    const dup = await new Client(app).call('GET', '/api/v2/me', undefined, { Cookie: `einv_s=${aud.sid}; einv_s=${'0'.repeat(64)}` });
    if (dup.status === 200) assert.equal(dup.json.user.username, 'aud');
    const dup2 = await new Client(app).call('GET', '/api/v2/me', undefined, { Cookie: `einv_s=${'0'.repeat(64)}; einv_s=${aud.sid}` });
    if (dup2.status === 200) assert.equal(dup2.json.user.username, 'aud');
    // جلسة المراجع لا تعطيه شيئاً من المدير
    assert.equal((await aud.get('/api/v2/me')).json.user.role, 'auditor');
    assert.equal((await aud.get('/api/v2/users')).status, 403);
  });
});

test('هجوم: Prototype Pollution وMass Assignment (حقول زائدة تغيّر الهوية أو الأدوار أو كلمة المرور)', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const users = (await admin.get('/api/v2/users')).json.value;
    const adminId = users.find((u) => u.username === 'admin').id;
    const audId = users.find((u) => u.username === 'aud').id;
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const raw = (m, p, body) => aud.call(m, p, body, { 'Content-Type': 'application/json' });
    // المراجع يحاول: __proto__ / constructor / حقول زائدة
    for (const body of [
      '{"displayName":"x","role":"auditor","perms":{"__proto__":{"users":true,"settings":true}}}',
      '{"displayName":"x","role":"auditor","perms":{"constructor":{"prototype":{"users":true}}}}',
      '{"__proto__":{"isAdmin":true,"role":"admin"},"displayName":"x","role":"auditor","perms":{}}',
      '{"displayName":"x","role":"auditor","perms":{},"id":"' + adminId + '","wrap":{"salt":"AA==","iter":1,"iv":"AA==","ct":"AA=="},"username":"admin"}',
    ]) await raw('PUT', '/api/v2/users/' + audId, body);
    await raw('PUT', '/api/v2/col/settings', '{"__proto__":{"isAdmin":true},"whtRate":1}');
    await raw('PUT', '/api/v2/col/envelopes', '{"value":[],"__proto__":{"admin":true}}');
    assert.equal(({}).isAdmin, undefined, 'خادم الاختبار لا يصيب هذا الاختبار، لكن نتأكد من الحالة');
    const me = (await aud.get('/api/v2/me')).json.user;
    assert.equal(me.role, 'auditor');
    // حساب قديم بصلاحية "الأظرف" = مراجعة الأظرف + حذف المسودات + الإشعارات الدائنة + التقارير، ولا شيء غيرها
    assert.deepEqual(Object.entries(me.perms).filter(([, v]) => v).map(([k]) => k).sort(), ['cn', 'envDelete', 'envelopes', 'reports'], 'صلاحيات المراجع لم تتغير');
    assert.equal((await aud.get('/api/v2/users')).status, 403);
    // المدير يرسل id/wrap زائدين عند إنشاء مستخدم: الخادم يولّد id ولا يقبل wrap من العميل
    const res = await admin.post('/api/v2/users', { id: adminId, wrap: { salt: 'AA==', iter: 1, iv: 'AA==', ct: 'AA==' }, username: 'newbie', displayName: 'n', password: 'Newbie-Pass-2026', role: 'auditor', perms: {} });
    assert.equal(res.status, 200);
    assert.notEqual(res.json.id, adminId);
    assert.equal((await new Client(app).login('admin', ADMIN_PW)).status, 200, 'كلمة مرور المدير سليمة');
    assert.equal((await new Client(app).login('newbie', 'Newbie-Pass-2026')).status, 200);
    // كلمة المرور القديمة للمراجع ما زالت تعمل (لم يُكتب wrap مزوّر)
    assert.equal((await new Client(app).login('aud', AUD_PW)).status, 200);
    await alive(app);
  });
});

test('هجوم: التخمين المتوازي لكلمة المرور (سباق) لا يتجاوز القفل', async () => {
  await withApp({ fixture: true }, async (app) => {
    const attempts = await Promise.all(Array.from({ length: 24 }, (_, i) => new Client(app).login('admin', 'Guess-' + i + '-xyz')));
    const ok = attempts.filter((r) => r.status === 200).length;
    const locked = attempts.filter((r) => r.status === 429).length;
    assert.equal(ok, 0);
    assert.ok(locked >= 20, 'الطلبات المتوازية بعد رابع خطأ يجب أن تُقفل، وجدنا المقفول: ' + locked + ' من 24');
    // الكلمة الصحيحة الآن مرفوضة لأن القفل فعلي
    assert.equal((await new Client(app).login('admin', ADMIN_PW)).status, 429, 'الصحيحة مرفوضة أثناء القفل');
    // محاولات بأسماء مختلفة (تخمين أسماء) تُحسب على نفس العداد
    const lockInfo = (await new Client(app).get('/api/v2/status')).json;
    assert.ok(lockInfo.lockedUntil > Date.now());
  });
});

test('هجوم: طلبات مشوهة وضخمة لا تُسقط الخادم ولا تكتب شيئاً', async () => {
  await withApp({ fixture: true }, async (app) => {
    const before = fs.readFileSync(app.mainFile, 'utf8');
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const anon = new Client(app);
    const deep = '['.repeat(200000) + ']'.repeat(200000);
    for (const [c, m, p, body] of [
      [anon, 'POST', '/api/v2/login', '{bad json'], [anon, 'POST', '/api/v2/login', deep], [anon, 'POST', '/api/v2/login', '[]'], [anon, 'POST', '/api/v2/login', 'null'],
      [anon, 'POST', '/api/v2/login', JSON.stringify({ username: 'a'.repeat(100000), password: 'x' })], [anon, 'POST', '/api/v2/login', JSON.stringify({ username: { $ne: null }, password: { $ne: null } })],
      [anon, 'POST', '/api/v2/login', JSON.stringify({ username: ['admin'], password: [ADMIN_PW] })],
      [aud, 'PUT', '/api/v2/col/envelopes', deep], [aud, 'PUT', '/api/v2/col/envelopes', '{"value":"x"}'], [aud, 'PUT', '/api/v2/col/envelopes', '{"value":[null]}'], [aud, 'PUT', '/api/v2/col/envelopes', '{"value":[{"id":1}]}'],
      [aud, 'POST', '/api/v2/activity', '{"section":["envelopes"],"action":{"a":1}}'], [aud, 'POST', '/api/v2/ai/call', '{"provider":"gemini","images":"x"}'], [aud, 'POST', '/api/v2/eta', '{"path":{"a":1},"query":"x"}'],
    ]) {
      let status, r;
      try { r = await c.call(m, p, body); status = r.status; } catch (e) { status = 'closed'; }
      // وسيط الضرائب يرد 200 بـ {ok:false,status:400} لمسار غير مسموح (شكل الرد المصمم)، وهذا رفض أيضاً
      const softReject = p === '/api/v2/eta' && status === 200 && r.json && r.json.ok === false && r.json.status === 400;
      assert.ok(softReject || status === 'closed' || (status >= 400 && status < 500), `${m} ${p} ${String(body).slice(0, 30)} → ${status}`);
    }
    // جسم أكبر من الحد: يُرفض أو تُغلق الجلسة، ولا يُكتب شيء
    let status; try { status = (await aud.put('/api/v2/col/settings', 'x'.repeat(2 * 1024 * 1024))).status; } catch (e) { status = 'closed'; }
    assert.ok(status === 'closed' || [400, 403, 413].includes(status), 'جسم كبير → ' + status);
    let st2; try { st2 = (await anon.post('/api/v2/login', 'y'.repeat(50 * 1024 * 1024))).status; } catch (e) { st2 = 'closed'; }
    assert.ok(st2 === 'closed' || [400, 413].includes(st2), 'login ضخم → ' + st2);
    await alive(app);
    assert.equal(JSON.parse(fs.readFileSync(app.mainFile, 'utf8')).data['c:envelopes'].ct, JSON.parse(before).data['c:envelopes'].ct, 'الأظرف لم تتغير');
  });
});

test('هجوم: CSRF — طلب من موقع آخر بكوكي الجلسة نفسه يُرفض', async () => {
  await withApp({ fixture: true }, async (app) => {
    const aud = await loggedIn(app, 'aud', AUD_PW);
    for (const h of [{ Origin: 'http://evil.example.com' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'null' }]) {
      const r = await aud.call('POST', '/api/v2/activity', { section: 'envelopes', action: 'csrf', details: '' }, h);
      assert.equal(r.status, 403, JSON.stringify(h));
    }
    // بدون ترويسة التطبيق (نموذج HTML عادي)
    const r = await H.request(app.port, 'POST', '/api/v2/activity', { headers: { Cookie: `einv=${app.token}; einv_s=${aud.sid}`, 'Content-Type': 'text/plain' }, body: '{"section":"envelopes","action":"csrf"}' });
    assert.equal(r.status, 403);
  });
});

test('هجوم: انتحال هوية في السجلات — اسم المستخدم المعروض والنص الحر لا يفلتان من الحدود', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    await aud.post('/api/v2/activity', { section: 'envelopes', action: 'اعتماد ظرف', target: { type: 'envelope', id: 'e1', label: 'x' }, details: 'المدير admin اعتمد\n\nuser=admin' });
    const mine = (await admin.get('/api/v2/activity')).json.value.filter((a) => a.details.includes('user=admin'));
    assert.equal(mine.length, 1);
    assert.equal(mine[0].username, 'aud', 'حتى لو النص يدّعي المدير فالمنفّذ الحقيقي aud');
    // اسم دخول مخادع عند إنشاء مستخدم (حروف تحكم/يشبه admin)
    for (const name of ['admin ', ' admin', 'Admin', 'аdmin', 'adm\u0000in', 'a\nb', '<script>x</script>']) {
      const r = await admin.post('/api/v2/users', { username: name, displayName: 'x', password: 'Spoof-Pass-2026', role: 'auditor', perms: {} });
      assert.ok([400, 409].includes(r.status) || r.status === 200, name);
      if (r.status === 200) {
        const row = (await admin.get('/api/v2/users')).json.value.find((u) => u.id === r.json.id);
        assert.ok(!/[\u0000-\u001f<>]/.test(row.username), 'اسم بحروف خطرة قُبل: ' + JSON.stringify(row.username));
      }
    }
  });
});
