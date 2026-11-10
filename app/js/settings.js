/* الإعدادات: الذكاء الاصطناعي، أنواع التوريد والضرائب، المستخدمين، ذاكرة الربط، النسخ الاحتياطي */
'use strict';

const Settings = {};

Settings.defaults = () => ({
  ai: {
    active: 'gemini',
    gemini: { key: '', model: AI.PROVIDERS.gemini.defaultModel },
    claude: { key: '', model: AI.PROVIDERS.claude.defaultModel },
    openai: { key: '', model: AI.PROVIDERS.openai.defaultModel },
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
});

Settings.catName = (id, s) => {
  const c = (s.categories || []).find((x) => x.id === id);
  return c ? c.name : id;
};
Settings.vatLabel = (v) => (v == null ? 'غير محدد' : v + '%');

Settings.view = async (tab) => {
  const s = await DB.load('settings');
  const tabs = [
    ['account', 'حسابي', true],
    ['ai', 'الذكاء الاصطناعي', DB.can('settingsAi')],
    ['categories', 'أنواع التوريد والضرائب', DB.can('settingsGeneral')],
    ['restaurants', 'المطاعم', DB.can('settingsGeneral')],
    ['eta', 'ربط الضرائب', DB.can('settingsEta')],
    ['mappings', 'ذاكرة ربط الأصناف', DB.can('mappings')],
    ['periods', 'إقفال الفترات', DB.can('settingsGeneral') || DB.can('approve') || DB.user.role === 'admin'],
    ['users', 'المستخدمين', DB.can('users')],
    ['log', 'سجل الدخول', DB.can('logs')],
    ['activity', 'سجل النشاط', DB.can('logs')],
    ['backup', 'مجلد البيانات والنسخ', DB.can('backup')],
  ].filter((t) => t[2]);
  if (!tabs.some((t) => t[0] === tab)) tab = tabs[0][0];
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  const page = h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'الإعدادات'))),
    h('nav', { class: 'tabs', 'aria-label': 'أقسام الإعدادات' }, tabs.map(([id, label]) => h('a', { href: '#/settings/' + id, class: id === tab ? 'active' : '' }, label))),
    body);
  const fn = { account: Settings.account, ai: Settings.ai, categories: Settings.categories, mappings: Settings.mappings, users: Settings.users, log: Settings.log, activity: () => Activity.view(), eta: () => ETA.settingsView(), backup: Settings.backup, periods: Settings.periods, restaurants: Settings.restaurants }[tab];
  body.append(await fn(s));
  return page;
};

/* ===== حسابي ===== */
Settings.account = async () => {
  const oldP = h('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const newP = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const newP2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const pwCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'تغيير كلمة المرور')),
    h('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:12px;max-width:420px' },
      h('div', { class: 'muted small' }, `المستخدم: ${DB.user.username} · ${DB.user.displayName}`),
      h('label', { class: 'field' }, 'كلمة المرور الحالية', oldP),
      h('label', { class: 'field' }, 'كلمة المرور الجديدة (8 خانات على الأقل، فيها حرف ورقم)', newP),
      h('label', { class: 'field' }, 'تأكيد كلمة المرور الجديدة', newP2),
      h('div', null, h('button', {
        type: 'button', class: 'btn primary', onClick: async () => {
          if (!oldP.value) return U.toast('أدخل كلمة المرور الحالية', 'err');
          if (!DB.validPassword(newP.value)) return U.toast(DB.passwordIssue(newP.value), 'err');
          if (newP.value !== newP2.value) return U.toast('كلمتا المرور غير متطابقتين', 'err');
          try { await DB.setPassword(DB.user.id, newP.value, oldP.value); } catch (e) { return U.toast(e.message, 'err'); }
          oldP.value = newP.value = newP2.value = '';
          U.toast('تم تغيير كلمة المرور', 'ok');
        },
      }, 'حفظ'))));
  return h('div', { style: 'display:flex;flex-direction:column;gap:14px' }, pwCard, await Wellness.settingsCard());
};

/* ===== الذكاء الاصطناعي ===== */
Settings.ai = async (s) => {
  const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
  const draw = () => {
    U.fill(wrap,
      h('div', { class: 'notice info' }, 'المفاتيح تُحفظ مشفرة عند الخادم ولا تُعرض بعد الحفظ (تُكتب فقط). الذكاء الاصطناعي يُستخدم في: قراءة عروض الأسعار PDF الممسوحة، ومطابقة أسماء الأصناف واستنتاج معامل العبوة. الحسابات المالية كلها تتم بالبرنامج نفسه.'),
      ...Object.entries(AI.PROVIDERS).map(([id, p]) => {
        const c = s.ai[id];
        const key = h('input', { class: 'input', type: 'password', value: '', placeholder: c.hasKey ? 'محفوظ ✓ — اكتب مفتاحاً جديداً فقط لو أردت تغييره' : 'API Key', autocomplete: 'new-password', style: 'direction:ltr' });
        const curModel = c.model || p.defaultModel;
        const custom = h('input', { class: 'input', value: curModel, style: 'direction:ltr', placeholder: 'اسم النموذج' });
        let model = custom;
        let modelField = custom;
        if (p.models) {
          // قائمة نماذج جاهزة + خيار "أخرى" لكتابة اسم يدوياً
          const known = p.models.some((m) => m.value === curModel);
          const sel = U.select([...p.models, { value: '__custom', label: 'أخرى (اكتب الاسم)...' }], known ? curModel : '__custom', (v) => {
            custom.style.display = v === '__custom' ? '' : 'none';
            if (v !== '__custom') custom.value = v;
          }, { style: 'direction:ltr' });
          custom.style.display = known ? 'none' : '';
          model = { get value() { return sel.value === '__custom' ? custom.value : sel.value; } };
          modelField = h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, sel, custom);
        }
        const save = async () => {
          const oldModel = c.model;
          const typed = key.value.trim();
          if (typed && p.keyPrefix && !typed.startsWith(p.keyPrefix)) throw new Error('مفتاح ' + p.label + ' يجب أن يبدأ بـ ' + p.keyPrefix + ' — انسخه كاملاً من console.anthropic.com (API Keys)');
          if (typed && /[^\x21-\x7E]/.test(typed)) throw new Error('المفتاح فيه مسافات أو حروف غير صالحة — انسخه مرة أخرى');
          const newModel = model.value.trim() || p.defaultModel;
          // الخادم يسجل تغيير/حذف المفتاح في سجل النشاط؛ هنا نسجل النموذج فقط
          s.ai[id] = Object.assign({}, c, { model: newModel }, typed ? { key: typed } : {});
          await DB.saveSettings(s);
          if (typed || oldModel !== newModel) {
            await AI.clearCooldown(id); // مفتاح أو نموذج جديد: نلغي أي إيقاف سابق بسبب انتهاء الحصة
            if (oldModel !== newModel) await Activity.add('settings', 'تعديل إعدادات الذكاء الاصطناعي', { type: 'settings', id: 'ai', label: p.label }, `النموذج من ${oldModel || '—'} إلى ${newModel}`);
          }
        };
        const guard = (fn) => async () => { try { await fn(); } catch (e) { U.toast(e.message, 'err'); } };
        const isActive = s.ai.active === id;
        return h('div', { class: 'card', style: isActive ? 'border-color:var(--accent);border-width:2px' : '' },
          h('div', { class: 'card-head' },
            h('div', { class: 'row' }, h('h2', null, p.label), isActive ? h('span', { class: 'chip ok' }, 'النموذج الافتراضي') : null, c.hasKey ? h('span', { class: 'chip gray' }, 'مفتاح محفوظ') : null),
            h('div', { class: 'row' },
              isActive ? null : h('button', { type: 'button', class: 'btn sm', onClick: guard(async () => { await save(); const old = s.ai.active; s.ai.active = id; await DB.saveSettings(s); await Activity.add('settings', 'تغيير النموذج الافتراضي', { type: 'settings', id: 'ai', label: 'الذكاء الاصطناعي' }, `من ${AI.PROVIDERS[old].label} إلى ${p.label}`); draw(); U.toast('تم تعيين ' + p.label + ' كنموذج افتراضي', 'ok'); }) }, 'اجعله الافتراضي'),
              h('button', {
                type: 'button', class: 'btn sm', onClick: async () => {
                  const b = U.busy('اختبار الاتصال...');
                  try { await save(); draw(); const ok = await AI.test({ provider: id, model: s.ai[id].model }); U.toast(ok ? 'الاتصال ناجح ✓' : 'رد غير متوقع من النموذج', ok ? 'ok' : 'err'); }
                  catch (e) { U.toast(e.message, 'err'); } finally { b.done(); }
                },
              }, 'اختبار الاتصال'))),
          h('div', { class: 'card-body grid' },
            h('label', { class: 'field' }, 'مفتاح API (' + p.keyHint + ')', key),
            h('label', { class: 'field' }, 'اسم النموذج', modelField),
            h('div', { class: 'row', style: 'align-items:flex-end' },
              h('button', { type: 'button', class: 'btn primary', onClick: guard(async () => { await save(); draw(); U.toast('تم الحفظ', 'ok'); }) }, 'حفظ'),
              c.hasKey ? h('button', { type: 'button', class: 'btn danger', onClick: guard(async () => { if (!await U.confirm('حذف مفتاح ' + p.label + ' المحفوظ؟', 'حذف', true)) return; s.ai[id] = Object.assign({}, c, { clearKey: true }); await DB.saveSettings(s); draw(); U.toast('تم حذف المفتاح', 'ok'); }) }, 'حذف المفتاح') : null)));
      }));
  };
  draw();
  return wrap;
};

/* ===== الأنواع والضرائب ===== */
Settings.categories = async (s) => {
  const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
  const draw = () => {
    const wht = h('input', { class: 'input short', type: 'number', step: '0.1', min: '0', value: s.whtRate });
    const idle = h('input', { class: 'input short', type: 'number', min: '5', value: s.idleMinutes || 30 });
    const seg = h('input', { type: 'checkbox', checked: !!s.segregation });
    const ipl = h('input', { type: 'checkbox', checked: !!s.ipLookup });
    const vatOpts = [{ value: '', label: 'غير محدد (يُحدد لكل صنف)' }, { value: '0', label: 'معفى 0%' }, { value: '14', label: 'خاضع 14%' }];
    U.fill(wrap, 
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'أنواع التوريد'), h('button', {
          type: 'button', class: 'btn sm', onClick: async () => {
            const name = h('input', { class: 'input' });
            const r = await U.modal({ title: 'إضافة نوع توريد', body: h('label', { class: 'field' }, 'اسم النوع (مثلاً: لحوم ودواجن)', name), actions: [{ label: 'إضافة', value: true, cls: 'primary' }, { label: 'إلغاء', value: false }] });
            if (r && name.value.trim()) { s.categories.push({ id: U.uid(), name: name.value.trim(), vat: null }); await Activity.add('settings', 'إضافة نوع توريد', { type: 'settings', id: 'categories', label: 'أنواع التوريد' }, name.value.trim()); await DB.save('settings', s); draw(); }
          },
        }, '+ نوع جديد')),
        h('div', { class: 'table-wrap' }, h('table', { class: 't' },
          h('thead', null, h('tr', null, h('th', null, 'النوع'), h('th', null, 'ق.م الافتراضية لأصنافه'), h('th', null, ''))),
          h('tbody', null, s.categories.map((c) => h('tr', null,
            h('td', null, h('input', { class: 'input cell', value: c.name, onChange: async (e) => { const old = c.name; c.name = e.target.value.trim() || c.name; if (old !== c.name) await Activity.add('settings', 'تعديل اسم نوع توريد', { type: 'settings', id: 'categories', label: 'أنواع التوريد' }, `من «${old}» إلى «${c.name}»`); await DB.save('settings', s); } })),
            h('td', null, U.select(vatOpts, c.vat == null ? '' : c.vat, async (v) => { const old = c.vat; c.vat = v === '' ? null : Number(v); await Activity.add('settings', 'تعديل ق.م الافتراضية لنوع', { type: 'settings', id: 'categories', label: 'أنواع التوريد' }, `${c.name}: من ${Settings.vatLabel(old)} إلى ${Settings.vatLabel(c.vat)}`); await DB.save('settings', s); }, { class: 'input cell' })),
            h('td', null, h('button', {
              type: 'button', class: 'btn sm danger', onClick: async () => {
                const quotes = await DB.load('quotes', []);
                if (quotes.some((q) => q.category === c.id)) return U.toast('لا يمكن حذف نوع له عروض أسعار محفوظة', 'err');
                if (!await U.confirm('حذف النوع "' + c.name + '"؟', 'حذف', true)) return;
                s.categories = s.categories.filter((x) => x !== c); await Activity.add('settings', 'حذف نوع توريد', { type: 'settings', id: 'categories', label: 'أنواع التوريد' }, c.name); await DB.save('settings', s); draw();
              },
            }, 'حذف'))))))),
        h('div', { class: 'card-body muted small' }, '"غير محدد" يعني أن نسبة الضريبة تُؤخذ من فاتورة المورد أول مرة ويُطلب منك تأكيدها، ثم تُحفظ على الصنف في عرض السعر عند اعتماد الظرف. يمكنك تعديلها لكل صنف من شاشة عرض السعر.')),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'إعدادات عامة')),
        h('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:12px' },
          h('label', { class: 'row' }, h('span', { style: 'min-width:260px' }, 'نسبة ضريبة الخصم والإضافة %'), wht),
          h('label', { class: 'row' }, h('span', { style: 'min-width:260px' }, 'خروج تلقائي بعد عدم النشاط (دقيقة)'), idle),
          h('label', { class: 'row', style: 'align-items:flex-start' }, seg, h('span', null, h('strong', null, 'الفصل بين المُعِد والمعتمِد'), h('div', { class: 'small muted' }, 'من أضاف فواتير أو عدّل في الظرف لا يستطيع اعتماده؛ يعتمده مستخدم آخر لديه صلاحية الاعتماد. (يحتاج مستخدمَين على الأقل بصلاحية الاعتماد)'))),
          h('label', { class: 'row', style: 'align-items:flex-start' }, ipl, h('span', null, h('strong', null, 'تسجيل عنوان IP العام في سجل الدخول'), h('div', { class: 'small muted' }, 'عند كل دخول يسأل البرنامج خدمة خارجية (api.ipify.org) عن عنوان الإنترنت العام للجهاز ليظهر في سجل الدخول. مقفول افتراضياً حتى لا يتصل البرنامج بأي جهة غير المنظومة.'))),
          h('div', null, h('button', { type: 'button', class: 'btn primary', onClick: async () => {
            const oW = s.whtRate, oI = s.idleMinutes || 30, oS = !!s.segregation;
            s.whtRate = Number(wht.value) || 0; s.idleMinutes = Math.max(5, Number(idle.value) || 30); s.segregation = seg.checked; s.ipLookup = ipl.checked;
            const d = [oW !== s.whtRate ? `نسبة الخصم والإضافة من ${oW}% إلى ${s.whtRate}%` : '', oI !== s.idleMinutes ? `مدة الخروج التلقائي من ${oI} إلى ${s.idleMinutes} دقيقة` : '', oS !== s.segregation ? `الفصل بين المُعِد والمعتمِد: ${s.segregation ? 'مفعّل' : 'متوقف'}` : ''].filter(Boolean).join(' · ');
            if (d) await Activity.add('settings', 'تعديل الإعدادات العامة', { type: 'settings', id: 'general', label: 'إعدادات عامة' }, d);
            await DB.save('settings', s); U.toast('تم الحفظ', 'ok'); } }, 'حفظ')))));
  };
  draw();
  return wrap;
};

/* ===== ذاكرة الربط ===== */
Settings.mappings = async (s) => {
  const wrap = h('div', { class: 'card' });
  const q = h('input', { class: 'input', placeholder: 'بحث...', style: 'max-width:280px' });
  const tbody = h('tbody');
  const draw = async () => {
    const m = await DB.load('mappings', {});
    const term = U.norm(q.value);
    const entries = Object.entries(m).filter(([, v]) => !term || U.norm(v.description + ' ' + v.label).includes(term))
      .sort((a, b) => (b[1].updatedAt || '').localeCompare(a[1].updatedAt || ''));
    U.fill(tbody, ...(entries.length ? entries.map(([k, v]) => h('tr', null,
      h('td', null, v.description),
      h('td', null, v.label, h('div', { class: 'sub' }, v.unit || '')),
      h('td', null, '×' + v.factor),
      h('td', null, Settings.catName(v.category, s)),
      h('td', null, v.count || 1),
      h('td', null, h('button', { type: 'button', class: 'btn sm danger', onClick: async () => { delete m[k]; await Activity.add('settings', 'حذف ربط من الذاكرة', { type: 'settings', id: 'mappings', label: 'ذاكرة ربط الأصناف' }, `«${v.description}» ← «${v.label}» ×${v.factor}`); await DB.save('mappings', m); draw(); } }, 'حذف')),
    )) : [h('tr', null, h('td', { colspan: 6, class: 'muted' }, 'لا توجد ربطات محفوظة بعد — تُحفظ تلقائياً عند اعتماد الأظرف'))]));
  };
  q.addEventListener('input', draw);
  wrap.append(
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'ذاكرة ربط الأصناف'), h('div', { class: 'muted small' }, 'كل ربط اعتمدته بين اسم صنف المورد واسم عرض السعر ومعامل العبوة')), q),
    h('div', { class: 'table-wrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['اسم الصنف في فاتورة المورد', 'الصنف في عرض السعر', 'المعامل', 'النوع', 'مرات الاستخدام', ''].map((x) => h('th', null, x)))),
      tbody)));
  await draw();
  return wrap;
};

/* ===== المستخدمين ===== */
Settings.userForm = async (existing) => {
  const p = existing || { role: 'auditor', perms: { envelopes: true } };
  if (existing && p.role === 'admin' && DB.user.role !== 'admin') { U.toast('تعديل حساب مدير النظام للمدير فقط', 'err'); return false; }
  const username = h('input', { class: 'input', value: existing ? existing.username : '', disabled: !!existing, autocomplete: 'off' });
  const display = h('input', { class: 'input', value: p.displayName || '' });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: existing ? 'اتركها فارغة لعدم التغيير' : '' });
  let role = p.role || 'auditor';
  const permBoxes = {};
  // صلاحية لكل بند، مقسّمة في مجموعات، ومعها "تحديد الكل" لكل مجموعة. لا يظهر للمانح إلا ما يملكه هو
  const mine = (k) => DB.user.role === 'admin' || DB.can(k);
  const permWrap = h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
    DB.PERM_GROUPS.map(([title, items]) => {
      const boxes = items.map(([k, label]) => {
        permBoxes[k] = h('input', { type: 'checkbox', checked: !!(p.perms && p.perms[k]), disabled: !mine(k) });
        return h('label', { class: 'row', style: 'min-height:30px;align-items:flex-start;flex-wrap:nowrap' + (mine(k) ? '' : ';opacity:.5'), title: mine(k) ? '' : 'لا يمكنك منح صلاحية لا تملكها' }, permBoxes[k], h('span', { style: 'flex:1;min-width:0' }, label));
      });
      const all = h('input', { type: 'checkbox', 'aria-label': 'تحديد كل صلاحيات ' + title, checked: items.every(([k]) => permBoxes[k].checked) });
      all.addEventListener('change', () => { for (const [k] of items) if (!permBoxes[k].disabled) permBoxes[k].checked = all.checked; });
      for (const [k] of items) permBoxes[k].addEventListener('change', () => { all.checked = items.every(([kk]) => permBoxes[kk].checked); });
      return h('div', { style: 'display:flex;flex-direction:column;gap:4px;padding-bottom:8px;border-bottom:1px solid var(--line-soft)' },
        h('label', { class: 'row', style: 'font-weight:700;flex-wrap:nowrap' }, all, title), h('div', { style: 'display:flex;flex-direction:column;gap:2px;padding-inline-start:22px' }, boxes));
    }));
  const roleSel = U.select([{ value: 'auditor', label: 'مراجع / محاسب (صلاحيات محددة)' }].concat(DB.user.role === 'admin' ? [{ value: 'admin', label: 'مدير النظام (كل الصلاحيات)' }] : []), role, (v) => { role = v; permWrap.style.opacity = v === 'admin' ? '.4' : '1'; });
  permWrap.style.opacity = role === 'admin' ? '.4' : '1';
  const r = await U.modal({
    title: existing ? 'تعديل مستخدم' : 'مستخدم جديد', wide: true, confirmClose: () => !!pass.value || (!existing && !!username.value.trim()),
    body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('label', { class: 'field' }, 'اسم الدخول', username),
      h('label', { class: 'field' }, 'الاسم الظاهر', display),
      existing && existing.id === DB.user.id
        ? h('div', { class: 'small muted' }, 'كلمة مرورك أنت تتغير من تبويب "حسابي" (تحتاج كلمة المرور الحالية).')
        : h('label', { class: 'field' }, 'كلمة المرور (8 خانات على الأقل، فيها حرف ورقم)', pass),
      h('label', { class: 'field' }, 'الدور', roleSel),
      h('fieldset', { style: 'border:1px solid var(--line);border-radius:8px;padding:10px 14px' }, h('legend', { class: 'small muted' }, 'الصلاحيات'), permWrap)),
    actions: [{
      label: 'حفظ', value: true, cls: 'primary', validate: () => {
        if (!existing && !username.value.trim()) { U.toast('أدخل اسم الدخول', 'err'); return false; }
        if ((!existing || pass.value) && !DB.validPassword(pass.value)) { U.toast(DB.passwordIssue(pass.value), 'err'); return false; }
        return true;
      },
    }, { label: 'إلغاء', value: false }],
  });
  if (!r) return false;
  const perms = {};
  for (const k of Object.keys(permBoxes)) perms[k] = permBoxes[k].checked;
  try {
    if (existing) {
      const newName = display.value.trim() || existing.username;
      await DB.updateUser(existing.id, { displayName: newName, role, perms, password: pass.value || null });
    } else {
      await DB.addUser({ username: username.value, displayName: display.value.trim(), password: pass.value, role, perms });
    }
    U.toast('تم الحفظ', 'ok');
    return true;
  } catch (e) { U.toast(e.message, 'err'); return false; }
};

Settings.users = async () => {
  const wrap = h('div', { class: 'card' });
  const draw = async () => {
    const users = await DB.users();
    const admins = users.filter((u) => u.role === 'admin').length;
    U.fill(wrap, 
      h('div', { class: 'card-head' }, h('h2', null, 'المستخدمين'), h('button', { type: 'button', class: 'btn primary sm', onClick: async () => { if (await Settings.userForm(null)) draw(); } }, '+ مستخدم جديد')),
      h('div', { class: 'table-wrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['اسم الدخول', 'الاسم', 'الدور', 'الصلاحيات', ''].map((x) => h('th', null, x)))),
        h('tbody', null, users.map((u) => {
          const p = u;
          const permsText = p.role === 'admin' ? 'الكل' : Object.entries(DB.ALL_PERMS).filter(([k]) => p.perms && p.perms[k]).map(([, v]) => v).join('، ') || '—';
          return h('tr', null,
            h('td', null, u.username, u.id === DB.user.id ? h('span', { class: 'chip gray', style: 'margin-inline-start:6px' }, 'أنت') : null),
            h('td', null, p.displayName || ''),
            h('td', null, p.role === 'admin' ? h('span', { class: 'chip dark' }, 'مدير') : h('span', { class: 'chip gray' }, 'مراجع')),
            h('td', { class: 'small' }, permsText),
            h('td', null, h('div', { class: 'row' },
              h('button', { type: 'button', class: 'btn sm', onClick: async () => { if (await Settings.userForm(u)) draw(); } }, 'تعديل'),
              h('button', {
                type: 'button', class: 'btn sm danger', disabled: u.id === DB.user.id || (p.role === 'admin' && admins <= 1), onClick: async () => {
                  if (!await U.confirm('حذف المستخدم "' + u.username + '"؟', 'حذف', true)) return;
                  try {
                    await DB.deleteUser(u.id);
                    draw();
                  } catch (e) { U.toast(e.message, 'err'); }
                },
              }, 'حذف'))));
        })))));
  };
  await draw();
  return wrap;
};

/* ===== سجل الدخول ===== */
Settings.fmtDT = (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '');
Settings.fmtDur = (ms) => {
  if (ms == null || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'أقل من دقيقة';
  const hh = Math.floor(m / 60), mm = m % 60;
  return (hh ? hh + ' ساعة ' : '') + (mm ? mm + ' دقيقة' : '');
};

Settings.log = async () => {
  const users = await DB.users();
  const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
  let fUser = '', fType = '', fFrom = '', fTo = '';
  const tbody = h('tbody');
  const counts = h('div', { class: 'muted small' });

  const rowsFor = (list) => list.filter((e) => {
    if (fUser && (e.username || '').toLowerCase() !== fUser.toLowerCase()) return false;
    if (fType && e.type !== fType) return false;
    const day = new Date(e.at).toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
    if (fFrom && day < fFrom) return false;
    if (fTo && day > fTo) return false;
    return true;
  }).sort((a, b) => b.at - a.at);

  const typeChip = (e) => e.type === 'session'
    ? (!e.end && e.id === DB.sessionId ? h('span', { class: 'chip dark' }, 'متصل الآن') : h('span', { class: 'chip ok' }, 'دخول'))
    : e.type === 'locked' ? h('span', { class: 'chip bad' }, 'إيقاف مؤقت 60 ث')
      : e.type === 'restore' ? h('span', { class: 'chip dark' }, 'استرجاع نسخة احتياطية') : h('span', { class: 'chip warn' }, 'محاولة فاشلة');

  const draw = async () => {
    const list = rowsFor(await DB.readLog());
    counts.textContent = `${list.length} سجل · ${list.filter((e) => e.type === 'session').length} جلسة · ${list.filter((e) => e.type !== 'session').length} محاولة فاشلة`;
    U.fill(tbody, list.length ? list.slice(0, 1000).map((e) => {
      const end = e.end || (e.id === DB.sessionId ? Date.now() : null);
      return h('tr', { class: e.type === 'session' ? '' : 'short' },
        h('td', null, h('strong', null, e.displayName || e.username || '—'), e.displayName && e.username ? h('div', { class: 'sub' }, e.username) : null,
          e.type !== 'session' && !e.knownUser ? h('div', { class: 'sub' }, 'اسم غير مسجل') : null),
        h('td', null, typeChip(e)),
        h('td', { class: 'num' }, Settings.fmtDT(e.at)),
        h('td', { class: 'num' }, e.type === 'session' && e.end ? Settings.fmtDT(e.end) : ''),
        h('td', null, e.type === 'session' ? Settings.fmtDur(end ? end - e.at : null) : ''),
        h('td', { class: 'small' }, e.type === 'session' ? (e.endReason || (e.id === DB.sessionId ? 'الجلسة الحالية' : '')) : ''),
        h('td', { class: 'small' }, e.deviceLabel || h('span', { class: 'muted' }, 'بدون اسم'), h('div', { class: 'sub num' }, e.deviceId || '')),
        h('td', { class: 'small' }, `${e.browser || ''} · ${e.os || ''}`, h('div', { class: 'sub' }, e.screen || '')),
        h('td', { class: 'num small' }, e.ip || h('span', { class: 'muted' }, '—')));
    }) : h('tr', null, h('td', { colspan: 9, class: 'muted', style: 'text-align:center;padding:20px' }, 'لا توجد سجلات')));
  };

  const userOpts = [{ value: '', label: 'كل المستخدمين' }].concat(users.map((u) => ({ value: u.username, label: u.username })));
  const typeOpts = [{ value: '', label: 'كل الأنواع' }, { value: 'session', label: 'دخول ناجح' }, { value: 'fail', label: 'محاولة فاشلة' }, { value: 'locked', label: 'إيقاف مؤقت' }];

  U.fill(wrap,
    h('div', { class: 'notice info' }, 'سجل الدخول يكتبه الخادم نفسه (وقت الدخول والخروج ومدة الجلسة والمتصفح)، فلا يمكن لأي مستخدم تعديله أو حذفه من البرنامج. عمود "الجهاز" هو الجهاز الذي يعمل عليه البرنامج.'),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h2', null, 'سجل الدخول للنظام'), counts),
        h('div', { class: 'row' },
          U.select(userOpts, fUser, (v) => { fUser = v; draw(); }, { 'aria-label': 'المستخدم', style: 'width:160px' }),
          U.select(typeOpts, fType, (v) => { fType = v; draw(); }, { 'aria-label': 'النوع', style: 'width:150px' }),
          h('label', { class: 'row small' }, 'من', h('input', { class: 'input', type: 'date', style: 'width:150px', onChange: (e) => { fFrom = e.target.value; draw(); } })),
          h('label', { class: 'row small' }, 'إلى', h('input', { class: 'input', type: 'date', style: 'width:150px', onChange: (e) => { fTo = e.target.value; draw(); } })),
          h('button', { type: 'button', class: 'btn sm', onClick: () => Settings.exportLog(rowsFor) }, 'تصدير Excel'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 't', style: 'min-width:1100px' },
        h('thead', null, h('tr', null, ['المستخدم', 'النوع', 'وقت الدخول', 'وقت الخروج', 'مدة الجلسة', 'طريقة الخروج', 'الجهاز', 'المتصفح والنظام', 'IP'].map((x) => h('th', null, x)))),
        tbody)),
      h('div', { class: 'card-body small muted' }, 'مدة الجلسة تُحسب حتى آخر نشاط فعلي. لو أُغلق المتصفح فجأة تُسجل نهاية الجلسة عند آخر نشاط مسجل.')));
  await draw();
  return wrap;
};

Settings.exportLog = async (rowsFor) => {
  await Quotes.ensureXLSX();
  const list = rowsFor(await DB.readLog());
  const type = (e) => (e.type === 'session' ? 'دخول' : e.type === 'locked' ? 'إيقاف مؤقت' : 'محاولة فاشلة');
  const data = [['المستخدم', 'اسم الدخول', 'النوع', 'وقت الدخول', 'وقت الخروج', 'مدة الجلسة', 'طريقة الخروج', 'الجهاز', 'رقم الجهاز', 'المتصفح', 'النظام', 'IP']]
    .concat(list.map((e) => [e.displayName || '', e.username || '', type(e), Settings.fmtDT(e.at), Settings.fmtDT(e.end), e.type === 'session' && e.end ? Settings.fmtDur(e.end - e.at) : '', e.endReason || '', e.deviceLabel || '', e.deviceId || '', e.browser || '', e.os || '', e.ip || '']));
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 20 }, { wch: 16 }, { wch: 22 }, { wch: 20 }, { wch: 18 }, { wch: 12 }, { wch: 14 }, { wch: 16 }];
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, 'سجل الدخول');
  XLSX.writeFile(wb, `سجل الدخول ${new Date().toISOString().slice(0, 10)}.xlsx`);
};

/* ===== المطاعم (لتوزيع استهلاك كل فاتورة على مطعم) ===== */
Settings.restaurants = async (s) => {
  const wrap = h('div', { class: 'card' });
  let used = new Map();
  try { for (const e of (DB.can('envelopes') ? await DB.load('envelopes', []) : [])) for (const i of e.invoices) if (i.restaurantId) used.set(i.restaurantId, (used.get(i.restaurantId) || 0) + 1); } catch (e) { /* */ }
  const persist = async (action, details) => { await DB.saveSettings(s); await Activity.add('settings', action, { type: 'settings', id: 'restaurants', label: 'المطاعم' }, details); draw(); };
  const draw = () => {
    const list = s.restaurants || [];
    const name = h('input', { class: 'input', placeholder: 'اسم المطعم أو الفرع (مثلاً: فرع المعادي)', style: 'max-width:320px' });
    const add = async () => {
      const n = name.value.trim();
      if (!n) return U.toast('اكتب اسم المطعم', 'err');
      if (list.some((r) => r.name === n)) return U.toast('الاسم موجود بالفعل', 'err');
      s.restaurants = list.concat([{ id: 'r' + U.uid(), name: n }]);
      try { await persist('إضافة مطعم', n); U.toast('تمت الإضافة', 'ok'); } catch (e) { U.toast(e.message, 'err'); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    U.fill(wrap,
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'المطاعم'), h('div', { class: 'small muted' }, 'الأسماء هنا تظهر في قائمة منسدلة جوه كل فاتورة في الظرف، عشان تعرف استهلاك كل مطعم من لوحة "استهلاك المطاعم".'))),
      h('div', { class: 'card-body row' }, name, h('button', { type: 'button', class: 'btn primary', onClick: add }, '+ إضافة مطعم')),
      h('div', { class: 'table-wrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['اسم المطعم', 'فواتير مربوطة', ''].map((x) => h('th', null, x)))),
        h('tbody', null, list.length ? list.map((r) => h('tr', null,
          h('td', null, h('input', { class: 'input cell', value: r.name, style: 'max-width:320px', 'aria-label': 'اسم المطعم', onChange: async (e) => {
            const n = e.target.value.trim(); const old = r.name;
            if (!n || n === old) { e.target.value = old; return; }
            if (list.some((x) => x !== r && x.name === n)) { e.target.value = old; return U.toast('الاسم موجود بالفعل', 'err'); }
            s.restaurants = list.map((x) => (x === r ? { ...x, name: n } : x));
            try { await persist('تعديل اسم مطعم', `من «${old}» إلى «${n}»`); } catch (err) { U.toast(err.message, 'err'); }
          } })),
          h('td', null, used.get(r.id) || 0),
          h('td', null, h('button', { type: 'button', class: 'btn sm danger', onClick: async () => {
            if (used.get(r.id)) return U.alert('لا يمكن الحذف', `المطعم «${r.name}» مربوط بـ ${used.get(r.id)} فاتورة. غيّر اسمه بدل الحذف، أو انقل فواتيره لمطعم آخر أولاً.`);
            if (!await U.confirm(`حذف المطعم «${r.name}»؟`, 'حذف', true)) return;
            s.restaurants = list.filter((x) => x !== r);
            try { await persist('حذف مطعم', r.name); } catch (err) { U.toast(err.message, 'err'); }
          } }, 'حذف'))))
          : h('tr', null, h('td', { colspan: 3, class: 'muted', style: 'padding:18px;text-align:center' }, 'لا توجد مطاعم بعد — أضف أول مطعم من الأعلى'))))));
  };
  draw();
  return wrap;
};

/* ===== إقفال الفترات ===== */
Settings.periods = async (s) => {
  const envs = DB.can('envelopes') ? await DB.load('envelopes', []) : [];
  const quotes = await DB.load('quotes', []);
  const closed = new Set(s.closedMonths || []);
  const months = [...new Set([...envs.map((e) => e.month), ...quotes.map((q) => q.month), ...closed])].filter(Boolean).sort().reverse();
  const isAdmin = DB.user.role === 'admin';
  const act = async (month, action) => {
    let reason = '';
    if (action === 'open') {
      const r = h('input', { class: 'input', placeholder: 'مثلاً: تصحيح فاتورة مكررة بموافقة المدير المالي' });
      const ok = await U.modal({ title: `فتح فترة ${U.monthName(month)}`, body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' }, h('div', { class: 'notice' }, 'فتح فترة مقفلة يُسجل في سجل النشاط باسمك والسبب. أعد إقفالها بعد التصحيح.'), h('label', { class: 'field' }, 'سبب الفتح *', r)),
        actions: [{ label: 'فتح الفترة', value: true, cls: 'danger', validate: () => { if (r.value.trim().length < 3) { U.toast('اكتب سبب الفتح', 'err'); return false; } return true; } }, { label: 'إلغاء', value: false }] });
      if (!ok) return;
      reason = r.value.trim();
    } else if (!await U.confirm(`إقفال شهر ${U.monthName(month)}؟ بعد الإقفال لا يمكن تعديل أو حذف أو إضافة أظرف وعروض أسعار لهذا الشهر (متابعة الإشعارات الدائنة والسداد تظل متاحة).`, 'إقفال')) return;
    try {
      await DB.call('POST', '/api/v2/period', { month, action, reason });
      DB.invalidate();
      U.toast(action === 'close' ? 'تم إقفال الشهر' : 'تم فتح الشهر', 'ok');
      App.route();
    } catch (e) {
      if (e.data && e.data.drafts) U.alert('لا يمكن إقفال الشهر', `${e.message}:\n${e.data.drafts.join('\n')}`); else U.toast(e.message, 'err');
    }
  };
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'إقفال الفترات'), h('div', { class: 'small muted' }, 'بعد اعتماد كل أظرف الشهر وتسليم الحسابات: أقفل الشهر حتى لا تتغير أرقامه. الإقفال والفتح للمدير فقط، والفتح يحتاج سبباً مكتوباً.'))),
    h('div', { class: 'table-wrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['الشهر', 'الأظرف', 'لم تُعتمد', 'عروض الأسعار', 'الحالة', ''].map((x) => h('th', null, x)))),
      h('tbody', null, months.length ? months.map((m) => {
        const me = envs.filter((e) => e.month === m);
        const drafts = me.filter((e) => e.status !== 'approved').length;
        const isClosed = closed.has(m);
        return h('tr', null,
          h('td', null, h('strong', null, U.monthName(m))),
          h('td', null, DB.can('envelopes') ? me.length : '—'),
          h('td', null, DB.can('envelopes') ? (drafts ? h('span', { class: 'chip warn' }, drafts) : '0') : '—'),
          h('td', null, quotes.filter((q) => q.month === m).length),
          h('td', null, isClosed ? h('span', { class: 'chip dark' }, 'مقفل') : h('span', { class: 'chip gray' }, 'مفتوح')),
          h('td', null, isAdmin ? h('button', { type: 'button', class: 'btn sm ' + (isClosed ? 'danger' : 'primary'), onClick: () => act(m, isClosed ? 'open' : 'close') }, isClosed ? 'فتح الفترة' : 'إقفال الشهر') : h('span', { class: 'small muted' }, 'للمدير')));
      }) : h('tr', null, h('td', { colspan: 6, class: 'muted' }, 'لا توجد شهور بعد'))))));
};

/* ===== نسخة تلقائية في مكان ثانٍ (للمدير) ===== */
Settings.mirrorCard = async () => {
  if (DB.user.role !== 'admin') return null;
  let st = { dir: '', at: null, error: '' };
  try { st = await DB.call('GET', '/api/v2/mirror'); } catch (e) { /* */ }
  const dir = h('input', { class: 'input', value: st.dir || '', placeholder: 'مثلاً E:\\نسخ المطابقة أو C:\\Users\\...\\OneDrive\\نسخ المطابقة', style: 'direction:ltr;text-align:right' });
  const status = st.dir
    ? (st.error ? h('div', { class: 'notice bad' }, 'آخر محاولة فشلت: ' + st.error) : h('div', { class: 'notice info' }, st.at ? `آخر نسخ: ${Settings.fmtDT(st.at)}` : 'لم يتم النسخ بعد'))
    : h('div', { class: 'notice' }, 'غير مُفعّل: النسخ اليومية الآن على نفس الهارد فقط. لو تعطل الهارد تضيع معه.');
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'نسخة تلقائية في مكان ثانٍ')),
    h('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'small muted' }, 'بعد كل حفظ (كل دقيقة على الأكثر) يُنسخ ملف البيانات المشفر ونسخة اليوم إلى هذا المكان: فلاشة، أو قرص آخر، أو مجلد OneDrive/Google Drive على الجهاز. لو المكان غير متاح (الفلاشة مفصولة) يستمر البرنامج عادياً ويظهر تنبيه.'),
      status,
      h('label', { class: 'field' }, 'المكان (مسار كامل)', dir),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn primary', onClick: async () => { try { await DB.call('PUT', '/api/v2/mirror', { dir: dir.value.trim() }); U.toast(dir.value.trim() ? 'تم الحفظ والنسخ' : 'تم إيقاف النسخ لمكان ثانٍ', 'ok'); App.route(); } catch (e) { U.toast(e.message, 'err'); } } }, 'حفظ'),
        st.dir ? h('button', { type: 'button', class: 'btn', onClick: async () => {
          const b = U.busy('اختبار النسخة...');
          try { const r = await DB.call('POST', '/api/v2/mirror/test', {}); b.done(); r.ok ? U.alert('النسخة سليمة ✓', `النسخة في المكان الثاني تُقرأ وتُفك بنجاح (${r.users} مستخدم · ${r.days} نسخة يومية).`) : U.alert('النسخة غير سليمة', r.message); }
          catch (e) { b.done(); U.toast(e.message, 'err'); }
        } }, 'اختبار أن النسخة تُفتح') : null)));
};

/* ===== النسخ الاحتياطي ===== */
Settings.backup = async () => {
  const file = h('input', { type: 'file', accept: '.einv,.json', class: 'input', style: 'padding-top:8px' });
  let info = null;
  try { info = await DB.call('GET', '/api/v2/info'); } catch (e) { /* لا يمنع الشاشة */ }
  const folderCard = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'مجلد البيانات على الجهاز')),
    h('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'notice info' }, `البيانات تُحفظ تلقائياً${info && info.dataDir ? ' في: ' + info.dataDir + '\\einvoice-data.einv' : ''}${DB.Save.lastSaved ? ' · آخر حفظ في هذه الجلسة ' + Settings.fmtDT(DB.Save.lastSaved) : ''}. ونسخة يومية في المجلد الفرعي "نسخ يومية" تُحفظ لمدة سنة.`),
      DB.Save.error ? h('div', { class: 'notice bad' }, 'آخر خطأ في الحفظ: ' + DB.Save.error) : null,
      h('div', { class: 'small muted' }, 'لنقل البرنامج والبيانات لجهاز آخر: انسخ مجلد البرنامج كاملاً (ومعه مجلد البيانات) وشغّله على الجهاز الآخر بنفس اليوزرات وكلمات المرور.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn', onClick: () => DB.call('POST', '/api/v2/open-folder', {}).catch((e) => U.toast(e.message, 'err')) }, 'فتح مجلد البيانات'))));
  return h('div', { style: 'display:flex;flex-direction:column;gap:14px' },
    folderCard,
    await Settings.mirrorCard(),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'تصدير نسخة احتياطية مشفرة')),
      h('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'muted' }, 'ينزل ملف .einv يحتوي كل البيانات وهي مشفرة. لا يُفتح إلا من هذا البرنامج وبكلمة مرور أحد المستخدمين المسجلين وقت التصدير. احفظه في مكان آمن أو انقله لجهاز آخر.'),
        h('div', null, h('button', {
          type: 'button', class: 'btn primary', onClick: async () => {
            const d = new Date().toISOString().slice(0, 10);
            try { U.download(`einvoice-backup-${d}.einv`, await DB.exportBackup()); U.toast('تم تنزيل النسخة الاحتياطية', 'ok'); }
            catch (e) { U.toast(e.message, 'err'); }
          },
        }, 'تنزيل نسخة احتياطية')))),
    DB.user.role === 'admin' ? h('div', { class: 'card warn' },
      h('div', { class: 'card-head' }, h('h2', null, 'استرجاع نسخة احتياطية')),
      h('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'notice' }, 'الاسترجاع (للمدير فقط) يستبدل كل البيانات الحالية بمحتوى الملف، ويأخذ نسخة أمان من البيانات الحالية قبل الاستبدال، ثم يُنهي كل الجلسات ويطلب الدخول بمستخدم من النسخة المسترجعة.'),
        file,
        h('div', null, h('button', {
          type: 'button', class: 'btn warn', onClick: async () => {
            const f = file.files[0];
            if (!f) return U.toast('اختر ملف النسخة الاحتياطية', 'err');
            if (!await U.confirm('سيتم حذف كل البيانات الحالية واستبدالها بالنسخة الاحتياطية (مع نسخة أمان قبل الاستبدال). متابعة؟', 'استرجاع', true)) return;
            try {
              await DB.importBackup(await U.readText(f));
              U.toast('تم الاسترجاع — سجل الدخول', 'ok'); App.start();
            }
            catch (e) { U.toast(e.message, 'err'); }
          },
        }, 'استرجاع')))) : null);
};
