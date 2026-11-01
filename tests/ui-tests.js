/* اختبارات الواجهة: تتحقق أن كود المتصفح الحقيقي (DB / AI / ETA / Settings / Activity / Quotes) يتعامل صح مع الخادم.
 * أما فرض الصلاحيات نفسه فمختبر بالتفصيل في tests/server-v2.test.js (هنا نتأكد أن الواجهة تعرض/تمرر النتائج صح).
 * ترتيب الاختبارات مهم (حالة الخادم تتراكم)، واختبار القفل آخرها. */
'use strict';

const results = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const assert = (c, msg) => { if (!c) throw new Error('فشل: ' + msg); };
const rejects = async (p, msgPart, label) => {
  try { await p; } catch (e) { if (msgPart) assert(String(e.message).includes(msgPart), `${label}: رسالة الرفض "${e.message}" لا تحتوي "${msgPart}"`); return e; }
  throw new Error('فشل: كان يجب أن يُرفض — ' + label);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ADMIN = 'Mgr-Admin2026', AUD = 'Audit-2222x';
const ids = {};
const loginAs = async (u, p) => { await DB.signOut(); const r = await DB.login(u, p); assert(r.ok, 'تسجيل الدخول بـ ' + u + ' ' + JSON.stringify(r)); };

test('F3: سياسة كلمة المرور في الواجهة (8 خانات + حرف + رقم + ليست شائعة)', async () => {
  const bad = ['1234', '12345', '1234567', '12345678', '123456789012', 'abcdefgh', 'ABCDEFGHIJ', '11111111', 'abc12345', 'Abc12345', 'Password123', 'PASSWORD1', 'admin1234', 'Short1', '', null, undefined, 12345678];
  for (const p of bad) assert(!DB.validPassword(p), 'كان يجب رفض: ' + JSON.stringify(p));
  const good = ['Egypt2026x', 'Mgr-Admin2026', 'abcd1234xyz', 'كلمة_سر_2026', 'مرور12345', 'My pass 2026'];
  for (const p of good) assert(DB.validPassword(p), 'كان يجب قبول: ' + p);
  assert(DB.passwordIssue('1234').includes('8') && DB.passwordIssue('abcdefgh').includes('حرف ورقم') && DB.passwordIssue('Password123').includes('شائعة'), 'رسائل السياسة');
});

test('F1: pdf.js المحلي (مع SRI وبدون eval) وSheetJS المحلي يعملان', async () => {
  assert(Object.values(Quotes.LIBS).every((l) => l.src.startsWith('app/vendor/') && /^sha384-/.test(l.integrity)), 'المكتبات محلية وبها SRI');
  // الصفحة تحت /tests/ والسياسة الأمنية تمنع <base>: نحوّل المسارات النسبية لمطلقة (المكتبات نفسها بنفس الملفات)
  for (const l of Object.values(Quotes.LIBS)) l.src = '/' + l.src;
  await Quotes.ensurePDF();
  assert(pdfjsLib.GlobalWorkerOptions.workerSrc.startsWith(location.origin), 'العامل من نفس الموقع');
  await Quotes.ensureXLSX();
  assert(window.XLSX && XLSX.version, 'SheetJS يعمل');
});

test('الحالة قبل الإعداد: needsSetup، ولا بيانات ولا استعادة جلسة', async () => {
  const st = await DB.status();
  assert(st.needsSetup === true, 'needsSetup');
  assert(await DB.resume() === false, 'لا جلسة');
  const e = await rejects(DB.call('GET', '/api/v2/col/quotes'), '', 'قراءة بلا دخول');
  assert(e.status === 401, 'بدون جلسة 401');
});

test('F3: الإعداد الأول يرفض كلمة ضعيفة (في الواجهة وعلى الخادم) ولا يُنشئ شيئاً', async () => {
  await rejects(DB.setup('admin', 'المدير', '1234'), '8', 'إعداد بـ 4 أرقام');
  await rejects(DB.setup('admin', 'المدير', 'abcdefgh'), 'حرف ورقم', 'إعداد بحروف فقط');
  const e = await rejects(DB.call('POST', '/api/v2/setup', { username: 'admin', displayName: 'x', password: '1234' }), '', 'الخادم يرفض الضعيفة حتى لو تجاوزت الواجهة');
  assert(e.status === 400, 'رفض من الخادم 400');
  assert((await DB.status()).needsSetup === true, 'لم يُنشأ مستخدم');
});

test('الإعداد الأول: ينشئ المدير ويدخل تلقائياً، وتبقى الجلسة بعد "إعادة تحميل" (resume)', async () => {
  await DB.setup('admin', 'المدير', ADMIN);
  assert(DB.user && DB.user.role === 'admin' && DB.can('users') && DB.can('approve'), 'مدير بكل الصلاحيات');
  assert(typeof DB.sessionId === 'string', 'رقم سجل الجلسة');
  DB.user = null; // محاكاة إعادة تحميل الصفحة: الكوكي فقط
  assert(await DB.resume() === true && DB.user.username === 'admin', 'استعادة الجلسة');
  const e = await rejects(DB.call('POST', '/api/v2/setup', { username: 'x', displayName: 'x', password: 'Good-Pass-2027' }), '', 'إعداد ثانٍ');
  assert(e.status === 409, 'لا إعداد ثانٍ');
  ids.admin = DB.user.id;
});

test('المستخدمون: إنشاء مراجع ومدير مستخدمين ومستخدم بلا صلاحيات، ورفض الضعيفة', async () => {
  await rejects(DB.addUser({ username: 'weak', displayName: 'w', password: '1234', role: 'auditor', perms: {} }), '8', 'ضعيفة');
  ids.aud = await DB.addUser({ username: 'aud', displayName: 'مراجع', password: AUD, role: 'auditor', perms: { envelopes: true } });
  ids.apr = await DB.addUser({ username: 'apr', displayName: 'معتمد', password: 'Appr-5555x', role: 'auditor', perms: { envelopes: true, approve: true } });
  ids.none = await DB.addUser({ username: 'none', displayName: 'بلا', password: 'None-4444x', role: 'auditor', perms: {} });
  const list = await DB.users();
  assert(list.length === 4 && list.every((u) => u.perms && !('wrap' in u)), 'القائمة بلا أسرار');
  const dup = await rejects(DB.addUser({ username: 'AUD', displayName: 'x', password: 'Good-Pass-2028', role: 'auditor', perms: {} }), 'موجود', 'اسم مكرر');
  assert(dup.status === 409, '409');
});

test('الصلاحيات تصل الواجهة كرسائل واضحة، و DB.can للعرض فقط', async () => {
  await loginAs('aud', AUD);
  assert(DB.can('envelopes') && !DB.can('users') && !DB.can('settings'), 'DB.can حسب الصلاحيات');
  await rejects(DB.users(), 'صلاحية', 'قائمة المستخدمين');
  await rejects(DB.updateUser(ids.aud, { displayName: 'x', role: 'admin', perms: {} }), 'صلاحية', 'ترقية النفس');
  await rejects(DB.addUser({ username: 'evil', displayName: 'e', password: 'Evil-Pass-2026', role: 'admin', perms: {} }), 'صلاحية', 'إضافة مدير');
  await rejects(DB.exportBackup(), 'صلاحية', 'تصدير نسخة');
  await rejects(DB.importBackup('{}'), 'للمدير فقط', 'استرجاع');
  await rejects(DB.save('settings', { whtRate: 5 }), 'صلاحية', 'حفظ الإعدادات');
  await rejects(DB.save('quotes', []), 'صلاحية', 'حفظ العروض');
  const ev = await rejects(DB.putImage('q1', 0, { mime: 'image/jpeg', data: 'AAAA' }), 'صلاحية', 'رفع صورة');
  assert(ev.status === 403, '403');
  assert(!(await DB.load('settings')).ai, 'من لا يملك الإعدادات لا يرى إعدادات الربط');
});

test('كلمة المرور: الاستبدال يحتاج القديمة، والواجهة تعكس ذلك', async () => {
  await loginAs('aud', AUD);
  await rejects(DB.setPassword(ids.aud, 'Brand-New-2026x', 'wrong-old'), 'غير صحيحة', 'قديمة خطأ');
  await rejects(DB.setPassword(ids.aud, '1234', AUD), '8', 'ضعيفة');
  await DB.setPassword(ids.aud, 'Brand-New-2026x', AUD);
  await DB.signOut();
  assert((await DB.login('aud', AUD)).ok === false, 'القديمة لا تعمل');
  assert((await DB.login('aud', 'Brand-New-2026x')).ok === true, 'الجديدة تعمل');
});

test('البيانات: حفظ وقراءة، وتعارض الكتابة (رقم النسخة) يظهر كخطأ واضح ويمسح الذاكرة المؤقتة', async () => {
  await loginAs('admin', ADMIN);
  await DB.save('quotes', [{ id: 'q1', month: '2026-09', category: 'general', status: 'draft', items: [{ id: 'i1', no: '1', name: 'صنف', spec: '', unit: 'عدد', price: 2.2, vat: null }] }]);
  DB.invalidate();
  assert((await DB.load('quotes', [])).length === 1, 'قراءة بعد الحفظ');
  const mine = await DB.load('quotes', []);
  // نافذة أخرى تعدّل نفس البيانات بينما أنا ممسك بنسخة قديمة
  const other = await DB.call('GET', '/api/v2/col/quotes');
  await DB.call('PUT', '/api/v2/col/quotes', { value: other.value }, { 'If-Match': `"${other.rev}"` });
  mine[0].items[0].price = 9;
  const e = await rejects(DB.save('quotes', mine), 'مستخدم آخر', 'تعارض');
  assert(e.code === 'conflict' && e.status === 409, 'رمز التعارض');
  assert(!('quotes' in DB._cache), 'الذاكرة المؤقتة مُسحت لتُقرأ من جديد');
  assert((await DB.load('quotes', []))[0].items[0].price === 2.2, 'لم يُكتب التعديل المتعارض');
  const fresh = await DB.load('quotes', []);
  fresh[0].items[0].price = 3;
  await DB.save('quotes', fresh);
  assert(DB.Save.error === '' && DB.Save.lastSaved, 'مؤشر الحفظ');
});

test('الأسرار: مفاتيح AI وClient Secret تُكتب ولا تعود للمتصفح أبداً (hasKey/hasSecret فقط)', async () => {
  const s = await DB.load('settings');
  assert(s.ai.gemini.hasKey === false, 'لا مفتاح بعد');
  s.ai.gemini = Object.assign({}, s.ai.gemini, { key: 'G-SECRET-KEY-1' });
  s.ai.claude = Object.assign({}, s.ai.claude, { key: 'C-SECRET-KEY-1' });
  s.eta = { env: 'test', clientId: 'cid', receiverId: '123456789', clientSecret: 'good' };
  await DB.saveSettings(s);
  const again = await DB.load('settings');
  const text = JSON.stringify(again);
  assert(!/G-SECRET-KEY-1|C-SECRET-KEY-1|"good"/.test(text), 'الأسرار ظهرت في الإعدادات: ' + text);
  assert(again.ai.gemini.hasKey && again.ai.claude.hasKey && again.eta.hasSecret && !again.ai.openai.hasKey, 'أعلام الحفظ');
  assert(again === s || !('key' in again.ai.gemini), 'كائن الشاشة نُظّف من السر بعد الحفظ');
  // تعديل إعداد آخر لا يمسح المفتاح
  again.whtRate = 2;
  await DB.saveSettings(again);
  assert((await DB.load('settings')).ai.gemini.hasKey, 'المفتاح بقي');
  const st = await AI.status();
  assert(st.providers.gemini.hasKey && !JSON.stringify(st).includes('SECRET'), 'حالة المزودين بلا مفاتيح');
  // الإعداد يعود لما كان
  again.whtRate = 1; await DB.saveSettings(again);
});

test('الذكاء الاصطناعي عبر الخادم: ينجح، ولا يصل المفتاح، وانتهاء الحصة يوقف النموذج ثم يُرفع بتغيير المفتاح', async () => {
  assert(await AI.ready(), 'AI.ready');
  assert(await AI.test({ provider: 'gemini', model: 'gemini-2.5-flash' }), 'اختبار الاتصال');
  const out = await AI.callJSON({ system: 's', prompt: 'hello' });
  assert(out.ok === true && out.from === 'gemini', 'رد المزود النشط');
  // إيقاف المزود الأول بسبب الحصة → تحويل تلقائي لمزود آخر له مفتاح
  const calls = [];
  const realOnce = AI._once;
  let n = 0;
  AI._once = async (c, a) => { calls.push(c.provider); if (c.provider === 'gemini') { n++; return realOnce(c, Object.assign({}, a, { prompt: 'FORCE-429' })); } return realOnce(c, a); };
  try {
    const r = await AI.callJSON({ system: 's', prompt: 'x' });
    assert(r.from === 'claude', 'تحوّل إلى claude: ' + JSON.stringify(r));
  } finally { AI._once = realOnce; }
  assert(calls[0] === 'gemini' && calls.includes('claude'), 'ترتيب المحاولات ' + calls);
  const cd = await AI.cooldowns();
  assert(cd.gemini && cd.gemini.until > Date.now(), 'سُجّل إيقاف gemini');
  await AI.clearCooldown('gemini');
  assert(!(await AI.cooldowns()).gemini, 'رُفع الإيقاف');
  // مزود بلا مفتاح
  const e = await rejects(AI.test({ provider: 'openai', model: 'gpt-4o' }), 'مفتاح', 'بلا مفتاح');
  assert(e, 'رسالة واضحة');
});

test('الضرائب عبر الخادم: الاعتمادات من الخادم، والسر لا يظهر، وأخطاء المنظومة تُترجم', async () => {
  assert(await ETA.ready(), 'ETA.ready');
  const cfg = await ETA.cfg();
  assert(cfg.hasSecret && cfg.clientId === 'cid' && !('clientSecret' in cfg), 'الإعدادات بلا السر');
  assert(await ETA.test(), 'اختبار الاتصال');
  const list = await ETA.searchReceived({ issuerId: '444444444', from: '2026-09-01', to: '2026-09-10', onlyValid: true });
  assert(list.length === 1 && list[0].uuid === 'U1', 'نتيجة البحث');
  // سر خاطئ → رسالة عربية واضحة
  const s = await DB.load('settings');
  s.eta = { env: 'test', clientId: 'cid', receiverId: '', clientSecret: 'bad-secret' };
  await DB.saveSettings(s);
  await rejects(ETA.test(), 'غير صحيحة', 'سر خاطئ');
  await rejects(ETA.searchReceived({ issuerId: '444444444', from: '2026-09-01', to: '2026-09-10', onlyValid: true }), 'غير صحيحة', 'بحث بسر خاطئ');
  assert(DB.user, 'خطأ الضرائب لا يُنهي الجلسة');
  s.eta = { env: 'test', clientId: 'cid', receiverId: '', clientSecret: 'good' };
  await DB.saveSettings(s);
});

test('الصور: رفع وقراءة وحذف صفحات عرض السعر (مشفرة عند الخادم)', async () => {
  const pages = [{ mime: 'image/jpeg', data: btoa('page-one-bytes') }, { mime: 'image/png', data: btoa('page-two-bytes') }];
  await Quotes.savePages('q1', pages);
  const p0 = await Quotes.loadPage('q1', 0), p1 = await Quotes.loadPage('q1', 1);
  assert(p0.data === pages[0].data && p1.mime === 'image/png', 'القراءة تطابق المرفوع');
  assert(await Quotes.loadPage('q1', 5) === null, 'صفحة غير موجودة = null');
  await Quotes.deletePages('q1', 2);
  assert(await Quotes.loadPage('q1', 0) === null, 'بعد الحذف');
});

test('سجل النشاط: الهوية من الجلسة لا من المتصفح، وسجل الظرف الواحد لصاحب الأظرف', async () => {
  await loginAs('aud', 'Brand-New-2026x');
  await Activity.add('envelopes', 'تعديل تجريبي', { type: 'envelope', id: 'e-test', label: 'ظرف تجريبي' }, 'تفاصيل');
  await DB.call('POST', '/api/v2/activity', { section: 'envelopes', action: 'محاولة تزوير', target: { type: 'envelope', id: 'e-test', label: 'ظ' }, details: '', username: 'admin', displayName: 'المدير' });
  const mine = (await DB.call('GET', '/api/v2/activity?target=e-test')).value;
  assert(mine.length === 2 && mine.every((a) => a.username === 'aud'), 'الهوية aud دائماً: ' + JSON.stringify(mine.map((a) => a.username)));
  await rejects(DB.call('GET', '/api/v2/activity'), 'صلاحية', 'السجل الكامل مقيّد');
  await loginAs('admin', ADMIN);
  const all = (await DB.call('GET', '/api/v2/activity')).value;
  assert(all.some((a) => a.action === 'إضافة مستخدم') && all.some((a) => a.action === 'تغيير كلمة المرور'), 'الخادم سجّل أحداث المستخدمين بنفسه');
  assert(all.some((a) => a.action === 'تغيير مفتاح gemini' || /مفتاح/.test(a.details)), 'الخادم سجّل تغيير المفاتيح');
  assert(!JSON.stringify(all).includes('SECRET'), 'السجل بلا أسرار');
});

test('سجل الدخول: يكتبه الخادم ويحتوي الجلسة الحالية (متصل الآن)', async () => {
  const log = await DB.readLog();
  const mine = log.find((e) => e.id === DB.sessionId);
  assert(mine && mine.type === 'session' && !mine.end && mine.username === 'admin', 'جلسة المدير الحالية');
  assert(log.some((e) => e.type === 'session' && e.username === 'aud' && e.end), 'جلسات مراجع منتهية');
});

test('النسخ الاحتياطي: تصدير مشفر، واسترجاع للمدير ينهي الجلسة ويعيد بيانات الملف', async () => {
  const blob = await DB.exportBackup();
  const text = await blob.text();
  const obj = JSON.parse(text);
  assert(obj.format === 'einvoice-validation-backup' && !text.includes('G-SECRET-KEY-1') && !text.includes('صنف'), 'مشفر بلا نصوص ظاهرة');
  // نعدّل بعد التصدير ثم نسترجع ويجب أن يرجع للحالة السابقة
  const q = await DB.load('quotes', []);
  q[0].items[0].price = 777;
  await DB.save('quotes', q);
  await DB.importBackup(text);
  assert(DB.user === null, 'خرجنا بعد الاسترجاع');
  await loginAs('admin', ADMIN);
  assert((await DB.load('quotes', []))[0].items[0].price === 3, 'عادت بيانات النسخة');
});

test('XSS: نصوص خبيثة في المورد والسجل تُعرض كنص ولا تُنفَّذ', async () => {
  const evil = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  const envs = await DB.load('envelopes', []);
  envs.push({ id: 'xss1', supplier: evil, month: '2026-09', category: 'general', status: 'draft', invoices: [], createdAt: new Date().toISOString() });
  await DB.save('envelopes', envs);
  await Activity.add('envelopes', evil, { type: 'envelope', id: 'xss1', label: evil }, evil);
  const box = document.createElement('div');
  document.body.append(box);
  box.append(await Envelopes.list());
  const rows = (await DB.call('GET', '/api/v2/activity?target=xss1')).value;
  box.append(Activity.table(rows, false));
  await sleep(300);
  assert(!box.querySelector('img, script, [onerror]'), 'ظهر عنصر خطر داخل الصفحة');
  assert(box.textContent.includes('<img src=x'), 'النص يظهر حرفياً');
  assert(window.__xss === undefined, 'نُفّذ كود من البيانات');
  box.remove();
});

test('انتهاء الجلسة على الخادم بعد الخمول: الواجهة تُبلَّغ مرة واحدة وتفقد المستخدم', async () => {
  let fired = 0;
  const real = DB.onExpired;
  DB.onExpired = () => { fired++; };
  try {
    DB.invalidate();
    await sleep(7500); // مهلة الخمول في خادم الاختبار 6 ثوانٍ
    const e = await rejects(DB.load('envelopes', []), 'انتهت الجلسة', 'قراءة بعد الانتهاء');
    assert(e.status === 401, '401');
    await rejects(DB.call('GET', '/api/v2/col/quotes'), '', 'طلب ثانٍ');
    await sleep(50);
    assert(fired === 1, 'onExpired مرة واحدة: ' + fired);
    assert(DB.user === null, 'المستخدم صُفّر');
  } finally { DB.onExpired = real; }
});

test('قفل الدخول: الواجهة تعرض المتبقي ثم الإيقاف، ولو الكلمة الصحيحة أثناء الإيقاف', async () => {
  const left = [];
  for (let i = 0; i < 3; i++) { const r = await DB.login('admin', 'Wrong-Pass-999'); assert(r.ok === false && r.left != null, 'محاولة خاطئة'); left.push(r.left); }
  assert(left.join() === '3,2,1', 'المتبقي ' + left);
  const locked = await DB.login('admin', 'Wrong-Pass-999');
  assert(locked.lockedUntil > Date.now(), 'الرابعة تقفل');
  const stillLocked = await DB.login('admin', ADMIN);
  assert(stillLocked.ok === false && stillLocked.lockedUntil > Date.now(), 'الصحيحة مرفوضة أثناء الإيقاف');
  assert((await DB.status()).lockedUntil > Date.now(), 'status يعرض الإيقاف (شاشة الدخول تظهر العدّاد حتى بعد إعادة التحميل)');
});

(async () => {
  const list = document.getElementById('list');
  for (const t of tests) {
    const li = document.createElement('li');
    try { await t.fn(); li.className = 'ok'; li.textContent = '✔ ' + t.name; results.push({ name: t.name, ok: true }); }
    catch (e) { li.className = 'bad'; li.textContent = '✖ ' + t.name + ' — ' + e.message; results.push({ name: t.name, ok: false, error: e.message }); }
    list.append(li);
  }
  const bad = results.filter((r) => !r.ok).length;
  document.getElementById('summary').textContent = bad ? `فشل ${bad} من ${results.length}` : `نجحت كل الاختبارات (${results.length})`;
  window.__results = results; window.__done = true;
})();
