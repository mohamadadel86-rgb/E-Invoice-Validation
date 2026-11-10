/* طبقة البيانات: عميل رفيع للخادم المحلي (/api/v2)
 * - الدخول والجلسات والصلاحيات والتشفير وسجل الدخول كلها على الخادم؛ المتصفح يحمل كوكي جلسة (HttpOnly) فقط.
 * - DB.user و DB.can للعرض فقط (إخفاء الأزرار)؛ الخادم يرفض أي إجراء غير مسموح مهما فعل المتصفح.
 * - الأسرار (مفاتيح الذكاء الاصطناعي وClient Secret) تُكتب ولا تُقرأ: الخادم يرجع hasKey / hasSecret فقط.
 */
'use strict';

const DB = {
  user: null,        // {id, username, displayName, role, perms, weakPassword}
  sessionId: null,   // رقم سجل جلسة الدخول الحالية (للعرض في سجل الدخول)
  idleMinutes: 30,
  _cache: {},
  _revs: {},
  onExpired: null,   // تُستدعى مرة واحدة لو انتهت الجلسة أثناء العمل
};

/* صلاحية منفصلة لكل بند (نفس قائمة الخادم server/policy.js) مقسّمة في مجموعات لنموذج المستخدم */
DB.PERM_GROUPS = [
  ['أظرف الموردين', [['envelopes', 'مراجعة الأظرف (فتح ظرف، إضافة فواتير، المطابقة، المستلم، توزيع المطاعم)'], ['approve', 'اعتماد الأظرف وإعادة فتحها'], ['envDelete', 'حذف الأظرف قيد المراجعة'], ['cn', 'متابعة الإشعارات الدائنة والسداد']]],
  ['التقارير', [['reports', 'التقارير ولوحة استهلاك المطاعم ونموذج 41']]],
  ['عروض الأسعار', [['quotes', 'رفع وتعديل واعتماد عروض الأسعار'], ['mappings', 'ذاكرة ربط الأصناف']]],
  ['الإعدادات', [['settingsAi', 'إعدادات الذكاء الاصطناعي'], ['settingsEta', 'ربط منظومة الضرائب'], ['settingsGeneral', 'أنواع التوريد والمطاعم والإعدادات العامة']]],
  ['الإدارة', [['users', 'إدارة المستخدمين'], ['logs', 'سجل الدخول وسجل النشاط'], ['backup', 'النسخ الاحتياطي ومجلد البيانات']]],
];
DB.ALL_PERMS = Object.fromEntries(DB.PERM_GROUPS.flatMap(([, items]) => items));

/* سياسة كلمة المرور (للتنبيه الفوري في الواجهة فقط؛ الخادم يفرضها بنفس القواعد):
 * 8 خانات على الأقل، فيها حرف ورقم، وليست من الكلمات الشائعة. */
DB.PASSWORD_MIN = 8;
DB.PASSWORD_MAX = 128;
DB.COMMON_PASSWORDS = new Set(['12345678', '123456789', '1234567890', '12341234', '87654321', 'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty123', 'qwertyuiop1', 'qwerty1234', 'abcd1234', 'abc12345', 'abc123456', 'a1234567', 'aa123456', 'admin123', 'admin1234', 'admin12345', 'letmein123', 'welcome123', 'iloveyou1', 'pass1234', 'test1234', 'user1234', 'default123', 'changeme1']);
DB.passwordIssue = (p) => {
  if (typeof p !== 'string') return 'كلمة المرور غير صالحة';
  if (p.length < DB.PASSWORD_MIN) return `كلمة المرور ${DB.PASSWORD_MIN} خانات على الأقل، وفيها حرف ورقم`;
  if (p.length > DB.PASSWORD_MAX) return `كلمة المرور أطول من ${DB.PASSWORD_MAX} خانة`;
  if (!/\p{L}/u.test(p) || !/\p{N}/u.test(p)) return 'كلمة المرور لازم تحتوي على حرف ورقم على الأقل';
  if (DB.COMMON_PASSWORDS.has(p.toLowerCase())) return 'كلمة المرور شائعة وسهلة التخمين، اختر غيرها';
  return '';
};
DB.validPassword = (p) => !DB.passwordIssue(p);

/* ===== الاتصال بالخادم ===== */
DB.api = (p, opts) => fetch(p, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opts, { headers: Object.assign({ 'X-EInvoice-App': '1' }, (opts && opts.headers) || {}) }));

/* حالة الحفظ (لمؤشر "محفوظ" أسفل القائمة) */
DB.Save = { pending: 0, lastSaved: null, error: '', listeners: [] };
DB.Save.notify = () => { for (const f of DB.Save.listeners) try { f(); } catch (e) { /* */ } };

DB._expiredOnce = false;
/* method, path, body (كائن → JSON، أو نص خام لو raw)، extra: ترويسات إضافية. يرجع JSON، أو {text} لو الرد ليس JSON */
DB.call = async (method, path, body, extra) => {
  const headers = Object.assign({}, extra || {});
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') { payload = body; headers['Content-Type'] = headers['Content-Type'] || 'text/plain'; }
    else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  }
  let res;
  try { res = await DB.api(path, { method, headers, body: payload }); }
  catch (e) { throw Object.assign(new Error('تعذر الاتصال بالبرنامج — تأكد أنه شغال (شغّله من الاختصار "مطابقة فواتير الموردين")'), { code: 'offline' }); }
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) { /* ليس JSON */ }
  if (res.ok) return j === null ? { text } : j;
  const err = Object.assign(new Error((j && j.message) || `خطأ ${res.status}`), { status: res.status, code: (j && j.error) || 'error', data: j || {} });
  const authPath = /^\/api\/v2\/(login|setup|status|logout)$/.test(path);
  if (res.status === 401 && !authPath && DB.user) {
    // الجلسة انتهت (خمول، أو حُذف الحساب، أو تغيّرت كلمة المرور من مكان آخر)
    DB.user = null; DB._cache = {}; DB._revs = {};
    err.message = 'انتهت الجلسة — سجّل الدخول من جديد';
    if (DB.onExpired && !DB._expiredOnce) { DB._expiredOnce = true; setTimeout(() => { DB._expiredOnce = false; DB.onExpired(); }, 0); }
  }
  throw err;
};

/* ===== الحالة والدخول ===== */
DB.status = () => DB.call('GET', '/api/v2/status');

DB._setUser = (r) => {
  DB.user = r.user;
  DB.idleMinutes = r.idleMinutes || DB.idleMinutes;
  if (r.logId !== undefined) DB.sessionId = r.logId;
  DB._cache = {}; DB._revs = {};
};
/* جلسة قائمة؟ (بعد إعادة تحميل الصفحة) */
DB.resume = async () => {
  try { DB._setUser(await DB.call('GET', '/api/v2/me')); return true; } catch (e) { if (e.status === 401) return false; throw e; }
};
DB.refreshMe = async () => {
  const r = await DB.call('GET', '/api/v2/me');
  DB.user = r.user; DB.idleMinutes = r.idleMinutes || DB.idleMinutes; if (r.logId !== undefined) DB.sessionId = r.logId;
};
DB.touchSession = () => DB.refreshMe().catch(() => {});

DB.setup = async (username, displayName, password) => {
  if (!DB.validPassword(password)) throw new Error(DB.passwordIssue(password));
  const r = await DB.call('POST', '/api/v2/setup', { username, displayName, password });
  DB._setUser(r);
  await DB.refreshMe();
};

/* يرجع {ok:true} أو {ok:false, lockedUntil} أو {ok:false, left} أو {ok:false, message} */
DB.login = async (username, password) => {
  try {
    const r = await DB.call('POST', '/api/v2/login', { username, password });
    DB._setUser(r);
    await DB.refreshMe();
    return { ok: true };
  } catch (e) {
    if (e.status === 429) return { ok: false, lockedUntil: e.data.until };
    if (e.status === 401) return { ok: false, left: e.data.left };
    return { ok: false, message: e.message };
  }
};

DB.logout = () => { DB.user = null; DB.sessionId = null; DB._cache = {}; DB._revs = {}; };
/* خروج: الخادم ينهي الجلسة ويسجل سبب الإنهاء */
DB.signOut = async () => {
  try { await DB.call('POST', '/api/v2/logout', {}); } catch (e) { /* لا يمنع الخروج */ }
  DB.logout();
};

DB.can = (perm) => !!(DB.user && (DB.user.role === 'admin' || DB.user.perms[perm]));

/* ===== مجموعات البيانات (الخادم يشفرها ويفرض الصلاحيات) ===== */
DB.invalidate = () => { DB._cache = {}; DB._revs = {}; };

DB.load = async (name, def) => {
  if (name in DB._cache) return DB._cache[name];
  const r = await DB.call('GET', '/api/v2/col/' + encodeURIComponent(name));
  const val = r.value == null && def !== undefined ? def : r.value;
  DB._cache[name] = val;
  DB._revs[name] = r.rev;
  return val;
};

DB.save = async (name, val) => {
  const headers = DB._revs[name] != null ? { 'If-Match': `"${DB._revs[name]}"` } : {};
  DB.Save.pending++; DB.Save.notify();
  try {
    const r = await DB.call('PUT', '/api/v2/col/' + encodeURIComponent(name), { value: val }, headers);
    DB._revs[name] = r.rev;
    DB._cache[name] = val;
    // أختام الخادم على الأظرف (من أعدّ/اعتمد/عدّل) تُطبق على نفس الكائنات المعروضة
    if (r.stamps && Array.isArray(val)) for (const e of val) {
      const st = e && r.stamps[e.id];
      if (!st) continue;
      // البنود التي جمّدها الخادم عند الاعتماد (أو فكّ تجميدها عند إعادة الفتح): {معرّف الفاتورة: {رقم البند: الصنف أو null}}
      if (st.fz) for (const inv of e.invoices || []) {
        const m = st.fz[inv.id];
        if (m) for (const l of inv.lines || []) { if (m[l.n]) l.fz = m[l.n]; else delete l.fz; }
      }
      delete st.fz;
      Object.assign(e, st);
    }
    // الإعدادات: الخادم دمجها وأخفى الأسرار؛ نعيد قراءتها حتى لا يبقى أي سر في ذاكرة الصفحة
    if (name === 'settings') { delete DB._cache.settings; delete DB._revs.settings; }
    DB.Save.lastSaved = Date.now(); DB.Save.error = '';
  } catch (e) {
    DB.Save.error = e.message;
    if (e.status === 409) {
      delete DB._cache[name]; delete DB._revs[name];
      throw Object.assign(new Error('تم تعديل هذه البيانات من مستخدم آخر أو من نافذة أخرى. أعد تحميل الصفحة ثم كرّر تعديلك حتى لا يضيع شغل أحد.'), { status: 409, code: 'conflict' });
    }
    throw e;
  } finally { DB.Save.pending--; DB.Save.notify(); }
};

/* حفظ الإعدادات مع تحديث الكائن الموجود في الذاكرة (الذي تحمله شاشة الإعدادات) بالنسخة الصافية من الخادم */
DB.saveSettings = async (s) => {
  await DB.save('settings', s);
  const fresh = await DB.load('settings');
  for (const k of Object.keys(s)) delete s[k];
  Object.assign(s, fresh);
};

/* ===== المستخدمون (للمدير / صاحب صلاحية المستخدمين) ===== */
DB.users = async () => (await DB.call('GET', '/api/v2/users')).value;
DB.addUser = async ({ username, displayName, password, role, perms }) => {
  if (!DB.validPassword(password)) throw new Error(DB.passwordIssue(password));
  return (await DB.call('POST', '/api/v2/users', { username, displayName, password, role, perms })).id;
};
DB.updateUser = async (id, { displayName, role, perms, password }) => {
  if (password && !DB.validPassword(password)) throw new Error(DB.passwordIssue(password));
  await DB.call('PUT', '/api/v2/users/' + encodeURIComponent(id), { displayName, role, perms, password: password || undefined });
  if (id === DB.user.id) await DB.refreshMe().catch(() => {});
};
DB.setPassword = async (id, password, oldPassword) => {
  if (!DB.validPassword(password)) throw new Error(DB.passwordIssue(password));
  await DB.call('POST', `/api/v2/users/${encodeURIComponent(id)}/password`, { password, oldPassword });
  if (id === DB.user.id) await DB.refreshMe().catch(() => {});
};
DB.deleteUser = (id) => DB.call('DELETE', '/api/v2/users/' + encodeURIComponent(id));

/* ===== السجلات (يكتبها الخادم) ===== */
DB.readLog = async () => (await DB.call('GET', '/api/v2/auditlog')).value;

/* ===== صور صفحات عروض الأسعار ===== */
DB.putImage = (quoteId, i, img) => DB.call('PUT', `/api/v2/img/${encodeURIComponent(quoteId)}/${i}`, { mime: img.mime, data: img.data });
DB.getImage = async (quoteId, i) => {
  try { return await DB.call('GET', `/api/v2/img/${encodeURIComponent(quoteId)}/${i}`); } catch (e) { if (e.status === 404) return null; throw e; }
};
DB.delImage = (quoteId, i) => DB.call('DELETE', `/api/v2/img/${encodeURIComponent(quoteId)}/${i}`);

/* ===== النسخ الاحتياطي ===== */
DB.exportBackup = async () => {
  const res = await DB.api('/api/v2/backup');
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || 'تعذر التصدير');
  return new Blob([await res.arrayBuffer()], { type: 'application/octet-stream' });
};
/* الاسترجاع للمدير فقط؛ الخادم يأخذ نسخة أمان أولاً ثم يُنهي كل الجلسات */
DB.importBackup = async (text) => {
  await DB.call('POST', '/api/v2/restore', text);
  DB.logout();
};
