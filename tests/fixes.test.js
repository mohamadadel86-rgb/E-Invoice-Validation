/* اختبارات إصلاحات مراجعة 2026-11-10 (الإصدار 2.6): كل اختبار يعيد المحاولة التي كانت تنجح قبل الإصلاح ويتأكد أنها تُرفض.
 * L1 تجميد الظرف المعتمد · L2 شروط الاعتماد على الخادم · L3 صيغة الشهر · L5 التقريب · S2 سجل النشاط · S3 الذكاء الاصطناعي
 * S5 سباقات الكتابة · S6 كلمة مرور النفس · S7 عنوان IP اختياري */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Calc = require('../app/js/calc');
const C = require('../server/cryptoutil');
const H = require('./helpers');
const { startApp, Client, loggedIn, makeUser, ADMIN_PW, AUD_PW } = H;

async function withApp(opts, fn) {
  const app = await startApp(opts);
  try { return await fn(app); } finally { app.cleanup(); }
}

const M = '2031-03';
const quote = (price) => ({ id: 'qfx', month: M, category: 'grocery', status: 'approved', from: M + '-01', to: M + '-31', items: [{ id: 'i1', no: '1', name: 'طماطم', unit: 'كجم', price, vat: 14 }] });
/* فاتورة ببند واحد: 10 كجم بسعر 12 والعرض 10 ⇒ إشعار دائن 20 + ق.م 2.8 = 22.8 */
const line = (patch) => Object.assign({ n: 1, description: 'طماطم', qty: 10, price: 12, netTotal: 120, vatRate: 14, vatAmount: 16.8, otherTaxes: 0, m: { itemId: 'i1', factor: 1 }, confirmed: true }, patch || {});
const envOf = (id, patch, linePatch, invPatch) => Object.assign({
  id, status: 'draft', month: M, category: 'grocery', supplier: 'مورد التجربة',
  invoices: [Object.assign({ id: id + '-v1', quoteId: 'qfx', internalID: '100', issuerId: '222222222', lines: [line(linePatch)] }, invPatch || {})],
}, patch || {});

const getEnvs = async (c) => (await c.get('/api/v2/col/envelopes')).json.value;
const putEnvs = (c, list) => c.put('/api/v2/col/envelopes', { value: list });
const withEnv = (list, e) => list.filter((x) => x.id !== e.id).concat([e]);

/* يعدّل ملف البيانات نفسه من خارج البرنامج (تنزيل النسخة ← فك التشفير ← تعديل ← استرجاع) لمحاكاة بيانات إصدار قديم */
async function rewriteData(admin, fn) {
  const obj = JSON.parse((await admin.get('/api/v2/backup')).text);
  const master = await C.unwrapMaster(ADMIN_PW, obj.data.users.find((u) => u.username === 'admin').wrap);
  const get = (name, def) => (obj.data['c:' + name] ? C.decryptJSON(master, obj.data['c:' + name]) : def);
  const set = (name, v) => { obj.data['c:' + name] = C.encryptJSON(master, v); };
  fn({ get, set });
  const r = await admin.post('/api/v2/restore', JSON.stringify(obj));
  assert.equal(r.status, 200, 'استرجاع الملف المعدّل: ' + r.text);
}

async function setup(app) {
  const admin = await loggedIn(app, 'admin', ADMIN_PW);
  const aud = await loggedIn(app, 'aud', AUD_PW);
  const apr = await makeUser(admin, 'apr', { envelopes: true, approve: true });
  const aprc = await loggedIn(app, 'apr', apr.password);
  const quotes = (await admin.get('/api/v2/col/quotes')).json.value;
  assert.equal((await admin.put('/api/v2/col/quotes', { value: quotes.concat([quote(10)]) })).status, 200);
  const settings = (await admin.get('/api/v2/col/settings')).json.value;
  return { admin, aud, apr, aprc, settings };
}

test('L5 التقريب: نصف القرش لأعلى دائماً، والظرف المعتمد قبل 2.6 يبقى بتقريبه القديم', () => {
  assert.equal(Calc.r2(15.79 * 36.5), 576.34);
  assert.equal(Calc.r2v1(15.79 * 36.5), 576.33, 'الطريقة القديمة كانت تنقص قرشاً');
  for (const [x, want] of [[2.135, 2.14], [4.015, 4.02], [1.005, 1.01], [-2.135, -2.14], [0, 0], [107.55000000000001, 107.55], [1234.565, 1234.57]]) assert.equal(Calc.r2(x), want, String(x));
  for (let k = 5; k < 200000; k += 10) assert.equal(Calc.r2(k / 1000), (Math.floor(k / 10) + 1) / 100, 'نصف: ' + k / 1000);
  // مجموع قيم مقرّبة أصلاً لا يتغير بين الطريقتين (الأظرف القديمة لا تتأثر في المجاميع)
  for (const x of [0.1 + 0.2, 99.99 + 0.01, 1140 + 570.5]) assert.equal(Calc.r2(x), Calc.r2v1(x));
  const item = { id: 'i1', name: 'ص', price: 36.5, vat: 0 };
  const l = { n: 1, qty: 15.79, price: 36.5, netTotal: 576.34, vatRate: 0, vatAmount: 0, otherTaxes: 0, m: { itemId: 'i1', factor: 1 }, confirmed: true, fz: item };
  const env = (extra) => Object.assign({ status: 'approved', frozenAt: 'x', whtRate: 0, invoices: [{ id: 'v', lines: [l] }] }, extra);
  const st = { whtRate: 0, suppliers: [] };
  assert.equal(Calc.calcEnvelope(env({ calcV: 2 }), {}, st).t.cnNet, 0, 'اعتماد جديد: لا فرق وهمي');
  assert.equal(Calc.calcEnvelope(env({}), {}, st).t.cnNet, 0.01, 'اعتماد قديم: نفس رقمه القديم بالضبط');
});

test('L1 الظرف المعتمد مجمَّد: تعديل عرض السعر أو حذفه لا يغيّر أرقامه، وحقول التجميد لا تُقبل من المتصفح', async () => {
  await withApp({ fixture: true }, async (app) => {
    const { admin, aud, aprc, settings } = await setup(app);
    // مسودة فيها حقول تجميد مزورة: تُحذف
    const forgedLine = { fz: { id: 'i1', name: 'طماطم', price: 999, vat: 0 } };
    let r = await putEnvs(aud, withEnv(await getEnvs(aud), envOf('x1', { frozenAt: '2020-01-01', calcV: 2, approvedTotals: { payable: 1 } }, forgedLine)));
    assert.equal(r.status, 200, r.text);
    let x1 = (await getEnvs(aud)).find((e) => e.id === 'x1');
    assert.equal(x1.frozenAt, undefined); assert.equal(x1.approvedTotals, undefined); assert.equal(x1.calcV, undefined);
    assert.equal(x1.invoices[0].lines[0].fz, undefined, 'نسخة الصنف المزورة لا تُحفظ على مسودة');

    // الاعتماد بنسخة صنف مزورة (سعر 999) ونسبة خصم مزورة: الخادم يجمّد من عرض السعر الحقيقي ويحسب بنفسه
    const list = await getEnvs(aprc);
    r = await putEnvs(aprc, list.map((e) => (e.id === 'x1' ? { ...e, status: 'approved', whtRate: 50, approvedTotals: { payable: 1 }, invoices: e.invoices.map((i) => ({ ...i, lines: i.lines.map((l) => ({ ...l, ...forgedLine })) })) } : e)));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.stamps.x1.fz['x1-v1']['1'].price, 10, 'الخادم يرجّع البنود التي جمّدها');
    x1 = (await getEnvs(admin)).find((e) => e.id === 'x1');
    assert.ok(x1.frozenAt); assert.equal(x1.calcV, 2);
    assert.equal(x1.invoices[0].lines[0].fz.price, 10, 'سعر العرض وقت الاعتماد');
    assert.equal(x1.whtRate, settings.whtRate, 'نسبة الخصم من إعدادات الخادم لا من المتصفح');
    assert.equal(x1.approvedTotals.cnTotal, 22.8);
    assert.equal(x1.approvedTotals.finalNet, 100);
    const totals = () => Calc.calcEnvelope(x1, {}, settings).t;
    assert.deepEqual(totals(), x1.approvedTotals);

    // تعديل سعر الصنف في العرض ثم حذف العرض كله: أرقام الظرف المعتمد كما هي
    const quotes = (await admin.get('/api/v2/col/quotes')).json.value;
    assert.equal((await admin.put('/api/v2/col/quotes', { value: quotes.map((q) => (q.id === 'qfx' ? quote(5) : q)) })).status, 200);
    x1 = (await getEnvs(admin)).find((e) => e.id === 'x1');
    assert.equal(Calc.calcEnvelope(x1, { qfx: quote(5) }, settings).t.cnTotal, 22.8, 'بعد تعديل السعر');
    assert.equal((await admin.put('/api/v2/col/quotes', { value: quotes.filter((q) => q.id !== 'qfx') })).status, 200);
    x1 = (await getEnvs(admin)).find((e) => e.id === 'x1');
    assert.equal(Calc.calcEnvelope(x1, {}, settings).t.cnTotal, 22.8, 'بعد حذف العرض');
    assert.equal(Calc.calcEnvelope(x1, {}, settings).t.pending, 0);

    // المعتمِد (غير المدير) لا يستطيع تغيير النسخة المجمدة ولا النسبة على ظرف معتمد
    r = await putEnvs(aprc, (await getEnvs(aprc)).map((e) => (e.id === 'x1' ? { ...e, whtRate: 0 } : e)));
    assert.equal(r.status, 403, 'تعديل ظرف معتمد');
    r = await putEnvs(aprc, (await getEnvs(aprc)).map((e) => (e.id === 'x1' ? { ...e, invoices: e.invoices.map((i) => ({ ...i, lines: i.lines.map((l) => ({ ...l, fz: { ...l.fz, price: 1 } })) })) } : e)));
    assert.equal(r.status, 200, 'تغيير fz وحده يُتجاهل (ليس محتوى)');
    assert.equal((await getEnvs(admin)).find((e) => e.id === 'x1').invoices[0].lines[0].fz.price, 10, 'النسخة المجمدة كما هي');

    // إعادة الفتح تفك التجميد؛ والعرض محذوف فالبند بلا صنف ⇒ لا يُعتمد من جديد
    r = await putEnvs(aprc, (await getEnvs(aprc)).map((e) => (e.id === 'x1' ? { ...e, status: 'draft' } : e)));
    assert.equal(r.status, 200);
    assert.equal(r.json.stamps.x1.fz['x1-v1']['1'], null);
    x1 = (await getEnvs(admin)).find((e) => e.id === 'x1');
    assert.equal(x1.frozenAt, undefined); assert.equal(x1.invoices[0].lines[0].fz, undefined);
    r = await putEnvs(aprc, (await getEnvs(aprc)).map((e) => (e.id === 'x1' ? { ...e, status: 'approved' } : e)));
    assert.equal(r.status, 400); assert.equal(r.json.error, 'pending');
  });
});

test('L1 المدير يعدّل ظرفاً معتمداً: يبقى مجمداً، والبند الذي لم يتغير ربطه يحتفظ بسعره وقت الاعتماد', async () => {
  await withApp({ fixture: true }, async (app) => {
    const { admin, aud, aprc } = await setup(app);
    assert.equal((await putEnvs(aud, withEnv(await getEnvs(aud), envOf('x2')))).status, 200);
    assert.equal((await putEnvs(aprc, (await getEnvs(aprc)).map((e) => (e.id === 'x2' ? { ...e, status: 'approved' } : e)))).status, 200);
    const quotes = (await admin.get('/api/v2/col/quotes')).json.value;
    assert.equal((await admin.put('/api/v2/col/quotes', { value: quotes.map((q) => (q.id === 'qfx' ? quote(5) : q)) })).status, 200);
    // المدير يغيّر الكمية المستلمة فقط (نفس الربط) ويحاول تغيير النسبة
    const r = await putEnvs(admin, (await getEnvs(admin)).map((e) => (e.id === 'x2' ? { ...e, whtRate: 77, invoices: e.invoices.map((i) => ({ ...i, lines: i.lines.map((l) => ({ ...l, received: 8 })) })) } : e)));
    assert.equal(r.status, 200, r.text);
    const x2 = (await getEnvs(admin)).find((e) => e.id === 'x2');
    assert.equal(x2.status, 'approved');
    assert.equal(x2.invoices[0].lines[0].fz.price, 10, 'ما زال سعر وقت الاعتماد وليس 5');
    assert.notEqual(x2.whtRate, 77);
    assert.equal(x2.approvedTotals.finalNet, 80, 'الخادم أعاد حساب الإجماليات: 8 × 10');
    assert.ok((await admin.get('/api/v2/activity')).json.value.some((a) => a.action === 'تخطٍّ بصلاحية المدير' && a.targetId === 'x2' && a.src === 'server'));
  });
});

test('L2 شروط الاعتماد على الخادم: بند معلّق أو رقم غير صالح يرفض الاعتماد حتى للمدير', async () => {
  await withApp({ fixture: true }, async (app) => {
    const { admin, aud, aprc } = await setup(app);
    const cases = [
      ['ربط غير مؤكد', { confirmed: false }, 'pending'],
      ['بلا ربط', { m: null }, 'pending'],
      ['صنف غير موجود بالعرض', { m: { itemId: 'nope', factor: 1 } }, 'pending'],
      ['سعر ليس رقماً', { price: 'abc' }, 'bad-request'],
      ['صافي ناقص', { netTotal: undefined }, 'bad-request'],
    ];
    for (const [name, patch, code] of cases) {
      assert.equal((await putEnvs(aud, withEnv(await getEnvs(aud), envOf('p1', {}, patch)))).status, 200, name);
      for (const c of [aprc, admin]) {
        const r = await putEnvs(c, (await getEnvs(c)).map((e) => (e.id === 'p1' ? { ...e, status: 'approved' } : e)));
        assert.equal(r.status, 400, `${name}: ${r.text}`);
        assert.equal(r.json.error, code, name);
      }
      // إنشاء ظرف معتمد مباشرة يمر بنفس الفحص
      const direct = await putEnvs(admin, withEnv(await getEnvs(admin), envOf('p2', { status: 'approved' }, patch)));
      assert.equal(direct.status, 400, name + ' (إنشاء معتمد مباشرة)');
    }
    assert.equal((await getEnvs(admin)).find((e) => e.id === 'p1').status, 'draft');
    // بند مرفوض، أو مقبول بدون عرض سعر، أو باعتماد يدوي: ليس معلّقاً
    for (const patch of [{ m: null, rejected: true }, { m: null, noQuoteAccepted: true }, { m: null, manualApproval: { price: 11 } }]) {
      assert.equal((await putEnvs(aud, withEnv(await getEnvs(aud), envOf('p1', {}, patch)))).status, 200);
      const r = await putEnvs(aprc, (await getEnvs(aprc)).map((e) => (e.id === 'p1' ? { ...e, status: 'approved' } : e)));
      assert.equal(r.status, 200, JSON.stringify(patch) + r.text);
      assert.equal((await putEnvs(aprc, (await getEnvs(aprc)).map((e) => (e.id === 'p1' ? { ...e, status: 'draft' } : e)))).status, 200);
    }
  });
});

test('L2 الخادم يفحص الفواتير على المنظومة بنفسه عند الاعتماد، ولا يثق بالحالة التي يرسلها المتصفح', async () => {
  const eta = await H.startMockEta();
  try {
    await withApp({ fixture: true, env: { EINVOICE_TEST_ETA_BASE: `http://127.0.0.1:${eta.port}` } }, async (app) => {
      const { admin, aud, aprc } = await setup(app);
      assert.equal((await admin.put('/api/v2/col/settings', { value: { eta: { env: 'test', clientId: 'cid', clientSecret: 'good', receiverId: '123456789' } } })).status, 200);
      eta.state.docs = {
        UUIDOK01: { status: 'Valid', receiverId: '123456789' },
        UUIDBAD1: { status: 'Cancelled', receiverId: '123456789' },
        UUIDOTH1: { status: 'Valid', receiverId: '999999999' },
      };
      const approve = async (c, id) => putEnvs(c, (await getEnvs(c)).map((e) => (e.id === id ? { ...e, status: 'approved' } : e)));
      // فاتورة ملغاة على المنظومة والمتصفح يدّعي أنها صالحة
      assert.equal((await putEnvs(aud, withEnv(await getEnvs(aud), envOf('t1', {}, {}, { uuid: 'UUIDBAD1', status: 'Valid', receiverId: '123456789' })))).status, 200);
      let r = await approve(aprc, 't1');
      assert.equal(r.status, 403, r.text);
      assert.match(r.json.message, /Cancelled/);
      assert.ok(eta.state.detailCalls.includes('UUIDBAD1'), 'الخادم سأل المنظومة بنفسه');
      assert.equal((await getEnvs(admin)).find((e) => e.id === 't1').status, 'draft');
      // المدير يتخطى، والخادم يسجل التخطي ويحفظ الحالة الحقيقية
      r = await approve(admin, 't1');
      assert.equal(r.status, 200, r.text);
      const t1 = (await getEnvs(admin)).find((e) => e.id === 't1');
      assert.equal(t1.invoices[0].status, 'Cancelled');
      assert.ok((await admin.get('/api/v2/activity')).json.value.some((a) => a.action === 'تخطٍّ بصلاحية المدير' && a.targetId === 't1' && /اعتماد رغم/.test(a.details) && a.src === 'server'));
      // فاتورة صادرة لرقم ضريبي آخر
      assert.equal((await putEnvs(aud, withEnv(await getEnvs(aud), envOf('t2', {}, {}, { uuid: 'UUIDOTH1', receiverId: '123456789' })))).status, 200);
      r = await approve(aprc, 't2');
      assert.equal(r.status, 403); assert.match(r.json.message, /999999999/);
      // فاتورة صالحة: تُعتمد وتُختم بنتيجة فحص الخادم
      assert.equal((await putEnvs(aud, withEnv(await getEnvs(aud), envOf('t3', { etaCheck: { checked: 99, skipped: 0 } }, {}, { uuid: 'UUIDOK01' })))).status, 200);
      r = await approve(aprc, 't3');
      assert.equal(r.status, 200, r.text);
      const t3 = (await getEnvs(admin)).find((e) => e.id === 't3');
      assert.deepEqual([t3.etaCheck.checked, t3.etaCheck.skipped], [1, 0], 'عدّاد الفحص من الخادم لا من المتصفح');
      assert.ok(t3.invoices[0].etaCheckedAt);
      // مستند غير موجود على المنظومة أو بلا UUID: لم يُتحقق منه (يُسجل كذلك) ولا يمنع الاعتماد، كما في الواجهة
      assert.equal((await putEnvs(aud, withEnv(await getEnvs(aud), envOf('t4', {}, {}, { uuid: 'UUIDNONE' })))).status, 200);
      r = await approve(aprc, 't4');
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([(await getEnvs(admin)).find((e) => e.id === 't4').etaCheck.checked, (await getEnvs(admin)).find((e) => e.id === 't4').etaCheck.skipped], [0, 1]);
      // ما تحققت منه الواجهة عبر الوسيط للتو لا يسأل عنه الخادم مرة ثانية
      const before = eta.state.detailCalls.length;
      assert.equal((await aud.post('/api/v2/eta', { path: '/api/v1.0/documents/UUIDOK01/details', query: {} })).status, 200);
      assert.equal((await putEnvs(aud, withEnv(await getEnvs(aud), envOf('t5', {}, {}, { uuid: 'UUIDOK01' })))).status, 200);
      assert.equal((await approve(aprc, 't5')).status, 200);
      assert.equal(eta.state.detailCalls.length, before + 1, 'طلب واحد فقط (طلب الواجهة)');
    });
  } finally { eta.close(); }
});

test('L3 صيغة شهر الظرف تُفحص: لا يفلت ظرف من إقفال الفترة بصيغة مثل 2031-4', async () => {
  await withApp({ fixture: true }, async (app) => {
    const { admin, aud } = await setup(app);
    assert.equal((await admin.post('/api/v2/period', { month: '2031-04', action: 'close' })).status, 200);
    const list = await getEnvs(aud);
    for (const m of ['2031-4', ' 2031-04', '2031-04 ', '2031/04', '', null, 202104]) {
      assert.equal((await putEnvs(aud, withEnv(list, envOf('m1', { month: m })))).status, 400, 'شهر ' + JSON.stringify(m));
    }
    assert.equal((await putEnvs(aud, withEnv(list, envOf('m1', { month: '2031-04' })))).status, 403, 'الشهر مقفل');
    assert.equal((await putEnvs(aud, withEnv(list, envOf('m1', { month: '2031-05' })))).status, 200);
    // تغيير شهر ظرف موجود لصيغة غير صالحة
    assert.equal((await putEnvs(aud, (await getEnvs(aud)).map((e) => (e.id === 'm1' ? { ...e, month: '2031-4' } : e)))).status, 400);
    assert.ok(!(await getEnvs(admin)).some((e) => e.month === '2031-4'));
  });
});

test('ترقية: الأظرف المعتمدة قبل 2.6 تُجمَّد بأرقامها عند أول دخول، مرة واحدة، وبتقريبها القديم', async () => {
  await withApp({ fixture: true }, async (app) => {
    const { admin, aud, aprc, settings } = await setup(app);
    assert.equal((await putEnvs(aud, withEnv(await getEnvs(aud), envOf('g1')))).status, 200);
    assert.equal((await putEnvs(aprc, (await getEnvs(aprc)).map((e) => (e.id === 'g1' ? { ...e, status: 'approved' } : e)))).status, 200);
    // نرجّع الظرف لشكل الإصدار القديم: معتمد بلا تجميد ولا نسبة محفوظة
    await rewriteData(admin, ({ get, set }) => {
      set('envelopes', get('envelopes', []).map((e) => {
        if (e.id !== 'g1') return e;
        const c = { ...e, invoices: e.invoices.map((i) => ({ ...i, lines: i.lines.map((l) => { const x = { ...l }; delete x.fz; return x; }) })) };
        for (const k of ['frozenAt', 'calcV', 'approvedTotals', 'whtRate']) delete c[k];
        return c;
      }));
    });
    const a2 = await loggedIn(app, 'admin', ADMIN_PW);
    let g1 = (await getEnvs(a2)).find((e) => e.id === 'g1');
    assert.ok(g1.frozenAt, 'تجمّد عند الدخول');
    assert.equal(g1.calcV, undefined, 'يبقى بالتقريب القديم');
    assert.equal(g1.invoices[0].lines[0].fz.price, 10);
    assert.equal(g1.whtRate, settings.whtRate);
    assert.equal(g1.approvedTotals.cnTotal, 22.8);
    const frozenAt = g1.frozenAt;
    const count = async () => (await a2.get('/api/v2/activity')).json.value.filter((a) => a.action === 'ترقية: تثبيت أرقام الأظرف المعتمدة').length;
    assert.equal(await count(), 1);
    // تعديل العرض بعد الترقية لا يغيّر الظرف، والدخول مرة ثانية لا يعيد التجميد
    const quotes = (await a2.get('/api/v2/col/quotes')).json.value;
    assert.equal((await a2.put('/api/v2/col/quotes', { value: quotes.map((q) => (q.id === 'qfx' ? quote(3) : q)) })).status, 200);
    const a3 = await loggedIn(app, 'admin', ADMIN_PW);
    g1 = (await getEnvs(a3)).find((e) => e.id === 'g1');
    assert.equal(g1.frozenAt, frozenAt); assert.equal(g1.invoices[0].lines[0].fz.price, 10);
    assert.equal(await count(), 1);
  });
});

test('S2 سجل النشاط: سجل هدف واحد للأظرف والعروض فقط، ومصدر كل حدث معلَّم، والأقدم يُؤرشف ولا يُحذف', async () => {
  await withApp({ fixture: true }, async (app) => {
    const { admin, aud, apr } = await setup(app);
    // إضافة المستخدم apr سجّلها الخادم على معرّف المستخدم: المدير يراها، وصاحب صلاحية الأظرف لا
    assert.ok((await admin.get('/api/v2/activity?target=' + apr.id)).json.value.length >= 1);
    const leak = await aud.get('/api/v2/activity?target=' + apr.id);
    assert.equal(leak.status, 200); assert.deepEqual(leak.json.value, [], 'سجل المستخدمين لا يُقرأ بصلاحية الأظرف');
    assert.deepEqual((await aud.get('/api/v2/activity?target=settings')).json.value, []);
    // حدث من الواجهة يقلّد اسم حدث للخادم: يُعلَّم أنه من الواجهة
    await aud.post('/api/v2/activity', { section: 'settings', action: 'إقفال فترة', target: { type: 'envelope', id: 'e-x', label: 'ظ' }, details: 'تقليد' });
    const all = (await admin.get('/api/v2/activity')).json.value;
    assert.equal(all.find((a) => a.details === 'تقليد').src, 'client');
    assert.equal(all.find((a) => a.action === 'إضافة مستخدم').src, 'server');
    assert.equal((await aud.get('/api/v2/activity?target=e-x')).json.value.length, 1, 'سجل الظرف يُقرأ كما كان');

    // 10,000 حدث قديم ثم حدث جديد: أقدم 2000 تنتقل للأرشيف
    await rewriteData(admin, ({ set }) => set('activity', Array.from({ length: 10000 }, (_, i) => ({ id: 'old' + i, at: 1000 + i, userId: 'u', username: 'aud', displayName: 'aud', section: 'envelopes', action: 'قديم', targetType: 'envelope', targetId: i === 0 ? 'e-first' : 'e-bulk', targetLabel: '', details: '' }))));
    const a2 = await loggedIn(app, 'admin', ADMIN_PW);
    const aud2 = await loggedIn(app, 'aud', AUD_PW);
    assert.equal((await aud2.post('/api/v2/activity', { section: 'envelopes', action: 'جديد', details: '' })).status, 200);
    const live = (await a2.get('/api/v2/activity')).json;
    assert.equal(live.value.length, 8001); assert.equal(live.archived, 2000);
    const arch = await a2.get('/api/v2/activity?archive=1');
    assert.equal(arch.json.value.length, 2000); assert.equal(arch.json.value[0].id, 'old0');
    assert.equal((await aud2.get('/api/v2/activity?archive=1')).status, 403, 'الأرشيف لصلاحية السجلات فقط');
    assert.equal((await aud2.get('/api/v2/activity?target=e-first')).json.value.length, 1, 'سجل الظرف يشمل المؤرشف');
  });
});

test('S3 الذكاء الاصطناعي: اسم النموذج من الإعدادات، ولا يغيّره إلا صاحب صلاحية إعدادات الذكاء الاصطناعي', async () => {
  const ai = await H.startMockAi();
  try {
    await withApp({ fixture: true, env: { EINVOICE_TEST_AI_BASE: `http://127.0.0.1:${ai.port}` } }, async (app) => {
      const admin = await loggedIn(app, 'admin', ADMIN_PW);
      const aud = await loggedIn(app, 'aud', AUD_PW);
      assert.equal((await admin.put('/api/v2/col/settings', { value: { ai: { active: 'gemini', gemini: { key: 'K-1', model: 'gemini-cheap' } } } })).status, 200);
      const body = { provider: 'gemini', model: 'gemini-most-expensive', system: 's', prompt: 'p' };
      assert.equal((await aud.post('/api/v2/ai/call', body)).json.ok, true);
      assert.match(ai.state.calls.at(-1).url, /gemini-cheap/, 'طلب المراجع يذهب للنموذج المحفوظ');
      assert.doesNotMatch(ai.state.calls.at(-1).url, /most-expensive/);
      assert.equal((await admin.post('/api/v2/ai/call', body)).json.ok, true);
      assert.match(ai.state.calls.at(-1).url, /gemini-most-expensive/, 'صاحب الإعدادات يختبر أي نموذج');
    });
  } finally { ai.close(); }
});

test('S5/S6 سباقات الكتابة، وكلمة مرور النفس لا تتغير إلا بالكلمة الحالية', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    const me = (await admin.get('/api/v2/me')).json.user;
    // S6: المدير أو مدير المستخدمين لا يغيّر كلمة مروره هو عبر تعديل المستخدم
    const self = await admin.put('/api/v2/users/' + me.id, { displayName: 'م', role: 'admin', perms: me.perms, password: 'Brand-New-2031x' });
    assert.equal(self.status, 400); assert.equal(self.json.error, 'use-change-password');
    assert.equal((await new Client(app).login('admin', 'Brand-New-2031x')).status, 401, 'كلمة المرور لم تتغير');
    const usr = await makeUser(admin, 'usr', { users: true });
    const usrc = await loggedIn(app, 'usr', usr.password);
    assert.equal((await usrc.put('/api/v2/users/' + usr.id, { displayName: 'u', role: 'auditor', perms: { users: true }, password: 'Brand-New-2031y' })).status, 400);
    // تعيين كلمة مرور لمستخدم آخر ما زال يعمل، وتعديل النفس بدون كلمة مرور ما زال يعمل
    const tmp = await makeUser(admin, 'tmp1', { envelopes: true });
    assert.equal((await admin.put('/api/v2/users/' + tmp.id, { displayName: 't', role: 'auditor', perms: { envelopes: true }, password: 'Reset-By-Admin-31' })).status, 200);
    assert.equal((await new Client(app).login('tmp1', 'Reset-By-Admin-31')).status, 200);
    assert.equal((await admin.put('/api/v2/users/' + me.id, { displayName: 'المدير', role: 'admin', perms: me.perms })).status, 200);

    // S5: مستخدمان بنفس الاسم في نفس اللحظة ⇒ واحد فقط
    const mk = () => admin.post('/api/v2/users', { username: 'twin', displayName: 'twin', password: 'Twin-Pass-2031', role: 'auditor', perms: {} });
    const both = await Promise.all([mk(), mk(), mk()]);
    assert.deepEqual(both.map((r) => r.status).sort(), [200, 409, 409]);
    assert.equal((await admin.get('/api/v2/users')).json.value.filter((u) => u.username === 'twin').length, 1);
    // S5: تعديل مستخدم بكلمة مرور (انتظار طويل) مع إضافة مستخدم في نفس اللحظة: لا يضيع ملف أحد
    const [up, add] = await Promise.all([
      admin.put('/api/v2/users/' + tmp.id, { displayName: 't2', role: 'auditor', perms: { envelopes: true }, password: 'Reset-By-Admin-32' }),
      admin.post('/api/v2/users', { username: 'late', displayName: 'late', password: 'Late-Pass-2031', role: 'auditor', perms: { reports: true } }),
    ]);
    assert.equal(up.status, 200); assert.equal(add.status, 200);
    assert.equal((await new Client(app).login('late', 'Late-Pass-2031')).status, 200, 'ملف المستخدم الجديد لم يُمسح');
    assert.equal((await admin.get('/api/v2/users')).json.value.find((u) => u.username === 'late').perms.reports, true);
    // S5: مستخدمان يحفظان تذكيراتهما في نفس اللحظة: الاثنان محفوظان
    const big = 'x'.repeat(12000);
    const [w1, w2] = await Promise.all([
      admin.put('/api/v2/me/wellness', { value: { water: { on: true, min: 30 } }, pad: big }),
      aud.put('/api/v2/me/wellness', { value: { eye: { on: true, min: 15 } }, pad: big }),
    ]);
    assert.equal(w1.status, 200); assert.equal(w2.status, 200);
    assert.equal((await admin.get('/api/v2/me/wellness')).json.value.water.min, 30);
    assert.equal((await aud.get('/api/v2/me/wellness')).json.value.eye.min, 15);
  });
});

test('S7 تسجيل عنوان IP العام اختياري ومقفول افتراضياً، وconnect-src للخادم المحلي فقط', async () => {
  await withApp({ fixture: true }, async (app) => {
    const admin = await loggedIn(app, 'admin', ADMIN_PW);
    const aud = await loggedIn(app, 'aud', AUD_PW);
    assert.equal((await aud.get('/api/v2/col/settings')).json.value.ipLookup, false);
    assert.equal((await admin.put('/api/v2/col/settings', { value: { ipLookup: 'yes' } })).status, 400);
    assert.equal((await aud.put('/api/v2/col/settings', { value: { ipLookup: true } })).status, 403);
    assert.equal((await admin.put('/api/v2/col/settings', { value: { ipLookup: true } })).status, 200);
    assert.equal((await aud.get('/api/v2/col/settings')).json.value.ipLookup, true);
    assert.ok((await admin.get('/api/v2/activity')).json.value.some((a) => /تفعيل تسجيل عنوان IP/.test(a.details)));
    const page = await app.raw('GET', '/');
    assert.match(page.headers['content-security-policy'], /connect-src 'self';/);
  });
});
