/* هيكل التطبيق: الدخول، التهيئة الأولى، القائمة، التنقل */
'use strict';

const App = { lastActivity: Date.now() };

App.root = () => document.getElementById('app');

App.start = async () => {
  clearInterval(App._lockTimer);
  let st;
  try { st = await DB.status(); App.version = st.version || ''; }
  catch (e) {
    U.fill(App.root(), App.authBox(
      h('div', { class: 'notice bad', style: 'line-height:1.9' }, 'تعذر الاتصال بالبرنامج. شغّل البرنامج من الاختصار "مطابقة فواتير الموردين" (وليس من ملف الصفحة مباشرة) ثم حدّث الصفحة.'),
      h('button', { type: 'button', class: 'btn primary', onClick: () => App.start() }, 'إعادة المحاولة')));
    return;
  }
  if (st.corrupt) {
    U.fill(App.root(), App.authBox(
      h('div', { class: 'notice bad', style: 'line-height:1.9' }, 'ملف البيانات تالف ولن يُكتب فوقه حفاظاً على بياناتك: ' + st.corrupt),
      h('div', { class: 'small muted' }, 'استرجع آخر نسخة من مجلد "نسخ يومية" داخل مجلد البيانات (انسخها مكان einvoice-data.einv) ثم أعد تشغيل البرنامج.')));
    return;
  }
  if (st.needsSetup) return App.setup();
  // جلسة قائمة (إعادة تحميل الصفحة): نكمل بدون طلب كلمة المرور من جديد
  if (await DB.resume()) return App.enter();
  App.login(st);
};

App.authBox = (...kids) => h('div', { class: 'auth' }, h('form', { class: 'box', onSubmit: (e) => e.preventDefault() },
  h('div', { class: 'row', style: 'gap:10px' }, U.icon('<path d="M6 3h9l4 4v14H6z"></path><path d="M14 3v5h5"></path><path d="M9 13l2 2 4-4"></path>', 30, '#1D4ED8'), h('h1', { style: 'font-size:22px' }, 'مطابقة فواتير الموردين')),
  ...kids,
  App.version ? h('div', { class: 'small muted', style: 'text-align:center' }, 'الإصدار ' + App.version) : null));

App.setup = () => {
  const user = h('input', { class: 'input', autocomplete: 'username', value: 'admin' });
  const name = h('input', { class: 'input' });
  const p1 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const p2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const err = h('div', { class: 'err', role: 'alert' });
  U.fill(App.root(), App.authBox(
    h('div', { class: 'notice info' }, 'أول تشغيل: أنشئ حساب مدير النظام. كلمة المرور تفتح قاعدة البيانات المشفرة، فاحفظها جيداً.'),
    h('label', { class: 'field' }, 'اسم الدخول', user),
    h('label', { class: 'field' }, 'الاسم الظاهر', name),
    h('label', { class: 'field' }, 'كلمة المرور (8 خانات على الأقل، فيها حرف ورقم)', p1),
    h('label', { class: 'field' }, 'تأكيد كلمة المرور', p2),
    err,
    h('button', {
      type: 'submit', class: 'btn primary', onClick: async () => {
        err.textContent = '';
        if (!user.value.trim()) return (err.textContent = 'أدخل اسم الدخول');
        if (!DB.validPassword(p1.value)) return (err.textContent = DB.passwordIssue(p1.value));
        if (p1.value !== p2.value) return (err.textContent = 'كلمتا المرور غير متطابقتين');
        const b = U.busy('تجهيز قاعدة البيانات المشفرة...');
        try { await DB.setup(user.value, name.value.trim(), p1.value); App.enter(); }
        catch (e) { err.textContent = e.message; } finally { b.done(); }
      },
    }, 'إنشاء الحساب والدخول'),
    h('div', { class: 'small muted' }, 'عندك بيانات سابقة؟ أغلق البرنامج وانسخ ملف einvoice-data.einv داخل مجلد البيانات، ثم شغّله من جديد وسجّل الدخول بمستخدمك القديم.')));
};

App.login = async (st) => {
  const user = h('input', { class: 'input', autocomplete: 'off', name: 'einv-login-' + Math.random().toString(36).slice(2), autocapitalize: 'off', spellcheck: 'false' });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', name: 'einv-pass-' + Math.random().toString(36).slice(2) });
  const err = h('div', { class: 'err', role: 'alert' });
  const lockBox = h('div', { class: 'lock hidden', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'btn primary' }, 'دخول');
  let timer = null;
  const showLock = (until) => {
    clearInterval(timer);
    const tick = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      if (left <= 0) { clearInterval(timer); lockBox.classList.add('hidden'); btn.disabled = false; err.textContent = ''; return; }
      lockBox.classList.remove('hidden');
      lockBox.textContent = `تم إيقاف الدخول بعد 4 محاولات خاطئة. حاول مرة أخرى بعد ${left} ثانية`;
      btn.disabled = true;
    };
    tick();
    timer = setInterval(tick, 500);
  };
  btn.addEventListener('click', async () => {
    err.textContent = '';
    if (!user.value.trim() || !pass.value) return (err.textContent = 'أدخل اسم الدخول وكلمة المرور');
    btn.disabled = true;
    const r = await DB.login(user.value, pass.value);
    btn.disabled = false;
    if (r.ok) { clearInterval(timer); return App.enter(); }
    pass.value = '';
    if (r.lockedUntil) showLock(r.lockedUntil);
    else if (r.left != null) err.textContent = `بيانات الدخول غير صحيحة — متبقي ${r.left} محاولة قبل الإيقاف المؤقت`;
    else err.textContent = r.message || 'تعذر الدخول';
  });
  U.fill(App.root(), App.authBox(h('label', { class: 'field' }, 'اسم الدخول', user), h('label', { class: 'field' }, 'كلمة المرور', pass), lockBox, err, btn));
  if (st && st.lockedUntil && st.lockedUntil > Date.now()) showLock(st.lockedUntil);
  user.focus();
};

/* أول شاشة حسب صلاحيات المستخدم */
App.home = () => (DB.can('envelopes') ? '#/envelopes' : DB.can('cn') ? '#/credit-notes' : DB.can('reports') ? '#/reports/restaurants' : '#/quotes');

App.enter = () => {
  App.lastActivity = Date.now();
  if (!location.hash || location.hash === '#/') location.hash = App.home();
  App.route();
};

App.NAV = [
  ['#/envelopes', 'أظرف الموردين', 'envelopes'],
  ['#/eta-docs', 'فواتير المنظومة', ['envelopes', 'reports', 'cn']],
  ['#/credit-notes', 'متابعة الإشعارات الدائنة', 'cn'],
  ['#/reports/restaurants', 'استهلاك المطاعم', 'reports'],
  ['#/reports/41', 'التقارير', 'reports'],
  ['#/quotes', 'أرشيف عروض الأسعار', null],
  ['#/settings/mappings', 'ذاكرة ربط الأصناف', 'mappings'],
  ['#/settings', 'الإعدادات والمستخدمين', null],
];

App.route = async () => {
  if (!DB.user) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const [name, arg] = parts;
  let view;
  try {
    if (name === 'envelopes' && DB.can('envelopes')) view = await Envelopes.list();
    else if (name === 'envelope' && DB.can('envelopes')) view = await Envelopes.view(arg);
    else if (name === 'report' && (DB.can('envelopes') || DB.can('cn') || DB.can('reports'))) view = await Envelopes.report(arg);
    else if (name === 'eta-docs' && ['envelopes', 'reports', 'cn'].some((k) => DB.can(k))) view = await EtaDocs.view();
    else if (name === 'credit-notes' && DB.can('cn')) view = await Reports.creditNotes();
    else if (name === 'reports' && DB.can('reports')) view = await Reports.view(arg);
    else if (name === 'quotes') view = await Quotes.archive();
    else if (name === 'quote') view = await Quotes.view(arg);
    else if (name === 'settings') view = await Settings.view(arg);
    else { location.hash = App.home(); return; }
  } catch (e) {
    if (!DB.user) return; // انتهت الجلسة: onExpired يعرض شاشة الدخول
    console.error(e);
    view = h('div', { class: 'notice bad' }, 'حدث خطأ: ' + e.message);
  }
  if (!DB.user) return;
  const active = '#/' + name;
  const nav = h('nav', { class: 'nav', 'aria-label': 'القائمة الرئيسية' },
    h('div', { class: 'brand' }, U.icon('<path d="M6 3h9l4 4v14H6z"></path><path d="M14 3v5h5"></path><path d="M9 13l2 2 4-4"></path>', 28, '#1D4ED8'), 'مطابقة الفواتير'),
    App.today(),
    App.NAV.filter(([, , perm]) => !perm || [].concat(perm).some((k) => DB.can(k))).map(([href, label]) => {
      const isActive = href === location.hash || (href === '#/envelopes' && ['#/envelope', '#/report'].includes(active)) || (href === '#/quotes' && active === '#/quote') ||
        (href === '#/settings' && active === '#/settings' && location.hash !== '#/settings/mappings') ||
        (href === '#/reports/restaurants' && location.hash === '#/reports') ||
        (href === '#/reports/41' && active === '#/reports' && !['#/reports', '#/reports/restaurants'].includes(location.hash));
      return h('a', { href, class: isActive ? 'active' : '' }, label);
    }),
    h('div', { class: 'who' },
      App.storeStatus(),
      h('div', null, `${DB.user.displayName} · ${DB.user.role === 'admin' ? 'مدير' : 'مراجع'}`),
      h('button', { type: 'button', onClick: async () => { await DB.signOut(); location.hash = ''; App.start(); } }, 'تسجيل الخروج')));
  const weakWarn = DB.user.weakPassword
    ? h('div', { class: 'notice bad row no-print' }, h('span', { style: 'flex:1 1 300px' }, 'كلمة مرورك قديمة وضعيفة (أقل من 8 خانات أو بدون حرف ورقم). غيّرها لحماية بياناتك.'),
      h('a', { class: 'btn primary sm', href: '#/settings/account' }, 'تغيير كلمة المرور'))
    : null;
  U.fill(App.root(), h('div', { class: 'shell' }, nav, h('main', { class: 'main', id: 'main' }, weakWarn, view)));
  window.scrollTo(0, 0);
};

/* التنقل بين الصفحات يقرأ البيانات من جديد (لو عدّل مستخدم آخر شيئاً) */
window.addEventListener('hashchange', () => { DB.invalidate(); App.route(); });
for (const ev of ['mousemove', 'keydown', 'click', 'scroll']) window.addEventListener(ev, () => { App.lastActivity = Date.now(); }, { passive: true });

/* انتهت الجلسة على الخادم (خمول، أو غيّر أحد كلمة المرور، أو حُذف الحساب) */
DB.onExpired = () => { U.toast('انتهت الجلسة — سجّل الدخول من جديد'); location.hash = ''; App.start(); };

/* أي خطأ حفظ/اتصال لم يعالجه الكود يظهر للمستخدم بدل أن يضيع في الكونسول */
window.addEventListener('unhandledrejection', (ev) => {
  const e = ev.reason;
  if (!e || !e.message) return;
  ev.preventDefault();
  if (e.status === 401 && !DB.user) return; // onExpired يتولى الأمر
  console.error(e);
  U.toast(e.message, 'err');
  if (e.code === 'conflict') setTimeout(() => App.route(), 800);
});

/* خروج تلقائي بعد عدم نشاط المستخدم (الخادم ينهي الجلسة أيضاً بمدة خمول مستقلة) */
setInterval(async () => {
  if (!DB.user) return;
  if (Date.now() - App.lastActivity > (DB.idleMinutes || 30) * 60000) {
    await DB.signOut();
    U.toast('تم تسجيل الخروج تلقائياً لعدم النشاط');
    App.start();
  }
}, 30000);

// نبضة كل دقيقة: تُبقي الجلسة حيّة على الخادم طالما المستخدم نشط، وتُبقي الخادم المحلي يعمل طالما النافذة مفتوحة
setInterval(() => {
  if (DB.user && Date.now() - App.lastActivity < 5 * 60000) DB.touchSession();
  else DB.api('/api/v2/status').catch(() => {});
}, 60000);

// طلب تأكيد قبل إغلاق البرنامج طالما المستخدم داخل (أو فيه حفظ جارٍ)
window.addEventListener('beforeunload', (e) => {
  if (DB.user || DB.Save.pending > 0) { e.preventDefault(); e.returnValue = ''; }
});

/* تاريخ اليوم (بتوقيت القاهرة) — يتحدث كل دقيقة ويقلب لليوم الجديد تلقائياً */
App.todayText = () => {
  const d = new Date();
  const opt = { timeZone: 'Africa/Cairo' };
  const day = d.toLocaleDateString('ar-EG-u-nu-latn', Object.assign({ weekday: 'long' }, opt));
  const date = d.toLocaleDateString('ar-EG-u-nu-latn', Object.assign({ day: 'numeric', month: 'long', year: 'numeric' }, opt));
  const time = d.toLocaleTimeString('ar-EG-u-nu-latn', Object.assign({ hour: 'numeric', minute: '2-digit' }, opt));
  return { day, date, time };
};
App.today = () => {
  const dayEl = h('div', { style: 'font-weight:600;color:var(--ink)' });
  const dateEl = h('div', { class: 'small', style: 'color:var(--muted)' });
  const box = h('div', { style: 'padding:0 12px 16px;margin-bottom:6px;border-bottom:1px solid var(--line)', 'aria-label': 'تاريخ اليوم' }, dayEl, dateEl);
  const paint = () => { const t = App.todayText(); dayEl.textContent = t.day; dateEl.textContent = `${t.date} · ${t.time}`; };
  paint();
  clearInterval(App._todayTimer);
  App._todayTimer = setInterval(paint, 30000);
  return box;
};

/* مؤشر الحفظ (أسفل القائمة): كل تعديل يُحفظ على الخادم فوراً */
App.storeStatus = () => {
  const el = h('div', { class: 'small', 'aria-live': 'polite', style: 'line-height:1.6' });
  const paint = () => {
    const S = DB.Save;
    if (S.error) { el.style.color = 'var(--danger)'; el.textContent = `تعذر الحفظ: ${S.error}`; return; }
    el.style.color = 'var(--accent-dark)';
    el.textContent = S.pending > 0 ? 'جاري الحفظ على الجهاز...' : `✓ محفوظ على الجهاز${S.lastSaved ? ' · ' + new Date(S.lastSaved).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}`;
  };
  DB.Save.listeners = [paint];
  paint();
  return el;
};

window.addEventListener('DOMContentLoaded', App.start);
