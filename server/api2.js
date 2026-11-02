/* واجهة الخادم الجديدة (/api/v2): الدخول والجلسات والصلاحيات تُفرض هنا، لا في المتصفح.
 * المتصفح يحمل كوكي جلسة فقط؛ المفتاح الرئيسي والبيانات المفكوكة والأسرار تبقى في ذاكرة الخادم. */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const C = require('./cryptoutil');
const P = require('./policy');
const ETA = require('./eta');
const AIP = require('./aiproxy');
const { Sessions } = require('./sessions');
const { parseBackup } = require('./store');
const Prayer = require('../app/js/prayer'); // نفس قوائم وفحص تذكيرات الراحة في الواجهة

const MAX_FAILS = 4;
const LOCK_MS = 60000;
const SECTIONS = ['envelopes', 'quotes', 'users', 'settings'];
const AI_PROVIDERS = AIP.PROVIDERS;

class HttpError extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || 'error'; this.extra = extra; }
}
const deny = (msg) => { throw new HttpError(403, msg || 'ليس لديك صلاحية لهذا الإجراء', 'forbidden'); };
const bad = (msg, code) => { throw new HttpError(400, msg, code || 'bad-request'); };
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x, max, min = 0) => typeof x === 'string' && x.length <= max && x.length >= min;
const uid = () => Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
const iso = () => new Date().toISOString();

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

function parseCookies(h) {
  const o = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return o;
}

/* ===== الإعدادات: قيم افتراضية وفحص ودمج (الأسرار للكتابة فقط) ===== */
const defaultSettings = () => ({
  ai: {
    active: 'gemini',
    gemini: { key: '', model: 'gemini-2.5-flash' },
    claude: { key: '', model: 'claude-sonnet-5-5' },
    openai: { key: '', model: 'gpt-4o' },
  },
  eta: { env: 'prod', clientId: '', clientSecret: '', receiverId: '' },
  whtRate: 1,
  categories: [
    { id: 'grocery', name: 'بقالة', vat: null },
    { id: 'general', name: 'جنرال', vat: null },
    { id: 'veg', name: 'خضار وفاكهة', vat: 0 },
    { id: 'fish', name: 'سمك ومجمدات', vat: 0 },
  ],
  idleMinutes: 30,
  segregation: false,   // الفصل بين المُعِد والمعتمِد
  closedMonths: [],     // الشهور المقفلة (تُعدَّل من /api/v2/period للمدير فقط)
  restaurants: [],      // المطاعم/الفروع لتوزيع الاستهلاك [{id, name}]
  suppliers: [],        // سجل الموردين: [{id: الرقم الضريبي, name, whtRate: نسبة الخصم والإضافة أو null = النسبة العامة}]
});

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function mergeSettings(old, inc, opts = {}) {
  if (!isObj(inc)) bad('الإعدادات غير صالحة');
  const out = defaultSettings();
  const o = old || defaultSettings();
  // أرقام عامة
  const wht = inc.whtRate === undefined ? o.whtRate : Number(inc.whtRate);
  if (!Number.isFinite(wht) || wht < 0 || wht > 100) bad('نسبة الخصم والإضافة غير صالحة');
  out.whtRate = wht;
  const idle = inc.idleMinutes === undefined ? o.idleMinutes : Number(inc.idleMinutes);
  if (!Number.isInteger(idle) || idle < 5 || idle > 1440) bad('مدة الخروج التلقائي بين 5 و1440 دقيقة');
  out.idleMinutes = idle;
  const seg = inc.segregation === undefined ? !!o.segregation : inc.segregation;
  if (typeof seg !== 'boolean') bad('إعداد الفصل بين المُعِد والمعتمِد غير صالح');
  out.segregation = seg;
  // الشهور المقفلة لا تتغير عبر حفظ الإعدادات أبداً (حتى لو أرسلها المتصفح)؛ فقط عبر إقفال/فتح الفترة
  // opts.trusted = قراءة القيمة المخزنة نفسها (من الخادم)، وليس طلباً من المتصفح
  const cm = opts.trusted ? inc.closedMonths : o.closedMonths;
  out.closedMonths = Array.isArray(cm) ? [...new Set(cm.filter((m) => MONTH_RE.test(m)))].sort() : [];
  // أنواع التوريد
  const cats = inc.categories === undefined ? o.categories : inc.categories;
  if (!Array.isArray(cats) || cats.length > 50) bad('أنواع التوريد غير صالحة');
  const seen = new Set();
  out.categories = cats.map((c) => {
    if (!isObj(c) || !str(c.id, 64, 1) || !/^[A-Za-z0-9_-]+$/.test(c.id) || !str(c.name, 100, 1) || seen.has(c.id)) bad('نوع توريد غير صالح');
    seen.add(c.id);
    const vat = c.vat === null || c.vat === undefined ? null : Number(c.vat);
    if (vat !== null && (!Number.isFinite(vat) || vat < 0 || vat > 100)) bad('نسبة ق.م غير صالحة');
    return { id: c.id, name: c.name, vat };
  });
  // المطاعم
  const rests = inc.restaurants === undefined ? (o.restaurants || []) : inc.restaurants;
  if (!Array.isArray(rests) || rests.length > 200) bad('قائمة المطاعم غير صالحة');
  const rIds = new Set(), rNames = new Set();
  out.restaurants = rests.map((r) => {
    if (!isObj(r) || !str(r.id, 64, 1) || !/^[A-Za-z0-9_-]+$/.test(r.id) || !str(String(r.name || '').trim(), 100, 1)) bad('مطعم غير صالح');
    const name = String(r.name).trim();
    if (rIds.has(r.id) || rNames.has(name)) bad('اسم أو معرف مطعم مكرر');
    rIds.add(r.id); rNames.add(name);
    return { id: r.id, name };
  });
  // سجل الموردين ونسبة الخصم والإضافة لكل مورد
  const sups = inc.suppliers === undefined ? (o.suppliers || []) : inc.suppliers;
  if (!Array.isArray(sups) || sups.length > 5000) bad('سجل الموردين غير صالح');
  const sIds = new Set();
  out.suppliers = sups.map((x) => {
    if (!isObj(x) || !str(String(x.id || ''), 30, 3) || !/^[A-Za-z0-9-]+$/.test(String(x.id)) || sIds.has(String(x.id))) bad('مورد غير صالح أو مكرر');
    sIds.add(String(x.id));
    const rate = x.whtRate === null || x.whtRate === undefined || x.whtRate === '' ? null : Number(x.whtRate);
    if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) bad('نسبة خصم المورد غير صالحة');
    if (!str(String(x.name || ''), 200)) bad('اسم المورد طويل');
    return { id: String(x.id), name: String(x.name || '').trim(), whtRate: rate };
  });
  // الذكاء الاصطناعي: المفتاح يُستبدل فقط لو أُرسل نص غير فارغ، ويُمسح بـ clearKey، وإلا يبقى القديم
  const ai = isObj(inc.ai) ? inc.ai : {};
  out.ai.active = ai.active === undefined ? (o.ai && o.ai.active) || 'gemini' : ai.active;
  if (!AI_PROVIDERS.includes(out.ai.active)) bad('مزود الذكاء الاصطناعي غير معروف');
  for (const p of AI_PROVIDERS) {
    const oc = (o.ai && o.ai[p]) || out.ai[p];
    const ic = isObj(ai[p]) ? ai[p] : {};
    const model = ic.model === undefined ? oc.model : ic.model;
    if (!AIP.MODEL_RE.test(String(model))) bad('اسم النموذج غير صالح');
    let key = oc.key || '';
    if (ic.clearKey === true) key = '';
    else if (typeof ic.key === 'string' && ic.key.length) { if (ic.key.length > 500) bad('المفتاح طويل جداً'); key = ic.key.trim(); }
    out.ai[p] = { key, model: String(model) };
  }
  // الضرائب (نفس القاعدة للسر)
  const ie = isObj(inc.eta) ? inc.eta : {};
  const oe = o.eta || out.eta;
  const env = ie.env === undefined ? oe.env : ie.env;
  if (!['prod', 'preprod'].concat(process.env.EINVOICE_TEST_ETA_BASE ? ['test'] : []).includes(env)) bad('بيئة الضرائب غير صالحة');
  const clientId = ie.clientId === undefined ? oe.clientId : ie.clientId;
  const receiverId = ie.receiverId === undefined ? oe.receiverId : ie.receiverId;
  if (!str(clientId, 200) || !str(receiverId, 30)) bad('بيانات الضرائب غير صالحة');
  let secret = oe.clientSecret || '';
  if (ie.clearSecret === true) secret = '';
  else if (typeof ie.clientSecret === 'string' && ie.clientSecret.length) { if (ie.clientSecret.length > 500) bad('Client Secret طويل جداً'); secret = ie.clientSecret.trim(); }
  out.eta = { env, clientId: clientId.trim(), clientSecret: secret, receiverId: receiverId.trim() };
  return out;
}

/* see: true (كل الأقسام) أو {ai, eta} حسب صلاحيات المستخدم */
function sanitizeSettings(s, see) {
  const out = { whtRate: s.whtRate, idleMinutes: s.idleMinutes, categories: s.categories, segregation: !!s.segregation, closedMonths: s.closedMonths || [], companyTaxId: s.eta.receiverId || '', restaurants: s.restaurants || [], suppliers: s.suppliers || [] };
  const ai = see === true || (see && see.ai), eta = see === true || (see && see.eta);
  if (ai) {
    out.ai = { active: s.ai.active };
    for (const p of AI_PROVIDERS) out.ai[p] = { model: s.ai[p].model, hasKey: !!s.ai[p].key };
  }
  if (eta) out.eta = { env: s.eta.env, clientId: s.eta.clientId, receiverId: s.eta.receiverId, hasSecret: !!s.eta.clientSecret };
  return out;
}

/* ===== مصفوفة الصلاحيات لمجموعات البيانات ===== */
const SETTINGS_PERMS = ['settingsAi', 'settingsEta', 'settingsGeneral'];
const COLS = {
  settings: { get: true, put: SETTINGS_PERMS, limit: 300 * 1024 },
  quotes: { get: true, put: 'quotes', limit: 60 * 1024 * 1024 },
  envelopes: { get: ['envelopes', 'cn', 'reports', 'approve'], put: ['envelopes', 'cn', 'approve'], limit: 120 * 1024 * 1024 },
  mappings: { get: ['envelopes', 'mappings'], put: ['envelopes', 'mappings'], limit: 30 * 1024 * 1024 },
  // فواتير المنظومة المسحوبة لفترة (ملخص كل مستند) لتصنيفها لكل مورد ولنموذج 41
  etadocs: { get: ['envelopes', 'reports', 'cn'], put: ['envelopes'], limit: 80 * 1024 * 1024 },
};
const allowed = (user, spec) => spec === true || (Array.isArray(spec) ? spec.some((k) => user.can(k)) : user.can(spec));

// وسم المطعم الفارغ = غير موجود (حتى لا يُعتبر الفرق بين '' و undefined تعديلاً)
const normInv = (i) => { if (!isObj(i) || i.restaurantId) return i; const x = { ...i }; delete x.restaurantId; return x; };
const envStrip = (e) => { const c = { ...e }; delete c.updatedAt; delete c.updatedBy; delete c.cn; if (Array.isArray(c.invoices)) c.invoices = c.invoices.map(normInv); return c; };
// بدون وسم المطعم على الفواتير: توزيع الاستهلاك مسموح تعديله بعد الاعتماد (لا يغيّر أرقام الظرف)
const tagStrip = (e) => { const c = envStrip(e); c.invoices = (e.invoices || []).map((i) => { const x = { ...i }; delete x.restaurantId; return x; }); return c; };
// المحتوى الذي يُعتبر "إعداداً" للظرف (بدون الحالة والأختام ومتابعة الإشعار الدائن)
const workStrip = (e) => { const c = envStrip(e); for (const k of ['status', 'approvedAt', 'approvedBy', 'reopenedAt', 'reopenedBy', 'preparers', 'createdAt', 'createdBy']) delete c[k]; return c; };

/* متابعة الإشعار الدائن والسداد: تُعدّل حتى بعد الاعتماد أو إقفال الشهر (لا تغيّر أرقام الظرف نفسها) */
function checkCn(cn) {
  if (cn === undefined || cn === null) return;
  if (!isObj(cn)) bad('بيانات متابعة الإشعار الدائن غير صالحة');
  if (cn.docs !== undefined) {
    if (!Array.isArray(cn.docs) || cn.docs.length > 200) bad('مستندات الإشعار الدائن غير صالحة');
    for (const d of cn.docs) if (!isObj(d) || !Number.isFinite(Number(d.total)) || Number(d.total) < 0 || !str(String(d.internalId || ''), 100) || !str(String(d.uuid || ''), 100)) bad('مستند إشعار دائن غير صالح');
  }
  for (const k of ['paidAt', 'settledAt']) if (cn[k] != null && cn[k] !== '' && !/^\d{4}-\d{2}-\d{2}/.test(String(cn[k]))) bad('تاريخ غير صالح');
  if (cn.note != null && !str(String(cn.note), 1000)) bad('ملاحظة طويلة');
}

/* قواعد الأظرف: الاعتماد وإعادة الفتح بصلاحية "الاعتماد"، والظرف المعتمد مقفول، وحذف المعتمد للمدير، والهوية تُختم من الجلسة.
 * ctx.segregation: من شارك في إعداد الظرف لا يعتمده. ctx.closed: شهور مقفلة لا يتغير فيها أي ظرف.
 * مدير النظام يتخطى كل هذه القيود (قرار صاحب البرنامج)، وكل تخطٍّ يُرجع في overrides ليُسجل في سجل النشاط باسمه. */
function checkEnvelopes(user, oldList, incoming, ctx = {}) {
  if (!Array.isArray(incoming) || incoming.length > 20000) bad('قائمة الأظرف غير صالحة');
  const closed = ctx.closed || new Set();
  const oldMap = new Map(oldList.map((e) => [e.id, e]));
  const ids = new Set();
  const now = iso();
  const out = [];
  const closedMsg = (m) => `شهر ${m} مقفل — لا يمكن تعديل أظرفه إلا بعد فتح الفترة من المدير`;
  const admin = !!user.isAdmin;
  const overrides = [];
  const label = (e) => ({ type: 'envelope', id: e.id, label: `${e.supplier || 'ظرف'} — ${e.month || ''}` });
  const override = (e, why) => overrides.push({ section: 'envelopes', action: 'تخطٍّ بصلاحية المدير', target: label(e), details: why });
  for (const inc of incoming) {
    if (!isObj(inc) || !str(inc.id, 64, 1) || ids.has(inc.id)) bad('ظرف غير صالح أو مكرر');
    if (inc.status !== 'draft' && inc.status !== 'approved') bad('حالة ظرف غير معروفة');
    if (!Array.isArray(inc.invoices)) bad('فواتير الظرف غير صالحة');
    checkCn(inc.cn);
    for (const i of inc.invoices) if (isObj(i) && i.restaurantId != null && i.restaurantId !== '' && !str(String(i.restaurantId), 64)) bad('مطعم الفاتورة غير صالح');
    ids.add(inc.id);
    const o = oldMap.get(inc.id);
    // قائمة من شارك في الإعداد يحددها الخادم فقط
    inc.preparers = o && Array.isArray(o.preparers) ? [...o.preparers] : [];
    const cnChanged = stable((o && o.cn) || null) !== stable(inc.cn || null);
    if (cnChanged && !user.can('cn')) deny('متابعة الإشعارات الدائنة تحتاج صلاحية "متابعة الإشعارات الدائنة والسداد"');
    if (cnChanged && inc.cn) { inc.cn.updatedBy = user.username; inc.cn.updatedAt = now; }
    if (!o) {
      if (!user.can('envelopes')) deny('فتح الأظرف يحتاج صلاحية "مراجعة الأظرف"');
      if (closed.has(inc.month)) { if (!admin) deny(closedMsg(inc.month)); override(inc, `إنشاء ظرف في شهر مقفل (${inc.month})`); }
      inc.createdBy = user.username;
      if (!inc.createdAt) inc.createdAt = now;
      inc.preparers = [user.username];
      if (inc.status === 'approved') {
        if (!user.can('approve')) deny('اعتماد الظرف يحتاج صلاحية الاعتماد');
        if (ctx.segregation) { if (!admin) deny('الفصل بين المُعِد والمعتمِد مفعّل: لا يمكن إنشاء ظرف معتمد مباشرة'); override(inc, 'إنشاء ظرف معتمد مباشرة رغم الفصل بين المُعِد والمعتمِد'); }
        inc.approvedBy = user.username; inc.approvedAt = now;
      }
      out.push(inc);
      continue;
    }
    const contentChanged = stable(envStrip(o)) !== stable(envStrip({ ...inc, preparers: o.preparers || [] }));
    // تغيير المحتوى (غير الحالة) يحتاج "مراجعة الأظرف"
    if (contentChanged && !user.can('envelopes') && stable(workStrip(o)) !== stable(workStrip(inc))) deny('تعديل الأظرف يحتاج صلاحية "مراجعة الأظرف"');
    if (contentChanged && !user.can('envelopes') && stable(tagStrip(o)) === stable(tagStrip({ ...inc, preparers: o.preparers || [] })) && stable(o.invoices) !== stable(inc.invoices)) deny('توزيع الفواتير على المطاعم يحتاج صلاحية "مراجعة الأظرف"');
    if (contentChanged && (closed.has(o.month) || closed.has(inc.month))) {
      const m = closed.has(o.month) ? o.month : inc.month;
      if (!admin) deny(closedMsg(m));
      override(inc, `تعديل ظرف في شهر مقفل (${m})`);
    }
    if (o.status === 'approved') {
      if (inc.status !== 'approved') {
        if (!user.can('approve')) deny('إعادة فتح ظرف معتمد تحتاج صلاحية الاعتماد');
        inc.reopenedBy = user.username; inc.reopenedAt = now;
        inc.updatedBy = user.username; inc.updatedAt = now;
        out.push(inc);
      } else {
        if (contentChanged && stable(tagStrip(o)) !== stable(tagStrip({ ...inc, preparers: o.preparers || [] }))) {
          if (!admin) deny('الظرف المعتمد مقفول ولا يمكن تعديله');
          // المدير يعدّل الظرف المعتمد مباشرة (بدون إعادة فتح)، ويبقى معتمداً بنفس المعتمِد الأصلي
          override(inc, 'تعديل محتوى ظرف معتمد بدون إعادة فتحه');
          out.push({ ...inc, approvedBy: o.approvedBy, approvedAt: o.approvedAt, createdBy: o.createdBy, createdAt: o.createdAt, updatedBy: user.username, updatedAt: now });
          continue;
        }
        // المسموح فقط: متابعة الإشعار الدائن ووسم المطعم على كل فاتورة
        const tags = new Map(inc.invoices.map((i) => [i.id, i.restaurantId || '']));
        const kept = { ...o, cn: cnChanged ? inc.cn : o.cn, invoices: o.invoices.map((i) => normInv({ ...i, restaurantId: tags.has(i.id) ? tags.get(i.id) : i.restaurantId })) };
        if (contentChanged) { kept.updatedBy = user.username; kept.updatedAt = now; }
        out.push(kept);
      }
      continue;
    }
    if (inc.status === 'approved') {
      if (!user.can('approve')) deny('اعتماد الظرف يحتاج صلاحية الاعتماد');
      if (ctx.segregation && inc.preparers.includes(user.username)) {
        if (!admin) deny('الفصل بين المُعِد والمعتمِد مفعّل: لا يمكنك اعتماد ظرف شاركت في إعداده — يعتمده مستخدم آخر');
        override(inc, 'اعتماد ظرف شارك المدير في إعداده (تخطي الفصل بين المُعِد والمعتمِد)');
      }
      inc.approvedBy = user.username; inc.approvedAt = now;
    } else if (stable(workStrip(o)) !== stable(workStrip(inc)) && !inc.preparers.includes(user.username)) {
      inc.preparers.push(user.username);
    }
    if (contentChanged) { inc.updatedBy = user.username; inc.updatedAt = now; }
    else { inc.updatedBy = o.updatedBy; inc.updatedAt = o.updatedAt; }
    out.push(inc);
  }
  const removed = oldList.filter((e) => !ids.has(e.id));
  for (const e of removed) {
    if (closed.has(e.month)) { if (!admin) deny(closedMsg(e.month)); override(e, `حذف ظرف من شهر مقفل (${e.month})`); }
    if (e.status === 'approved' && !admin) deny('حذف ظرف معتمد للمدير فقط');
    if (e.status !== 'approved' && !user.can('envDelete')) deny('حذف الأظرف يحتاج صلاحية "حذف الأظرف قيد المراجعة"');
  }
  return { out, removed, overrides };
}

/* عروض الأسعار في الشهور المقفلة لا تتغير */
function checkClosedQuotes(oldList, inc, closed, admin) {
  const overrides = [];
  if (!closed.size) return overrides;
  const deny2 = (msg, q) => { if (!admin) deny(msg); overrides.push({ section: 'quotes', action: 'تخطٍّ بصلاحية المدير', target: { type: 'quote', id: q.id, label: `عرض سعر ${q.month}` }, details: msg.replace(' — لا يمكن', ': تم') }); };
  const oldMap = new Map(oldList.map((q) => [q.id, q]));
  const ids = new Set(inc.map((q) => q.id));
  for (const q of inc) {
    const o = oldMap.get(q.id);
    if ((!o && closed.has(q.month)) || (o && (closed.has(o.month) || closed.has(q.month)) && stable(o) !== stable(q))) deny2(`شهر ${(o || q).month} مقفل — لا يمكن تعديل عروض أسعاره`, q);
  }
  for (const o of oldList) if (!ids.has(o.id) && closed.has(o.month)) deny2(`شهر ${o.month} مقفل — لا يمكن حذف عروض أسعاره`, o);
  return overrides;
}

function checkQuotes(v) {
  if (!Array.isArray(v) || v.length > 5000) bad('عروض الأسعار غير صالحة');
  const ids = new Set();
  for (const q of v) { if (!isObj(q) || !str(q.id, 64, 1) || ids.has(q.id)) bad('عرض سعر غير صالح أو مكرر'); ids.add(q.id); }
}

/* من لا يملك صلاحية "العروض" لكن يملك "الاعتماد": اعتماد الظرف يثبّت نسبة ق.م على الأصناف التي لا نسبة لها.
 * يُسمح بهذا فقط: كل شيء كما هو، إلا vat في صنف كانت فارغة (null) وأصبحت رقماً صالحاً. */
function onlyVatFill(oldList, inc) {
  if (!Array.isArray(inc) || inc.length !== oldList.length) return false;
  const oldMap = new Map(oldList.map((q) => [q.id, q]));
  for (const q of inc) {
    const o = oldMap.get(q.id);
    if (!o || !isObj(q) || !Array.isArray(q.items) || !Array.isArray(o.items) || q.items.length !== o.items.length) return false;
    const { items: qi, ...qRest } = q; const { items: oi, ...oRest } = o;
    if (stable(qRest) !== stable(oRest)) return false;
    for (let i = 0; i < qi.length; i++) {
      const a = oi[i], b = qi[i];
      if (!isObj(a) || !isObj(b)) return false;
      if (stable(a) === stable(b)) continue;
      if (a.vat !== null && a.vat !== undefined) return false;
      if (typeof b.vat !== 'number' || !Number.isFinite(b.vat) || b.vat < 0 || b.vat > 100) return false;
      if (stable({ ...a, vat: 0 }) !== stable({ ...b, vat: 0 })) return false;
    }
  }
  return true;
}

function deviceInfo(req) {
  const ua = String(req.headers['user-agent'] || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'متصفح آخر';
  const ver = (ua.match(/(?:Edg|OPR|Chrome|Firefox|Version)\/(\d+)/) || [])[1] || '';
  const osn = /Windows NT 10/.test(ua) ? 'Windows 10/11' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'غير معروف';
  return { browser: browser + (ver ? ' ' + ver : ''), os: osn };
}
const HOST = os.hostname();
const DEVICE_ID = 'D-' + crypto.createHash('sha256').update(HOST).digest('hex').slice(0, 14).toUpperCase();

let ipCache = null;
async function publicIp() {
  if (process.env.EINVOICE_NO_IPLOOKUP) return '';
  if (ipCache && Date.now() - ipCache.at < 10 * 60000) return ipCache.ip;
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    const ip = String((await r.json()).ip || '').slice(0, 64);
    ipCache = { ip, at: Date.now() };
    return ip;
  } catch (e) { return ''; }
}

function createApi2({ store, dataDir, json, readBody, version, openFolder }) {
  const LOCK_FILE = path.join(dataDir, '.login-lock.json');
  const MIRROR_FILE = path.join(dataDir, '.mirror.json');
  try { const md = JSON.parse(fs.readFileSync(MIRROR_FILE, 'utf8')).dir; if (md && path.isAbsolute(md)) store.mirrorDir = md; } catch (e) { /* غير مُعد */ }
  const testIdle = Number(process.env.EINVOICE_TEST_IDLE_MS) || 0;
  let idleMinutes = 30;
  let settingUp = false;
  const aiRate = new Map();

  const sessions = new Sessions({
    idleMs: () => testIdle || Math.max(5, idleMinutes) * 60000,
    onEnd: (s, reason) => { if (s.logId) store.updateLog(s.logId, { end: Date.now(), endReason: reason, lastSeen: s.lastSeen }); },
    onEmpty: () => store.lock(),
  });

  /* ===== الحالة عند البدء ===== */
  function closeStale() {
    let changed = false;
    for (const e of store.log()) if (e.type === 'session' && !e.end) { e.end = e.lastSeen || e.at; e.endReason = 'إغلاق الخادم / انقطاع'; changed = true; }
    if (changed) { store.touch(); store.scheduleSave(); }
  }
  closeStale();
  const sweepMs = Number(process.env.EINVOICE_TEST_SWEEP_MS) || 30000;
  const timer = setInterval(() => {
    sessions.sweep();
    for (const s of sessions.map.values()) if (s.logId) store.updateLog(s.logId, { lastSeen: s.lastSeen });
  }, sweepMs);
  if (timer.unref) timer.unref();

  /* ===== أدوات ===== */
  const readLock = () => { try { const j = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); return { fails: Number(j.fails) || 0, until: Number(j.until) || 0 }; } catch (e) { return { fails: 0, until: 0 }; } };
  const writeLock = (l) => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(LOCK_FILE, JSON.stringify(l)); } catch (e) { /* */ } };

  function logEntry(req, extra) {
    const e = { id: uid(), deviceId: DEVICE_ID, deviceLabel: HOST, ip: '', ...deviceInfo(req), screen: '', ...extra };
    store.appendLog(e);
    publicIp().then((ip) => { if (ip) store.updateLog(e.id, { ip }); });
    return e.id;
  }

  const cookieOf = (id) => `einv_s=${id}; Path=/; HttpOnly; SameSite=Strict`;
  const clearCookie = 'einv_s=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';

  function userFor(sess) {
    const rec = store.findUserById(sess.userId);
    const p = rec && store.getCol('profiles', {})[sess.userId];
    if (!rec || !p) { sessions.destroy(sess.id, 'حساب محذوف'); return null; }
    const perms = P.cleanPerms(p.perms);
    const role = p.role === 'admin' ? 'admin' : 'auditor';
    return {
      id: sess.userId, username: rec.username, displayName: p.displayName || rec.username, role, perms, sid: sess.id,
      weakPassword: !!sess.weakPassword, isAdmin: role === 'admin',
      can(k) { return role === 'admin' || !!perms[k]; },
    };
  }
  const publicMe = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, perms: u.perms, weakPassword: u.weakPassword });

  const readSettings = () => {
    const s = store.getCol('settings', null);
    if (!s) return defaultSettings();
    try { return mergeSettings(defaultSettings(), s, { trusted: true }); } catch (e) { return defaultSettings(); }
  };
  function refreshIdle() { try { idleMinutes = readSettings().idleMinutes || 30; } catch (e) { /* */ } }

  /* سجل النشاط الذي يكتبه الخادم بنفسه (لا يمكن للمتصفح تزويره أو إغفاله) */
  async function serverActivity(user, section, action, target, details) {
    const list = store.getCol('activity', []);
    list.push({
      id: uid(), at: Date.now(), userId: user.id, username: user.username, displayName: user.displayName,
      section, action, targetType: target ? target.type : '', targetId: target ? target.id : '', targetLabel: target ? target.label : '', details: details || '',
    });
    if (list.length > 10000) list.splice(0, list.length - 10000);
    await store.setCol('activity', list);
  }

  /* ===== الدخول والإعداد ===== */
  async function doSetup(req, res, body) {
    if (store.corrupt) throw new HttpError(503, 'ملف البيانات تالف: ' + store.corrupt, 'corrupt');
    if (store.hasUsers() || settingUp) throw new HttpError(409, 'النظام مُهيأ بالفعل', 'already-setup');
    if (!isObj(body)) bad('بيانات ناقصة');
    const uIssue = P.usernameIssue(body.username); if (uIssue) bad(uIssue);
    const pIssue = P.passwordIssue(body.password); if (pIssue) bad(pIssue, 'weak-password');
    const display = String(body.displayName || '').trim() || body.username.trim();
    if (!str(display, 100)) bad('الاسم الظاهر طويل');
    settingUp = true;
    try {
      const settings = mergeSettings(defaultSettings(), body.settings === undefined ? {} : body.settings);
      const master = crypto.randomBytes(32);
      const wrap = await C.wrapMaster(body.password, master);
      const id = uid();
      store.data = { users: [{ id, username: body.username.trim(), wrap, createdAt: iso() }], meta: { app: 'einvoice-validation', version: 1, createdAt: iso() } };
      store.setMaster(master);
      await store.setCol('profiles', { [id]: { displayName: display, role: 'admin', perms: P.allPerms() } });
      await store.setCol('settings', settings);
      await store.setCol('quotes', []);
      await store.setCol('envelopes', []);
      await store.setCol('mappings', {});
      await store.setCol('activity', []);
      refreshIdle();
      const rec = store.findUserById(id);
      const sess = sessions.create(rec, { weakPassword: false });
      sess.logId = logEntry(req, { type: 'session', userId: id, username: rec.username, displayName: display, role: 'admin', at: Date.now(), lastSeen: Date.now(), end: null, endReason: null });
      return json(res, 200, { user: publicMe(userFor(sess)) }, { 'Set-Cookie': cookieOf(sess.id) });
    } finally { settingUp = false; }
  }

  /* محاولات الدخول تُعالج واحدة بعد الأخرى: وإلا فكل الطلبات المتوازية تقرأ نفس العداد قبل أن تكتب خطأها، فيتجاوز المهاجم القفل */
  let loginQ = Promise.resolve();
  function doLogin(req, res, body) {
    const run = loginQ.then(() => doLoginInner(req, res, body));
    loginQ = run.catch(() => {});
    return run;
  }
  async function doLoginInner(req, res, body) {
    if (!isObj(body) || !str(body.username, 200, 1) || !str(body.password, 1024, 1)) bad('أدخل اسم الدخول وكلمة المرور');
    const lock = readLock();
    if (lock.until > Date.now()) return json(res, 429, { error: 'locked', message: 'تم إيقاف الدخول مؤقتاً بعد محاولات خاطئة', until: lock.until });
    if (!store.hasUsers()) throw new HttpError(409, 'النظام غير مُهيأ', 'needs-setup');
    const rec = store.findUser(body.username);
    const master = rec ? await C.unwrapMaster(body.password, rec.wrap) : await C.dummyWork(body.password);
    if (!master) {
      const fails = lock.fails + 1;
      const locked = fails >= MAX_FAILS;
      const until = Date.now() + LOCK_MS;
      writeLock(locked ? { fails: 0, until } : { fails, until: 0 });
      // لا نسجّل النص المكتوب لو الاسم غير موجود (قد يكون كلمة مرور)
      logEntry(req, { type: locked ? 'locked' : 'fail', username: rec ? rec.username : 'اسم غير مسجل', knownUser: !!rec, at: Date.now() });
      if (locked) return json(res, 429, { error: 'locked', message: 'تم إيقاف الدخول مؤقتاً بعد محاولات خاطئة', until });
      return json(res, 401, { error: 'bad-credentials', message: 'بيانات الدخول غير صحيحة', left: MAX_FAILS - fails });
    }
    writeLock({ fails: 0, until: 0 });
    const old = parseCookies(req.headers.cookie).einv_s;
    if (old) sessions.destroy(old, 'دخول جديد'); // معرّف جلسة جديد دائماً (يمنع Session Fixation)؛ قبل setMaster لأن آخر جلسة تُنهى تقفل المخزن
    store.setMaster(master);
    const p = store.getCol('profiles', {})[rec.id];
    if (!p) throw new HttpError(403, 'الحساب غير مكتمل', 'forbidden');
    refreshIdle();
    const sess = sessions.create(rec, { weakPassword: !!P.passwordIssue(body.password) });
    sess.logId = logEntry(req, { type: 'session', userId: rec.id, username: rec.username, displayName: p.displayName || rec.username, role: p.role, at: Date.now(), lastSeen: Date.now(), end: null, endReason: null });
    return json(res, 200, { user: publicMe(userFor(sess)) }, { 'Set-Cookie': cookieOf(sess.id) });
  }

  /* ===== المستخدمون ===== */
  const profilesOf = () => store.getCol('profiles', {});
  const adminCount = () => { const pr = profilesOf(); return store.data.users.filter((u) => (pr[u.id] || {}).role === 'admin').length; };
  const userRow = (rec, p) => ({ id: rec.id, username: rec.username, displayName: (p && p.displayName) || rec.username, role: p ? p.role : 'auditor', perms: P.cleanPerms(p && p.perms), createdAt: rec.createdAt });

  function checkRolePerms(actor, role, perms) {
    if (!P.ROLES.includes(role)) bad('دور غير معروف');
    if (actor.isAdmin) return;
    if (role === 'admin') deny('منح دور مدير النظام للمدير فقط');
    for (const k of P.PERM_KEYS) if (perms[k] && !actor.can(k)) deny('لا يمكنك منح صلاحية لا تملكها');
  }
  const permsText = (role, perms) => (role === 'admin' ? 'مدير (كل الصلاحيات)' : 'مراجع: ' + (P.PERM_KEYS.filter((k) => perms[k]).join('، ') || 'بدون صلاحيات'));

  async function addUser(actor, body) {
    if (!actor.can('users')) deny();
    if (!isObj(body)) bad('بيانات ناقصة');
    const uIssue = P.usernameIssue(body.username); if (uIssue) bad(uIssue);
    const perms = P.cleanPerms(body.perms);
    checkRolePerms(actor, body.role, perms);
    const pIssue = P.passwordIssue(body.password); if (pIssue) bad(pIssue, 'weak-password');
    const username = body.username.trim();
    const display = String(body.displayName || '').trim() || username;
    if (!str(display, 100)) bad('الاسم الظاهر طويل');
    if (store.findUser(username)) throw new HttpError(409, 'اسم المستخدم موجود بالفعل', 'duplicate');
    const id = uid();
    const wrap = await C.wrapMaster(body.password, store.master);
    store.data.users.push({ id, username, wrap, createdAt: iso() });
    const pr = profilesOf();
    pr[id] = { displayName: display, role: body.role, perms };
    await store.setCol('profiles', pr);
    await serverActivity(actor, 'users', 'إضافة مستخدم', { type: 'user', id, label: username }, permsText(body.role, perms));
    return { id };
  }

  async function updateUser(actor, id, body) {
    if (!isObj(body)) bad('بيانات ناقصة');
    const rec = store.findUserById(id);
    if (!rec) throw new HttpError(404, 'المستخدم غير موجود', 'not-found');
    const pr = profilesOf();
    const tp = pr[id] || { role: 'auditor', perms: {} };
    const isSelf = id === actor.id;
    const perms = P.cleanPerms(body.perms);
    if (!actor.isAdmin) {
      if (!actor.can('users')) deny();
      if (tp.role === 'admin') deny('تعديل حساب مدير النظام للمدير فقط');
      if (isSelf && stable(perms) !== stable(P.cleanPerms(tp.perms))) deny('لا يمكنك تعديل صلاحياتك بنفسك');
    }
    checkRolePerms(actor, body.role, perms);
    if (tp.role === 'admin' && body.role !== 'admin' && adminCount() <= 1) deny('لا يمكن إزالة آخر مدير للنظام');
    const display = String(body.displayName || '').trim() || rec.username;
    if (!str(display, 100)) bad('الاسم الظاهر طويل');
    const notes = [];
    if (permsText(tp.role, P.cleanPerms(tp.perms)) !== permsText(body.role, perms)) notes.push(`الصلاحيات من [${permsText(tp.role, P.cleanPerms(tp.perms))}] إلى [${permsText(body.role, perms)}]`);
    if ((tp.displayName || '') !== display) notes.push(`الاسم من «${tp.displayName || ''}» إلى «${display}»`);
    if (body.password !== undefined && body.password !== null && body.password !== '') {
      const pIssue = P.passwordIssue(body.password); if (pIssue) bad(pIssue, 'weak-password');
      rec.wrap = await C.wrapMaster(body.password, store.master);
      sessions.destroyUser(id, isSelf ? actor.sid : null, 'تغيير كلمة المرور');
      notes.push('تم تعيين كلمة مرور جديدة');
    }
    pr[id] = { displayName: display, role: body.role, perms };
    await store.setCol('profiles', pr);
    await serverActivity(actor, 'users', 'تعديل مستخدم', { type: 'user', id, label: rec.username }, notes.join('\n') || 'بدون تغيير');
  }

  async function changePassword(actor, id, body) {
    if (!isObj(body)) bad('بيانات ناقصة');
    const rec = store.findUserById(id);
    if (!rec) throw new HttpError(404, 'المستخدم غير موجود', 'not-found');
    const isSelf = id === actor.id;
    if (isSelf) {
      const m = typeof body.oldPassword === 'string' ? await C.unwrapMaster(body.oldPassword, rec.wrap) : null;
      if (!m || !store.master.equals(m)) throw new HttpError(403, 'كلمة المرور الحالية غير صحيحة', 'bad-old-password');
    } else if (!actor.isAdmin) {
      if (!actor.can('users')) deny();
      if ((profilesOf()[id] || {}).role === 'admin') deny('تغيير كلمة مرور مدير النظام للمدير فقط');
    }
    const pIssue = P.passwordIssue(body.password); if (pIssue) bad(pIssue, 'weak-password');
    rec.wrap = await C.wrapMaster(body.password, store.master);
    store.touch();
    await store.save();
    sessions.destroyUser(id, isSelf ? actor.sid : null, 'تغيير كلمة المرور');
    if (isSelf) { const s = sessions.map.get(actor.sid); if (s) s.weakPassword = false; }
    await serverActivity(actor, 'users', isSelf ? 'تغيير كلمة المرور' : 'تعيين كلمة مرور لمستخدم', { type: 'user', id, label: rec.username }, '');
  }

  async function deleteUser(actor, id) {
    if (!actor.can('users')) deny();
    if (id === actor.id) deny('لا يمكنك حذف حسابك الحالي');
    const rec = store.findUserById(id);
    if (!rec) throw new HttpError(404, 'المستخدم غير موجود', 'not-found');
    const pr = profilesOf();
    const tp = pr[id] || {};
    if (tp.role === 'admin') {
      if (!actor.isAdmin) deny('حذف مدير النظام للمدير فقط');
      if (adminCount() <= 1) deny('لا يمكن حذف آخر مدير للنظام');
    }
    store.data.users = store.data.users.filter((u) => u.id !== id);
    delete pr[id];
    await store.setCol('profiles', pr);
    const well = store.getCol('wellness', {});
    if (well[id]) { delete well[id]; await store.setCol('wellness', well); }
    sessions.destroyUser(id, null, 'حذف الحساب');
    await serverActivity(actor, 'users', 'حذف مستخدم', { type: 'user', id, label: rec.username }, `${tp.displayName || ''} · ${tp.role === 'admin' ? 'مدير' : 'مراجع'}`);
  }

  /* ===== مجموعات البيانات ===== */
  async function getCol(res, actor, name) {
    const spec = Object.prototype.hasOwnProperty.call(COLS, name) ? COLS[name] : null;
    if (!spec) throw new HttpError(404, 'غير موجود', 'not-found');
    if (!allowed(actor, spec.get)) deny();
    let v = name === 'settings' ? sanitizeSettings(readSettings(), { ai: actor.can('settingsAi'), eta: actor.can('settingsEta') }) : store.getCol(name, name === 'mappings' ? {} : []);
    return json(res, 200, { rev: store.rev(name), value: v }, { ETag: `"${store.rev(name)}"` });
  }

  async function putCol(req, res, actor, name) {
    const spec = Object.prototype.hasOwnProperty.call(COLS, name) ? COLS[name] : null;
    if (!spec) throw new HttpError(404, 'غير موجود', 'not-found');
    const vatFillOnly = name === 'quotes' && !allowed(actor, spec.put) && actor.can('approve');
    if (!vatFillOnly && !allowed(actor, spec.put)) deny();
    const body = parseJSON(await readBody(req, spec.limit));
    if (!isObj(body) || !('value' in body)) bad('الجسم يجب أن يحتوي value');
    const ifMatch = req.headers['if-match'];
    if (ifMatch !== undefined && ifMatch.replace(/"/g, '') !== String(store.rev(name))) throw new HttpError(409, 'تم تعديل هذه البيانات من مكان آخر، أعد التحميل', 'conflict', { rev: store.rev(name) });
    let value = body.value;
    const events = [];
    if (name === 'settings') {
      const old = readSettings();
      // المتصفح لا يرى أقسام الإعدادات التي ليست من صلاحيته، فلا يرسلها؛ ولو أرسلها تُتجاهل
      if (isObj(value)) { if (!actor.can('settingsAi')) delete value.ai; if (!actor.can('settingsEta')) delete value.eta; }
      value = mergeSettings(old, value);
      const changedGeneral = ['whtRate', 'idleMinutes', 'categories', 'segregation', 'restaurants', 'suppliers'].some((k) => stable(old[k]) !== stable(value[k]));
      if (changedGeneral && !actor.can('settingsGeneral')) deny('تعديل الإعدادات العامة يحتاج صلاحية "أنواع التوريد والمطاعم والإعدادات العامة"');
      for (const p of AI_PROVIDERS) if (old.ai[p].key !== value.ai[p].key) events.push(value.ai[p].key ? `تم تغيير مفتاح ${p}` : `تم حذف مفتاح ${p}`);
      if (old.eta.clientSecret !== value.eta.clientSecret) events.push(value.eta.clientSecret ? 'تم تغيير Client Secret الضرائب' : 'تم حذف Client Secret الضرائب');
      if (old.eta.clientId !== value.eta.clientId || old.eta.env !== value.eta.env) events.push('تعديل بيانات ربط الضرائب');
      if (old.whtRate !== value.whtRate || old.idleMinutes !== value.idleMinutes || stable(old.categories) !== stable(value.categories)) events.push('تعديل الإعدادات العامة');
    } else if (name === 'quotes') {
      checkQuotes(value);
      events.push(...checkClosedQuotes(store.getCol('quotes', []), value, new Set(readSettings().closedMonths), actor.isAdmin));
      if (vatFillOnly && !onlyVatFill(store.getCol('quotes', []), value)) deny('تعديل عروض الأسعار يحتاج صلاحية العروض');
    } else if (name === 'envelopes') {
      const st = readSettings();
      const chk = checkEnvelopes(actor, store.getCol('envelopes', []), value, { segregation: !!st.segregation, closed: new Set(st.closedMonths) });
      value = chk.out;
      events.push(...chk.overrides);
      const old = new Map(store.getCol('envelopes', []).map((e) => [e.id, e]));
      for (const e of value) {
        const o = old.get(e.id);
        const lbl = { type: 'envelope', id: e.id, label: `${e.supplier || 'ظرف'} — ${e.month || ''}` };
        if (o && o.status !== 'approved' && e.status === 'approved') events.push({ section: 'envelopes', action: 'اعتماد ظرف', target: lbl, details: 'اعتُمد بواسطة الخادم' });
        if (o && o.status === 'approved' && e.status !== 'approved') events.push({ section: 'envelopes', action: 'إعادة فتح ظرف معتمد', target: lbl, details: '' });
      }
      for (const e of chk.removed) if (e.status === 'approved') events.push({ section: 'envelopes', action: 'حذف ظرف معتمد', target: { type: 'envelope', id: e.id, label: e.supplier || 'ظرف' }, details: '' });
    } else if (name === 'etadocs') {
      if (!Array.isArray(value) || value.length > 200000) bad('قائمة مستندات المنظومة غير صالحة');
      const seen = new Set();
      for (const d of value) {
        if (!isObj(d) || !str(String(d.uuid || ''), 100, 1) || seen.has(d.uuid)) bad('مستند غير صالح أو مكرر');
        seen.add(d.uuid);
        for (const k of ['total', 'net', 'vat']) if (d[k] != null && !Number.isFinite(Number(d[k]))) bad('قيمة مستند غير صالحة');
      }
    } else if (name === 'mappings') {
      if (!isObj(value) || Object.keys(value).length > 200000) bad('ذاكرة الربط غير صالحة');
    }
    await store.setCol(name, value);
    if (name === 'settings') refreshIdle();
    for (const ev of events) {
      if (typeof ev === 'string') await serverActivity(actor, 'settings', 'تعديل الإعدادات', { type: 'settings', id: 'settings', label: 'الإعدادات' }, ev);
      else await serverActivity(actor, ev.section, ev.action, ev.target, ev.details);
    }
    // الأظرف: نرجّع ما يختمه الخادم (المُعدّون/المعتمِد/آخر تعديل) لتتحدث الشاشة بدون إعادة تحميل
    const stamps = name === 'envelopes' ? Object.fromEntries(value.map((e) => [e.id, { preparers: e.preparers || [], createdBy: e.createdBy, createdAt: e.createdAt, updatedBy: e.updatedBy, updatedAt: e.updatedAt, approvedBy: e.approvedBy, approvedAt: e.approvedAt, reopenedBy: e.reopenedBy, reopenedAt: e.reopenedAt, cn: e.cn }])) : undefined;
    return json(res, 200, { rev: store.rev(name), stamps }, { ETag: `"${store.rev(name)}"` });
  }

  function parseJSON(text) { try { return JSON.parse(text); } catch (e) { throw new HttpError(400, 'JSON غير صالح', 'bad-json'); } }

  /* ===== التوجيه ===== */
  async function handle(req, res, p) {
    try {
      if (store.corrupt && p !== '/api/v2/status') throw new HttpError(503, 'ملف البيانات تالف: ' + store.corrupt, 'corrupt');
      // تغيّر الملف من خارج هذا الكيان (النسخة القديمة أو استرجاع): نعيد القراءة ونُنهي الجلسات
      if (store.externalChanged()) { store.loadSync(); store.lock(); sessions.destroyAll('تغيّر ملف البيانات من خارج الخادم'); closeStale(); }
      const m = req.method;

      if (p === '/api/v2/status' && m === 'GET') {
        const lock = readLock();
        return json(res, 200, { needsSetup: !store.hasUsers() && !store.corrupt, corrupt: store.corrupt || undefined, lockedUntil: lock.until > Date.now() ? lock.until : null, version, passwordMin: P.PASSWORD_MIN });
      }
      if (p === '/api/v2/setup' && m === 'POST') return await doSetup(req, res, parseJSON(await readBody(req, 300 * 1024)));
      if (p === '/api/v2/login' && m === 'POST') return await doLogin(req, res, parseJSON(await readBody(req, 8 * 1024)));

      // كل ما عدا ذلك يحتاج جلسة صالحة
      const sess = sessions.get(parseCookies(req.headers.cookie).einv_s);
      const actor = sess ? userFor(sess) : null;
      if (!actor) throw new HttpError(401, 'سجّل الدخول من جديد', 'unauthenticated');

      if (p === '/api/v2/logout' && m === 'POST') { sessions.destroy(actor.sid, 'تسجيل خروج'); return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie }); }
      if (p === '/api/v2/me' && m === 'GET') return json(res, 200, { user: publicMe(actor), idleMinutes, logId: sess.logId || null });
      // تذكيرات الراحة: إعدادات شخصية، كل مستخدم يقرأ ويعدّل إعداداته هو فقط
      if (p === '/api/v2/me/wellness') {
        const all = store.getCol('wellness', {});
        if (m === 'GET') {
          let value = Prayer.defaults();
          try { if (all[actor.id]) value = Prayer.clean(all[actor.id]); } catch (e) { /* إعدادات قديمة تالفة: الافتراضي */ }
          return json(res, 200, { value });
        }
        if (m === 'PUT') {
          const b = parseJSON(await readBody(req, 16 * 1024));
          const value = Prayer.clean(b && b.value);
          all[actor.id] = value;
          await store.setCol('wellness', all);
          return json(res, 200, { value });
        }
        throw new HttpError(405, 'الطريقة غير مدعومة', 'method');
      }

      let mm;
      if ((mm = p.match(/^\/api\/v2\/col\/([a-z]+)$/))) {
        if (m === 'GET') return await getCol(res, actor, mm[1]);
        if (m === 'PUT') return await putCol(req, res, actor, mm[1]);
        throw new HttpError(405, 'الطريقة غير مدعومة', 'method');
      }

      if (p === '/api/v2/users') {
        if (m === 'GET') {
          if (!actor.can('users')) deny();
          const pr = profilesOf();
          return json(res, 200, { value: store.data.users.map((u) => userRow(u, pr[u.id])) });
        }
        if (m === 'POST') return json(res, 200, await addUser(actor, parseJSON(await readBody(req, 16 * 1024))));
      }
      if ((mm = p.match(/^\/api\/v2\/users\/([A-Za-z0-9]{1,64})$/))) {
        if (m === 'PUT') { await updateUser(actor, mm[1], parseJSON(await readBody(req, 16 * 1024))); return json(res, 200, { ok: true }); }
        if (m === 'DELETE') { await deleteUser(actor, mm[1]); return json(res, 200, { ok: true }); }
      }
      if ((mm = p.match(/^\/api\/v2\/users\/([A-Za-z0-9]{1,64})\/password$/)) && m === 'POST') {
        await changePassword(actor, mm[1], parseJSON(await readBody(req, 16 * 1024)));
        return json(res, 200, { ok: true });
      }

      if (p === '/api/v2/activity') {
        if (m === 'GET') {
          const target = new URL(req.url, 'http://x').searchParams.get('target');
          // سجل ظرف أو عرض واحد: لأصحاب الأظرف/العروض. السجل الكامل: لصلاحية المستخدمين فقط
          if (target) {
            if (!['logs', 'envelopes', 'quotes', 'cn', 'reports'].some((k) => actor.can(k))) deny();
            if (!str(target, 100, 1)) bad('هدف غير صالح');
            return json(res, 200, { value: store.getCol('activity', []).filter((a) => a.targetId === target) });
          }
          if (!actor.can('logs')) deny();
          return json(res, 200, { value: store.getCol('activity', []) });
        }
        if (m === 'POST') {
          const b = parseJSON(await readBody(req, 32 * 1024));
          if (!isObj(b) || !SECTIONS.includes(b.section) || !str(b.action, 100, 1) || !str(b.details === undefined ? '' : b.details, 4000)) bad('سجل نشاط غير صالح');
          const t = isObj(b.target) ? b.target : null;
          if (t && (!str(t.type || '', 50) || !str(t.id || '', 100) || !str(t.label || '', 300))) bad('هدف السجل غير صالح');
          // الهوية والوقت من الجلسة على الخادم، ويتجاهل ما يرسله المتصفح
          await serverActivity(actor, b.section, b.action, t ? { type: t.type || '', id: t.id || '', label: t.label || '' } : null, b.details || '');
          return json(res, 200, { ok: true });
        }
      }
      if (p === '/api/v2/auditlog' && m === 'GET') { if (!actor.can('logs')) deny(); return json(res, 200, { value: store.log() }); }

      if ((mm = p.match(/^\/api\/v2\/img\/([A-Za-z0-9_-]{1,64})\/(\d{1,3})$/))) {
        const key = `img:${mm[1]}:${mm[2]}`;
        if (m === 'GET') { const v = store.getImg(key); if (!v) throw new HttpError(404, 'غير موجود', 'not-found'); return json(res, 200, v); }
        if (m === 'PUT') {
          if (!actor.can('quotes')) deny();
          const b = parseJSON(await readBody(req, 12 * 1024 * 1024));
          if (!isObj(b) || !['image/jpeg', 'image/png', 'image/webp'].includes(b.mime) || !str(b.data, 8 * 1024 * 1024, 1) || !/^[A-Za-z0-9+/=]+$/.test(b.data)) bad('صورة غير صالحة');
          await store.setImg(key, { mime: b.mime, data: b.data });
          return json(res, 200, { ok: true });
        }
        if (m === 'DELETE') { if (!actor.can('quotes')) deny(); await store.delImg(key); return json(res, 200, { ok: true }); }
      }

      /* إقفال/فتح فترة (شهر): للمدير فقط، والفتح يحتاج سبباً مكتوباً، ويُسجل في سجل النشاط */
      if (p === '/api/v2/period' && m === 'POST') {
        if (!actor.isAdmin) deny('إقفال وفتح الفترات للمدير فقط');
        const b = parseJSON(await readBody(req, 8 * 1024));
        if (!isObj(b) || !MONTH_RE.test(String(b.month)) || !['close', 'open'].includes(b.action)) bad('طلب غير صالح');
        const reason = String(b.reason || '').trim();
        if (!str(reason, 500)) bad('السبب طويل');
        const s = readSettings();
        const set = new Set(s.closedMonths);
        if (b.action === 'close') {
          if (set.has(b.month)) bad('الشهر مقفل بالفعل');
          const drafts = store.getCol('envelopes', []).filter((e) => e.month === b.month && e.status !== 'approved');
          if (drafts.length) throw new HttpError(409, `لا يمكن إقفال الشهر: فيه ${drafts.length} ظرف لم يُعتمد بعد`, 'drafts', { drafts: drafts.map((e) => e.supplier || e.id) });
          set.add(b.month);
        } else {
          if (!set.has(b.month)) bad('الشهر مفتوح بالفعل');
          if (reason.length < 3) bad('اكتب سبب فتح الفترة');
          set.delete(b.month);
        }
        s.closedMonths = [...set].sort();
        await store.setCol('settings', s);
        await serverActivity(actor, 'settings', b.action === 'close' ? 'إقفال فترة' : 'فتح فترة مقفلة', { type: 'settings', id: 'period-' + b.month, label: 'شهر ' + b.month }, reason);
        return json(res, 200, { closedMonths: s.closedMonths });
      }

      /* النسخ لمكان ثانٍ (للمدير): GET الحالة، PUT المسار، POST /test يتأكد أن النسخة تُقرأ وتُفك */
      if (p === '/api/v2/mirror') {
        if (!actor.isAdmin) deny('إعداد النسخ لمكان ثانٍ للمدير فقط');
        if (m === 'GET') return json(res, 200, { dir: store.mirrorDir, at: store.mirror.at || null, error: store.mirror.error || '' });
        if (m === 'PUT') {
          const b = parseJSON(await readBody(req, 8 * 1024));
          const dir = String((b && b.dir) || '').trim();
          if (dir && (!path.isAbsolute(dir) || dir.length > 400 || /[<>"|?*\u0000-\u001f]/.test(dir.replace(/^[A-Za-z]:/, '')))) bad('اكتب مساراً كاملاً صالحاً (مثلاً E:\\نسخ المطابقة)');
          if (dir && path.resolve(dir).toLowerCase().startsWith(path.resolve(dataDir).toLowerCase())) bad('اختر مكاناً خارج مجلد البيانات (فلاشة أو قرص آخر أو OneDrive)');
          store.mirrorDir = dir ? path.resolve(dir) : '';
          store.mirror = { at: 0, error: '' };
          fs.writeFileSync(MIRROR_FILE, JSON.stringify({ dir: store.mirrorDir }));
          if (store.mirrorDir) await store.mirrorNow(true);
          await serverActivity(actor, 'settings', 'تعديل النسخ لمكان ثانٍ', { type: 'settings', id: 'mirror', label: 'النسخ الاحتياطي' }, store.mirrorDir || 'تم الإيقاف');
          return json(res, 200, { dir: store.mirrorDir, at: store.mirror.at || null, error: store.mirror.error || '' });
        }
      }
      if (p === '/api/v2/mirror/test' && m === 'POST') {
        if (!actor.isAdmin) deny();
        if (!store.mirrorDir) bad('لم يتم تحديد مكان النسخ');
        await store.flush();
        await store.mirrorNow(true);
        if (store.mirror.error) return json(res, 200, { ok: false, message: 'تعذر الكتابة في المكان المحدد: ' + store.mirror.error });
        try {
          const obj = parseBackup(fs.readFileSync(path.join(store.mirrorDir, 'einvoice-data.einv'), 'utf8'));
          const box = obj.data['c:settings'];
          if (!box) throw new Error('النسخة لا تحتوي بيانات');
          C.decryptJSON(store.master, box); // تُفك بنفس المفتاح = نسخة صالحة للاسترجاع
          const days = fs.existsSync(path.join(store.mirrorDir, 'نسخ يومية')) ? fs.readdirSync(path.join(store.mirrorDir, 'نسخ يومية')).length : 0;
          return json(res, 200, { ok: true, users: obj.data.users.length, days, at: store.mirror.at });
        } catch (e) { return json(res, 200, { ok: false, message: 'النسخة لا تُقرأ: ' + e.message }); }
      }

      if (p === '/api/v2/info' && m === 'GET') {
        if (!actor.can('backup')) deny();
        return json(res, 200, { dataDir, version, hasData: fs.existsSync(store.file) });
      }
      if (p === '/api/v2/open-folder' && m === 'POST') {
        if (!actor.can('backup')) deny();
        fs.mkdirSync(dataDir, { recursive: true });
        if (openFolder) openFolder(dataDir);
        return json(res, 200, { ok: true });
      }

      if (p === '/api/v2/backup' && m === 'GET') {
        if (!actor.can('backup')) deny();
        await store.flush();
        await serverActivity(actor, 'users', 'تصدير نسخة احتياطية', { type: 'settings', id: 'backup', label: 'النسخ الاحتياطي' }, '');
        await store.flush();
        const buf = fs.readFileSync(store.file);
        return json(res, 200, buf, { 'Content-Disposition': 'attachment; filename="einvoice-backup.einv"' }, 'application/octet-stream');
      }
      if (p === '/api/v2/restore' && m === 'POST') {
        if (!actor.isAdmin) deny('استرجاع نسخة احتياطية للمدير فقط');
        const text = await readBody(req, 400 * 1024 * 1024);
        const obj = parseBackup(text);
        await store.flush();
        const safety = await store.safetyCopy(path.join(dataDir, 'نسخ أمان'));
        await store.writeRaw(text);
        const who = { username: actor.username, displayName: actor.displayName };
        store.loadSync(); store.lock(); sessions.destroyAll('استرجاع نسخة احتياطية');
        store.appendLog({ id: uid(), type: 'restore', at: Date.now(), knownUser: true, backupDate: obj.exportedAt, deviceId: DEVICE_ID, deviceLabel: HOST, ip: '', ...deviceInfo(req), screen: '', ...who });
        await store.flush();
        return json(res, 200, { ok: true, safetyCopy: safety, needsLogin: true }, { 'Set-Cookie': clearCookie });
      }

      /* الذكاء الاصطناعي: الخادم يتصل بالمزود بالمفتاح المحفوظ */
      if (p === '/api/v2/ai/status' && m === 'GET') {
        const s = readSettings();
        const prov = {};
        for (const k of AI_PROVIDERS) prov[k] = { hasKey: !!s.ai[k].key, model: s.ai[k].model };
        return json(res, 200, { active: s.ai.active, providers: prov });
      }
      if (p === '/api/v2/ai/call' && m === 'POST') {
        if (!(actor.can('envelopes') || actor.can('quotes') || actor.can('settingsAi'))) deny();
        const b = parseJSON(await readBody(req, 40 * 1024 * 1024));
        if (!isObj(b)) bad('طلب غير صالح');
        const images = AIP.checkInput(b);
        const r = aiRate.get(actor.sid) || { n: 0, reset: Date.now() + 10 * 60000 };
        if (Date.now() > r.reset) { r.n = 0; r.reset = Date.now() + 10 * 60000; }
        if (++r.n > 120) throw new HttpError(429, 'عدد طلبات الذكاء الاصطناعي كبير، حاول بعد قليل', 'rate-limit');
        aiRate.set(actor.sid, r);
        const s = readSettings();
        const key = s.ai[b.provider].key;
        if (!key) return json(res, 200, { ok: false, status: 400, message: 'لم يتم إدخال مفتاح API لهذا النموذج — من الإعدادات' });
        const model = b.model || s.ai[b.provider].model;
        return json(res, 200, await AIP.callProvider({ provider: b.provider, key, model, system: b.system, prompt: b.prompt, images }));
      }

      /* منظومة الضرائب: الاعتمادات من الإعدادات المحفوظة على الخادم، ولا يرسلها المتصفح */
      if (p === '/api/v2/eta/status' && m === 'GET') {
        const e = readSettings().eta;
        return json(res, 200, { ready: !!(e.clientId && e.clientSecret), env: e.env });
      }
      if ((p === '/api/v2/eta' || p === '/api/v2/eta/test') && m === 'POST') {
        const test = p.endsWith('/test');
        if (test ? !actor.can('settingsEta') : !(actor.can('envelopes') || actor.can('cn'))) deny();
        const b = parseJSON(await readBody(req, 100000));
        const e = readSettings().eta;
        if (!e.clientId || !e.clientSecret) throw new HttpError(400, 'أدخل Client ID و Client Secret من الإعدادات', 'eta-not-configured');
        try {
          if (test) { await ETA.etaToken(e.env, e.clientId, e.clientSecret, true); return json(res, 200, { ok: true }); }
          return json(res, 200, await ETA.etaRequest({ env: e.env, clientId: e.clientId, clientSecret: e.clientSecret, path: b.path, query: b.query }));
        } catch (err) {
          if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|aborted|timeout/i.test(String(err.message) + String(err.cause && err.cause.code))) throw err;
          return json(res, 200, { ok: false, status: err.status || 500, message: err.message });
        }
      }

      throw new HttpError(404, 'غير موجود', 'not-found');
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.code, message: e.message, ...(e.extra || {}) });
      const network = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|aborted|timeout/i.test(String(e.message) + String(e.cause && e.cause.code));
      if (network) return json(res, 502, { error: 'network', message: 'تعذر الاتصال بالخدمة الخارجية' });
      const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
      return json(res, status, { error: e.code || 'server', message: status === 500 ? 'خطأ داخلي في الخادم' : e.message });
    }
  }

  return { handle, sessions, store };
}

module.exports = { createApi2, mergeSettings, sanitizeSettings, defaultSettings, checkEnvelopes };
