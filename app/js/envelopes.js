/* أظرف الموردين: إنشاء، إضافة فواتير، مطابقة، تعديل المستلم، اعتماد، تقرير الإشعار الدائن */
'use strict';

const Envelopes = {};

Envelopes.SRC = { memory: 'من الذاكرة', exact: 'تطابق حرفي', ai: 'ذكاء اصطناعي', fuzzy: 'تشابه أسماء', manual: 'يدوي' };

/* ===== الضوابط ===== */
Envelopes.isClosed = (s, month) => (s.closedMonths || []).includes(month);
Envelopes.validStatus = (st) => !st || String(st).toLowerCase() === 'valid';
Envelopes.wrongBuyer = (inv, s) => !!(inv.receiverId && s.companyTaxId && String(inv.receiverId).trim() !== String(s.companyTaxId).trim());

/* قبل الاعتماد: نتأكد من المنظومة أن كل فاتورة ما زالت "صالحة" (لم يلغها المورد أو يرفضها)، وأنها صادرة للرقم الضريبي لشركتك.
 * لا يحفظ شيئاً بنفسه: النتيجة تُحفظ مع الاعتماد نفسه. */
Envelopes.preApprove = async (env, s) => {
  const issues = [], notes = [];
  const company = String(s.companyTaxId || '').trim();
  const eta = await ETA.ready();
  let checked = 0, skipped = 0;
  const b = U.busy('التحقق من الفواتير على منظومة الضرائب...');
  try {
    for (let i = 0; i < env.invoices.length; i++) {
      const inv = env.invoices[i];
      if (eta && inv.uuid) {
        b.set(`التحقق من الفاتورة ${i + 1} من ${env.invoices.length} على المنظومة...`);
        if (checked) await AI.sleep(ETA.DETAILS_GAP_MS);
        try {
          const r = await ETA.statusOf(inv.uuid);
          if (r.status) inv.status = r.status;
          if (r.receiverId) inv.receiverId = r.receiverId;
          inv.etaCheckedAt = new Date().toISOString();
          checked++;
        } catch (e) { skipped++; notes.push(`فاتورة ${inv.internalID || '—'}: تعذر التحقق (${String(e.message).split('\n')[0]})`); }
      } else skipped++;
      if (!Envelopes.validStatus(inv.status)) issues.push(`فاتورة ${inv.internalID || '—'}: حالتها على المنظومة "${inv.status}" (ملغاة أو مرفوضة) — لا تُعتمد للصرف`);
      if (Envelopes.wrongBuyer(inv, s)) issues.push(`فاتورة ${inv.internalID || '—'}: صادرة للرقم الضريبي ${inv.receiverId} وليس لرقم شركتك ${company} — لا تُخصم ضريبياً`);
    }
  } finally { b.done(); }
  if (!company) notes.push('الرقم الضريبي لشركتك غير مسجل (الإعدادات ← ربط الضرائب)، فلم يتم التأكد أن الفواتير صادرة لشركتك.');
  if (!eta) notes.push('الربط مع منظومة الضرائب غير مُعد: اعتمدنا على حالة الفاتورة وقت إضافتها فقط.');
  else if (skipped) notes.push(`${skipped} فاتورة لم يتم التحقق منها على المنظومة (بدون رقم UUID أو تعذر الاتصال).`);
  return { issues, notes, checked, skipped };
};

/* ===== المطاعم: توزيع استهلاك كل فاتورة على مطعم ===== */
Envelopes.restName = (id, s) => { const r = (s.restaurants || []).find((x) => x.id === id); return r ? r.name : ''; };
Envelopes.restControl = (env, inv, s, tagLock, save, draw) => {
  if (!(s.restaurants || []).length) return null;
  const name = Envelopes.restName(inv.restaurantId, s);
  if (tagLock) return name ? h('span', { class: 'chip gray' }, name) : h('span', { class: 'chip warn' }, 'بدون مطعم');
  return U.select([{ value: '', label: 'بدون مطعم' }].concat(s.restaurants.map((r) => ({ value: r.id, label: r.name }))), inv.restaurantId || '', async (v) => {
    const old = Envelopes.restName(inv.restaurantId, s);
    inv.restaurantId = v || undefined;
    await Activity.add('envelopes', 'تحديد مطعم الفاتورة', Activity.envTarget(env, s), `فاتورة ${inv.internalID || '—'}: من «${old || 'بدون'}» إلى «${Envelopes.restName(v, s) || 'بدون'}»`);
    await save(); draw();
  }, { class: 'input cell', style: 'width:170px' + (inv.restaurantId ? '' : ';border-color:var(--warn)'), 'aria-label': 'مطعم الفاتورة ' + (inv.internalID || '') });
};

/* ===== متابعة الإشعار الدائن والسداد ===== */
Envelopes.CN_LABEL = { none: ['لا يوجد إشعار مطلوب', 'gray'], pending: ['مطلوب — لم يصدر', 'bad'], partial: ['صدر جزئياً', 'warn'], received: ['صدر بالكامل', 'ok'], settled: ['تمت التسوية', 'ok'] };
Envelopes.cnInfo = (env, t) => {
  const cn = env.cn || {};
  const req = U.r2(t.cnTotal);
  const got = U.r2((cn.docs || []).reduce((a, d) => a + (Number(d.total) || 0), 0));
  const rem = Math.max(0, U.r2(req - got));
  const st = req <= 0.005 ? 'none' : cn.settledAt ? 'settled' : got <= 0 ? 'pending' : rem > 0.01 ? 'partial' : 'received';
  const since = env.approvedAt ? Math.floor((Date.now() - Date.parse(env.approvedAt)) / 86400000) : null;
  return { req, got, rem, st, since, paidAt: cn.paidAt || '', settledAt: cn.settledAt || '' };
};
Envelopes.cnChip = (st) => h('span', { class: 'chip ' + Envelopes.CN_LABEL[st][1] }, Envelopes.CN_LABEL[st][0]);

Envelopes.cnCard = (env, envs, t, s, redraw) => {
  const info = Envelopes.cnInfo(env, t);
  const can = DB.can('cn');
  const cn = env.cn || { docs: [] };
  const save = async (fn, action, details) => {
    const next = JSON.parse(JSON.stringify(cn));
    next.docs = next.docs || [];
    fn(next);
    env.cn = next;
    await DB.save('envelopes', envs);
    await Activity.add('envelopes', action, Activity.envTarget(env, s), details);
    U.toast('تم الحفظ', 'ok');
    redraw();
  };
  const issuer = env.supplierTaxId || (env.invoices.find((i) => i.issuerId) || {}).issuerId || '';
  const fromEta = async () => {
    if (!await ETA.ready()) return U.alert('الربط غير مُعد', 'أدخل Client ID و Client Secret من الإعدادات ← ربط الضرائب.');
    if (!/^\d{9}$/.test(issuer)) return U.alert('الرقم الضريبي للمورد غير معروف', 'الفواتير في هذا الظرف لا تحمل الرقم الضريبي للمورد. أضف الإشعار يدوياً.');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
    const from = U.monthFirst(env.month);
    const b = U.busy('البحث عن الإشعارات الدائنة في منظومة الضرائب...');
    let found;
    try { found = await ETA.searchReceived({ issuerId: issuer, from, to: today, onlyValid: true, docType: 'c', onProgress: b.set }); }
    catch (e) { b.done(); return U.alert('تعذر البحث', e.message); }
    b.done();
    const used = new Set();
    for (const e of envs) for (const d of ((e.cn && e.cn.docs) || [])) if (d.uuid) used.add(d.uuid);
    const fresh = found.filter((d) => !used.has(d.uuid));
    if (!fresh.length) return U.alert('لا توجد إشعارات جديدة', found.length ? 'كل الإشعارات الدائنة الصادرة من المورد مربوطة بالفعل بأظرف.' : `لا توجد إشعارات دائنة صالحة من المورد ${issuer} من ${U.fmtDay(from)} حتى اليوم.`);
    const picked = new Set();
    const ok = await U.modal({
      title: 'إشعارات دائنة صادرة من المورد', wide: true,
      body: h('div', { class: 'table-wrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['', 'رقم الإشعار', 'التاريخ', 'القيمة'].map((x) => h('th', null, x)))),
        h('tbody', null, fresh.map((d) => h('tr', null,
          h('td', null, h('input', { type: 'checkbox', 'aria-label': 'ربط ' + (d.internalId || ''), onChange: (e) => { if (e.target.checked) picked.add(d.uuid); else picked.delete(d.uuid); } })),
          h('td', null, h('strong', null, d.internalId || '—'), h('div', { class: 'sub num' }, d.uuid)),
          h('td', null, U.fmtDate(d.dateTimeIssued)), h('td', null, U.num(d.total))))))),
      actions: [{ label: 'ربط المحدد بهذا الظرف', value: true, cls: 'primary', validate: () => { if (!picked.size) { U.toast('اختر إشعاراً واحداً على الأقل', 'err'); return false; } return true; } }, { label: 'إلغاء', value: false }],
    });
    if (!ok) return;
    const add = fresh.filter((d) => picked.has(d.uuid)).map((d) => ({ uuid: d.uuid, internalId: d.internalId || '', date: String(d.dateTimeIssued || '').slice(0, 10), total: U.r2(Number(d.total) || 0), source: 'ETA', addedBy: DB.user.username, addedAt: new Date().toISOString() }));
    await save((n) => { n.docs.push(...add); }, 'ربط إشعار دائن', add.map((d) => `${d.internalId} · ${U.fmt(d.total)}`).join('\n'));
  };
  const manual = async () => {
    const no = h('input', { class: 'input' });
    const date = h('input', { class: 'input', type: 'date', value: new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' }) });
    const amount = h('input', { class: 'input', type: 'number', min: '0', step: 'any', value: info.rem || '' });
    const ok = await U.modal({
      title: 'إضافة إشعار دائن يدوياً',
      body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('label', { class: 'field' }, 'رقم الإشعار', no), h('label', { class: 'field' }, 'التاريخ', date), h('label', { class: 'field' }, 'القيمة (شاملة الضريبة)', amount)),
      actions: [{ label: 'إضافة', value: true, cls: 'primary', validate: () => { if (!no.value.trim() || !(Number(amount.value) > 0)) { U.toast('اكتب رقم الإشعار وقيمته', 'err'); return false; } return true; } }, { label: 'إلغاء', value: false }],
    });
    if (!ok) return;
    const d = { uuid: '', internalId: no.value.trim(), date: date.value, total: U.r2(Number(amount.value)), source: 'يدوي', addedBy: DB.user.username, addedAt: new Date().toISOString() };
    await save((n) => { n.docs.push(d); }, 'إضافة إشعار دائن يدوياً', `${d.internalId} · ${U.fmt(d.total)}`);
  };
  const paid = h('input', { class: 'input', type: 'date', value: info.paidAt, disabled: !can, style: 'max-width:180px', onChange: (e) => save((n) => { n.paidAt = e.target.value; }, 'تسجيل تاريخ السداد', e.target.value || 'حُذف التاريخ') });
  return h('section', { class: 'card no-print', 'aria-label': 'متابعة الإشعار الدائن والسداد' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'متابعة الإشعار الدائن والسداد'), h('div', { class: 'small muted' }, 'تتعدل حتى بعد الاعتماد وإقفال الشهر لأنها لا تغيّر أرقام الظرف')), Envelopes.cnChip(info.st)),
    h('div', { class: 'card-body grid' },
      Envelopes.stat('الإشعار المطلوب', info.req, 'warn'),
      Envelopes.stat('ما صدر من المورد', info.got),
      Envelopes.stat('المتبقي', info.rem, info.rem > 0.01 ? 'warn' : null),
      h('div', { class: 'stat' }, h('div', { class: 'label' }, 'منذ الاعتماد'), h('div', { class: 'value' }, info.since == null ? '—' : `${info.since} يوم`))),
    (cn.docs || []).length ? h('div', { class: 'table-wrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['رقم الإشعار', 'التاريخ', 'القيمة', 'المصدر', 'أضافه', ''].map((x) => h('th', null, x)))),
      h('tbody', null, cn.docs.map((d, i) => h('tr', null,
        h('td', null, h('strong', null, d.internalId || '—'), d.uuid ? h('div', { class: 'sub num' }, d.uuid) : null),
        h('td', null, U.fmtDay(d.date)), h('td', null, U.num(d.total)), h('td', { class: 'small' }, d.source || ''), h('td', { class: 'small' }, d.addedBy || ''),
        h('td', null, can ? h('button', { type: 'button', class: 'btn sm danger', onClick: async () => { if (await U.confirm('إزالة الإشعار ' + (d.internalId || '') + ' من الظرف؟', 'إزالة', true)) save((n) => { n.docs.splice(i, 1); }, 'إزالة إشعار دائن', `${d.internalId} · ${U.fmt(d.total)}`); } }, 'إزالة') : null)))))) : null,
    h('div', { class: 'card-body row' },
      can && info.req > 0 ? h('button', { type: 'button', class: 'btn primary', onClick: fromEta }, 'جلب من منظومة الضرائب') : null,
      can && info.req > 0 ? h('button', { type: 'button', class: 'btn', onClick: manual }, 'إضافة يدوياً') : null,
      can && info.req > 0 ? h('button', { type: 'button', class: 'btn', onClick: () => save((n) => { n.settledAt = n.settledAt ? '' : new Date().toISOString().slice(0, 10); }, info.settledAt ? 'إلغاء تسوية الإشعار الدائن' : 'تسوية الإشعار الدائن', '') }, info.settledAt ? 'إلغاء التسوية' : 'تمت التسوية (خُصم من السداد)') : null,
      h('span', { class: 'spacer' }),
      h('label', { class: 'row small' }, 'تاريخ السداد للمورد (لنموذج 41)', paid)));
};

Envelopes.ctx = async () => {
  const s = await DB.load('settings');
  const quotes = await DB.load('quotes', []);
  const quotesById = Object.fromEntries(quotes.map((q) => [q.id, q]));
  return { s, quotes, quotesById };
};

/* ===== القائمة ===== */
Envelopes.list = async () => {
  const { s, quotesById } = await Envelopes.ctx();
  const envs = await DB.load('envelopes', []);
  let term = '', status = '';
  const tbody = h('tbody');
  const draw = () => {
    const t = U.norm(term);
    const list = envs.filter((e) => (!t || U.norm(e.supplier + ' ' + U.monthName(e.month) + ' ' + Settings.catName(e.category, s)).includes(t)) &&
      (!status || (status === 'approved' ? e.status === 'approved' : e.status !== 'approved')))
      .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));
    U.fill(tbody, ...(list.length ? list.map((e) => {
      const c = Engine.calcEnvelope(e, quotesById, s);
      const done = c.invs.filter((x) => !x.t.pending).length;
      return h('tr', { class: 'clickable', onClick: () => { location.hash = '#/envelope/' + e.id; } },
        h('td', null, h('a', { href: '#/envelope/' + e.id, style: 'font-weight:600' }, e.supplier || 'بدون اسم')),
        h('td', null, U.monthName(e.month)),
        h('td', null, Settings.catName(e.category, s)),
        h('td', null, e.invoices.length, e.status !== 'approved' && e.invoices.length ? h('div', { class: 'sub' }, `راجعت ${done} من ${e.invoices.length}`) : null),
        h('td', null, U.num(c.t.invTotal)),
        h('td', null, c.t.cnTotal ? h('span', { style: 'color:var(--warn-dark);font-weight:600' }, U.num(c.t.cnTotal)) : '—'),
        h('td', null, h('strong', null, U.num(c.t.payable))),
        h('td', null, e.status === 'approved' ? h('span', { class: 'chip ok' }, 'معتمد') : (c.t.pending ? h('span', { class: 'chip warn' }, `قيد المراجعة · ${c.t.pending} بند`) : h('span', { class: 'chip gray' }, e.invoices.length ? 'قيد المراجعة · جاهز للاعتماد' : 'فارغ'))),
        h('td', { class: 'small' }, h('span', { class: 'num' }, Settings.fmtDT(Date.parse(e.updatedAt || e.createdAt))), h('div', { class: 'sub' }, e.updatedBy || e.createdBy || '')));
    }) : [h('tr', null, h('td', { colspan: 9, class: 'muted', style: 'padding:24px;text-align:center' }, envs.length ? 'لا نتائج' : 'لا توجد أظرف بعد — ابدأ بفتح ظرف مورد جديد'))]));
  };
  draw();
  const alerts = await Reports.alertsCard();
  return h('div', { style: 'display:flex;flex-direction:column;gap:18px' },
    alerts,
    h('div', { class: 'page-head' },
      h('div', null, h('h1', null, 'أظرف الموردين'), h('div', { class: 'small muted', style: 'margin-top:4px' }, 'الأظرف "قيد المراجعة" محفوظة كما تركتها — افتح أي ظرف وكمّل عليه.')),
      h('div', { class: 'row' },
        U.select([{ value: '', label: 'كل الأظرف' }, { value: 'draft', label: 'قيد المراجعة' }, { value: 'approved', label: 'معتمدة' }], status, (v) => { status = v; draw(); }, { style: 'width:150px', 'aria-label': 'الحالة' }),
        h('input', { class: 'input', placeholder: 'بحث بالمورد أو الشهر أو النوع', style: 'width:240px', onInput: (e) => { term = e.target.value; draw(); } }),
        h('button', { type: 'button', class: 'btn', onClick: () => Envelopes.importExcel(), title: 'استرجاع ظرف سبق تصديره من البرنامج بصيغة Excel' }, 'استيراد ظرف من Excel'),
        h('button', { type: 'button', class: 'btn primary', onClick: () => Envelopes.create() }, '+ طلب مراجعة ظرف مورد'))),
    h('div', { class: 'card table-wrap' }, h('table', { class: 't', style: 'min-width:960px' },
      h('thead', null, h('tr', null, ['المورد', 'شهر التسعير', 'النوع', 'الفواتير', 'إجمالي الفواتير', 'الإشعار الدائن', 'المستحق', 'الحالة', 'آخر تعديل'].map((x) => h('th', null, x)))),
      tbody)));
};

Envelopes.create = async () => {
  if (!DB.can('envelopes')) return U.toast('ليس لديك صلاحية فتح الأظرف', 'err');
  const s = await DB.load('settings');
  const now = new Date();
  const supplier = h('input', { class: 'input', placeholder: 'اختياري — يُقرأ من الفاتورة' });
  const month = h('input', { class: 'input', type: 'month', value: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}` });
  let category = s.categories[0].id;
  const ok = await U.modal({
    title: 'طلب مراجعة ظرف مورد',
    body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('label', { class: 'field' }, 'اسم المورد', supplier),
      h('label', { class: 'field' }, 'شهر التوريد (يُطبق عرض سعر هذا الشهر مهما كان تاريخ إصدار الفاتورة)', month),
      h('label', { class: 'field' }, 'نوع التوريد', U.select(s.categories.map((c) => ({ value: c.id, label: c.name })), category, (v) => { category = v; }))),
    actions: [{ label: 'فتح الظرف', value: true, cls: 'primary', validate: () => { if (!month.value) { U.toast('حدد الشهر', 'err'); return false; } return true; } }, { label: 'إلغاء', value: false }],
  });
  if (!ok) return;
  if (Envelopes.isClosed(s, month.value)) {
    if (DB.user.role !== 'admin') return U.alert('الشهر مقفل', `شهر ${U.monthName(month.value)} مقفل. لا يمكن فتح أظرف جديدة فيه إلا بعد فتح الفترة من المدير (الإعدادات ← إقفال الفترات).`);
    if (!await U.confirm(`شهر ${U.monthName(month.value)} مقفل. فتح ظرف فيه بصلاحية المدير؟ (يُسجل في سجل النشاط)`, 'متابعة')) return;
  }
  const qs = await Engine.quotesFor(month.value, category);
  if (!qs.some((q) => q.status === 'approved')) {
    const msg = qs.length
      ? `عرض سعر "${Settings.catName(category, s)}" لشهر ${U.monthName(month.value)} موجود لكنه مسودة. اعتمده أولاً من أرشيف عروض الأسعار.`
      : `لا يوجد عرض سعر "${Settings.catName(category, s)}" لشهر ${U.monthName(month.value)}. ارفعه أولاً من أرشيف عروض الأسعار.`;
    return U.alert('لا يمكن فتح الظرف', msg);
  }
  const envs = await DB.load('envelopes', []);
  const env = { id: U.uid(), supplier: supplier.value.trim(), month: month.value, category, status: 'draft', invoices: [], createdAt: new Date().toISOString(), createdBy: DB.user.username };
  envs.push(env);
  await Activity.add('envelopes', 'إنشاء ظرف', Activity.envTarget(env, s), '');
  await DB.save('envelopes', envs);
  location.hash = '#/envelope/' + env.id;
};

/* اختيار عرض السعر للفاتورة: تلقائي لو عرض واحد يغطي الشهر، وإلا يسأل المستخدم */
Envelopes.pickQuote = async (env, inv, s) => {
  const all = await Engine.quotesFor(env.month, env.category);
  const qs = all.filter((q) => q.status === 'approved').sort((a, b) => a.from.localeCompare(b.from));
  if (!qs.length) { await U.alert('لا يوجد عرض سعر معتمد', `لا يوجد عرض سعر معتمد "${Settings.catName(env.category, s)}" لشهر ${U.monthName(env.month)}.`); return null; }
  if (qs.length === 1 && Engine.coversMonth(qs[0])) return qs[0];
  const partial = qs.length === 1;
  const r = await U.modal({
    title: 'اختر عرض السعر المطبق',
    body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'notice' }, partial
        ? `عرض سعر "${Settings.catName(env.category, s)}" لشهر ${U.monthName(env.month)} يغطي من ${U.fmtDay(qs[0].from)} إلى ${U.fmtDay(qs[0].to)} فقط. هل التوريد في هذه الفترة؟`
        : `يوجد أكثر من عرض سعر لشهر ${U.monthName(env.month)}. حدد فترة التوريد الخاصة بهذه الفاتورة.`),
      h('div', { class: 'small muted' }, `الفاتورة ${inv.internalID || ''} · صدرت ${U.fmtDate(inv.dateIssued)} · ${inv.issuerName}`)),
    actions: qs.map((q) => ({ label: `${U.fmtDay(q.from)} – ${U.fmtDay(q.to)} (${q.items.length} صنف)`, value: q.id, cls: 'primary' })).concat([{ label: 'إلغاء — لا أعرف', value: null }]),
  });
  return r ? qs.find((q) => q.id === r) : null;
};

Envelopes.addTexts = async (env, envs, sources, s) => {
  if (!DB.can('envelopes')) { U.toast('ليس لديك صلاحية إضافة فواتير', 'err'); return 0; }
  const allEnvs = envs;
  let added = 0;
  for (const src of sources) {
    let invs;
    try { invs = Invoice.parse(src.text); } catch (e) { U.toast((src.name ? src.name + ': ' : '') + e.message, 'err'); continue; }
    for (const inv of invs) {
      if (inv.documentType && inv.documentType !== 'I') {
        U.toast(`المستند ${inv.internalID} ليس فاتورة (نوعه ${inv.documentType}) — تم تجاهله`, 'err');
        continue;
      }
      // فاتورة سبق إدخالها/مراجعتها؟
      const dups = Envelopes.findInvoice(allEnvs, inv);
      const same = dups.find((d) => d.env === env);
      if (same) {
        await U.alert('فاتورة مكررة في نفس الظرف', `الفاتورة ${inv.internalID || ''} موجودة بالفعل في هذا الظرف.\n${Envelopes.historyText(same, s)}\n\nلم تتم إضافتها مرة أخرى.`);
        continue;
      }
      if (dups.length) {
        const d = dups[0];
        const r = await U.modal({
          title: 'تمت مراجعة هذه الفاتورة من قبل',
          body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
            h('div', { class: 'notice bad' }, `الفاتورة ${inv.internalID || ''} — ${inv.issuerName || ''}`),
            dups.map((x) => h('p', { style: 'margin:0;line-height:1.9;white-space:pre-line' }, Envelopes.historyText(x, s, true))),
            h('div', { class: 'small muted' }, 'إضافتها مرة أخرى قد تعني صرفها مرتين.')),
          actions: [{ label: 'فتح الظرف السابق', value: 'open', cls: 'primary' }, { label: 'تخطي هذه الفاتورة', value: 'skip' }, { label: 'إضافتها على أي حال', value: 'add', cls: 'danger' }],
        });
        if (r === 'open') { location.hash = '#/envelope/' + d.env.id; return added; }
        if (r !== 'add') continue;
        inv.duplicateOverride = true;
      }
      inv.addedBy = DB.user.username;
      if (inv.status && String(inv.status).toLowerCase() !== 'valid') U.toast(`تنبيه: حالة الفاتورة ${inv.internalID} على البوابة "${inv.status}"`, 'err');
      const quote = await Envelopes.pickQuote(env, inv, s);
      if (!quote) return added;
      inv.quoteId = quote.id;
      for (const l of inv.lines) Object.assign(l, { m: null, received: null, rejected: false, confirmed: false, noQuoteAccepted: false, manualApproval: null, vatOverride: null });
      const b = U.busy('مطابقة بنود الفاتورة ' + (inv.internalID || '') + '...');
      try { await Engine.matchInvoice(inv, quote, env.category, { useAI: true, onStatus: b.set }); }
      catch (e) {
        if (e.quota) {
          // تنبيه واحد فقط كل 10 دقائق بدلاً من رسالة مع كل فاتورة
          if (!AI._quotaToastAt || Date.now() - AI._quotaToastAt > 600000) {
            U.toast('تمت المطابقة بدون ذكاء اصطناعي (بالأسماء والأسعار). ' + e.message + ' — راجع البنود البرتقالية.', 'warn');
            AI._quotaToastAt = Date.now();
          }
        } else {
          U.toast('تعذر استخدام الذكاء الاصطناعي: ' + e.message.split('\n')[0] + ' — تمت المطابقة بالأسماء والأسعار', 'err');
        }
        await Engine.matchInvoice(inv, quote, env.category, { useAI: false });
      }
      finally { b.done(); }
      if (!env.supplier && inv.issuerName) env.supplier = inv.issuerName;
      env.invoices.push(inv);
      env.updatedAt = new Date().toISOString(); env.updatedBy = DB.user.username;
      await Activity.add('envelopes', inv.duplicateOverride ? 'إضافة فاتورة مكررة (بموافقة المستخدم)' : 'إضافة فاتورة', Activity.envTarget(env, s),
        `فاتورة ${inv.internalID || '—'} · ${inv.issuerName || ''} · صدرت ${U.fmtDate(inv.dateIssued)} · ${inv.lines.length} بند · الإجمالي ${U.fmt(inv.total)}\nUUID: ${inv.uuid || '—'}`);
      added++;
      await DB.save('envelopes', allEnvs);
    }
  }
  return added;
};

/* البحث عن الفاتورة في كل الأظرف: بالـ UUID، أو برقم الفاتورة + الرقم الضريبي للمورد */
Envelopes.findInvoice = (envs, inv) => {
  const out = [];
  for (const e of envs) {
    for (const x of e.invoices) {
      const byUuid = inv.uuid && x.uuid && x.uuid === inv.uuid;
      const byNo = (!inv.uuid || !x.uuid) && inv.internalID && x.internalID === inv.internalID && (x.issuerId || '') === (inv.issuerId || '');
      if (byUuid || byNo) out.push({ env: e, inv: x });
    }
  }
  return out;
};

Envelopes.historyText = (d, s, withEnv) => {
  const dt = (iso) => Settings.fmtDT(Date.parse(iso));
  const lines = [];
  if (withEnv) lines.push(`في ظرف «${d.env.supplier || 'بدون اسم'} — ${Settings.catName(d.env.category, s)} ${U.monthName(d.env.month)}»`);
  lines.push(`أضيفت يوم ${dt(d.inv.addedAt)}${d.inv.addedBy ? ' بواسطة ' + d.inv.addedBy : ''}`);
  lines.push(d.inv.reviewedAt ? `وتمت مراجعتها يوم ${dt(d.inv.reviewedAt)}${d.inv.reviewedBy ? ' بواسطة ' + d.inv.reviewedBy : ''}` : 'ولم تكتمل مراجعتها بعد');
  if (withEnv) lines.push(d.env.status === 'approved' ? `حالة الظرف: معتمد يوم ${dt(d.env.approvedAt)} بواسطة ${d.env.approvedBy || ''}` : 'حالة الظرف: قيد المراجعة');
  return lines.join('\n');
};

Envelopes.pickItem = async (line, quote) => {
  let term = '';
  const list = h('div', { class: 'pick-list', role: 'listbox', 'aria-label': 'أصناف عرض السعر' });
  let chosen = null;
  const draw = () => {
    const ranked = (term ? Engine.fuzzy(term, quote.items, 400) : Engine.fuzzy(line.description, quote.items, 400)).filter((x) => x.it.name);
    U.fill(list, ...ranked.slice(0, 120).map(({ it, score }) => h('button', { type: 'button', role: 'option', onClick: () => { chosen = it; close(); } },
      h('span', null, h('strong', null, Engine.itemLabel(it)), h('span', { class: 'sub' }, `  بند ${it.no || '—'} · ${it.unit || 'بدون وحدة'}`)),
      h('span', { class: 'num' }, it.price == null ? '—' : U.fmt(it.price)))));
  };
  let close = () => {};
  const search = h('input', { class: 'input', placeholder: 'ابحث في أصناف عرض السعر', onInput: (e) => { term = e.target.value; draw(); } });
  draw();
  await U.modal({
    title: 'اختر الصنف المقابل',
    wide: true,
    onOpen: (c) => { close = () => c(null); },
    body: h('div', { style: 'display:flex;flex-direction:column;gap:10px' },
      h('div', { class: 'notice info' }, `صنف الفاتورة: ${line.description} — ${U.fmtQ(line.qty)} × ${U.fmt(line.price)}`),
      search, list),
    actions: [{ label: 'إلغاء', value: null }],
  });
  return chosen;
};

Envelopes.guessFactor = (price, itemPrice) => Engine.guessFactor(price, itemPrice);

/* ===== الاعتماد اليدوي لصنف غير موجود بعرض السعر ===== */
Envelopes.manualText = (ma) => `معتمد من ${ma.by}${ma.ref ? ' · مرجع ' + ma.ref : ''} · السعر المعتمد ${U.fmt(ma.price)}${ma.reason ? ' · السبب: ' + ma.reason : ''}`;

Envelopes.manualDialog = async (line, existing) => {
  const by = h('input', { class: 'input', value: existing ? existing.by : '', placeholder: 'مثلاً: أ. محمد — مدير المشتريات' });
  const ref = h('input', { class: 'input', value: existing ? existing.ref || '' : '', placeholder: 'رقم الموافقة / الإيميل / الطلب (اختياري)' });
  const price = h('input', { class: 'input', type: 'number', step: 'any', min: '0', value: existing ? existing.price : U.r2(line.price) });
  const reason = h('input', { class: 'input', value: existing ? existing.reason || '' : 'حاجة المطعم — صنف غير مدرج بعرض السعر' });
  const ok = await U.modal({
    title: 'اعتماد يدوي من إدارة المشتريات', minimizable: true, confirmClose: () => !!by.value.trim() || !!ref.value.trim(),
    body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'notice info' }, `${line.description} — ${U.fmtQ(line.qty)} × ${U.fmt(line.price)} (${line.unitType})`),
      h('label', { class: 'field' }, 'معتمد من (الاسم أو الوظيفة) *', by),
      h('label', { class: 'field' }, 'المرجع', ref),
      h('label', { class: 'field' }, 'السعر المعتمد للوحدة (لو أقل من سعر الفاتورة يُطلب الفرق في الإشعار الدائن)', price),
      h('label', { class: 'field' }, 'السبب', reason)),
    actions: [{
      label: 'اعتماد', value: true, cls: 'primary', validate: () => {
        if (!by.value.trim()) { U.toast('اكتب مين اعتمد الصنف', 'err'); return false; }
        if (!(Number(price.value) > 0)) { U.toast('اكتب السعر المعتمد', 'err'); return false; }
        return true;
      },
    }, { label: 'إلغاء', value: false }],
  });
  if (!ok) return null;
  return {
    by: by.value.trim(), ref: ref.value.trim(), price: U.r2(Number(price.value)), reason: reason.value.trim(),
    recordedBy: DB.user.username, recordedAt: new Date().toISOString(),
  };
};

/* ===== شاشة الظرف ===== */
Envelopes.view = async (id) => {
  const { s, quotesById } = await Envelopes.ctx();
  const envs = await DB.load('envelopes', []);
  const env = envs.find((e) => e.id === id);
  if (!env) return h('div', { class: 'notice bad' }, 'الظرف غير موجود');
  const root = h('div', { style: 'display:flex;flex-direction:column;gap:18px' });
  // الحفظ تلقائي بعد كل تعديل، مع مؤشر "تم الحفظ"
  const saveState = h('span', { class: 'small', style: 'color:var(--accent-dark)', 'aria-live': 'polite' });
  const showSaved = () => { saveState.textContent = env.updatedAt ? `✓ محفوظ تلقائياً · ${Settings.fmtDT(Date.parse(env.updatedAt))}` : '✓ محفوظ تلقائياً'; };
  const save = async () => { env.updatedAt = new Date().toISOString(); env.updatedBy = DB.user.username; await DB.save('envelopes', envs); showSaved(); };
  const opened = new Map(); // حالة فتح/طي كل فاتورة اختارها المستخدم: true مفتوحة، false مطوية
  const closed = Envelopes.isClosed(s, env.month);
  // مدير النظام يتخطى كل القيود (الاعتماد والإقفال)، والخادم يسجل كل تخطٍّ باسمه
  const isAdmin = DB.user.role === 'admin';
  const locked = () => (env.status === 'approved' && !isAdmin) || !DB.can('envelopes') || (closed && !isAdmin);
  // توزيع الفواتير على المطاعم مسموح حتى بعد الاعتماد (لا يغيّر الأرقام)، وممنوع في شهر مقفل لغير المدير
  const tagLock = (closed && !isAdmin) || !DB.can('envelopes');

  const addSources = async (sources) => {
    const n = await Envelopes.addTexts(env, envs, sources, s);
    if (n) U.toast(`تمت إضافة ${n} فاتورة`, 'ok');
    draw();
  };

  const draw = () => {
    const calc = Engine.calcEnvelope(env, quotesById, s);
    const t = calc.t;
    const lock = locked();
    const issuers = [...new Set(env.invoices.map((i) => i.issuerId).filter(Boolean))];
    // تسجيل وقت اكتمال مراجعة كل فاتورة (يُستخدم في تنبيه التكرار)
    let mark = false;
    // وقت المراجعة يُسجل للظرف المفتوح فقط (مجرد فتح المدير لظرف معتمد أو مقفل لا يُعد تعديلاً)
    if (!lock && env.status !== 'approved' && !closed) for (const x of calc.invs) {
      if (!x.t.pending && x.inv.lines.length && !x.inv.reviewedAt) { x.inv.reviewedAt = new Date().toISOString(); x.inv.reviewedBy = DB.user.username; mark = true; }
      else if (x.t.pending && x.inv.reviewedAt) { x.inv.reviewedAt = null; x.inv.reviewedBy = null; mark = true; }
    }
    if (mark && !lock) save();
    const doneCount = calc.invs.filter((x) => !x.t.pending).length;
    showSaved();

    // منطقة الإضافة
    const fileIn = h('input', { type: 'file', accept: '.json,.txt,application/json', multiple: true, class: 'hidden', onChange: async (e) => {
      const files = [...e.target.files];
      const sources = [];
      for (const f of files) sources.push({ name: f.name, text: await U.readText(f) });
      e.target.value = '';
      addSources(sources);
    } });
    const paste = h('textarea', { class: 'input', placeholder: 'الصق هنا الـ Response المنسوخ من F12 في موقع الضرائب (أو محتوى ملف JSON)', 'aria-label': 'لصق JSON الفاتورة' });
    const drop = h('div', { class: 'drop', style: 'flex:1 1 300px;cursor:pointer', role: 'button', tabindex: '0', 'aria-label': 'رفع ملفات JSON', onClick: () => fileIn.click(), onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') fileIn.click(); } },
      U.icon('<path d="M12 16V4"></path><path d="M7 9l5-5 5 5"></path><path d="M4 20h16"></path>', 26, '#1D4ED8'),
      h('div', null, h('div', { style: 'font-weight:600' }, 'ارفع ملفات JSON (فاتورة أو أكثر)'), h('div', { class: 'small muted' }, 'اضغط للاختيار أو اسحب الملفات هنا')), fileIn);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', async (e) => {
      e.preventDefault(); drop.classList.remove('over');
      const sources = [];
      for (const f of e.dataTransfer.files) sources.push({ name: f.name, text: await U.readText(f) });
      addSources(sources);
    });

    U.fill(root, 
      h('div', { class: 'page-head' },
        h('div', null,
          h('div', { class: 'crumb' }, h('a', { href: '#/envelopes' }, 'أظرف الموردين'), ' ‹ ', env.supplier || 'ظرف جديد'),
          h('h1', null, `ظرف: ${env.supplier || 'مورد'} — ${Settings.catName(env.category, s)} ${U.monthName(env.month)}`)),
        h('div', { class: 'row' },
          lock ? null : saveState,
          env.status === 'approved' ? h('span', { class: 'chip ok' }, `معتمد · ${env.approvedBy || ''}`) : null,
          lock ? null : h('button', { type: 'button', class: 'btn', onClick: async () => { await save(); U.toast('الظرف محفوظ — تقدر تكمله في أي وقت من قائمة أظرف الموردين', 'ok'); location.hash = '#/envelopes'; } }, 'حفظ وإغلاق'),
          h('a', { class: 'btn', href: '#/report/' + env.id }, 'الملخص والإشعار الدائن'),
          env.status !== 'approved' && DB.can('approve') && (!closed || isAdmin) ? h('button', {
            type: 'button', class: 'btn primary', disabled: !env.invoices.length, onClick: async () => {
              const c = Engine.calcEnvelope(env, quotesById, s);
              if (c.t.pending) return U.alert('لا يمكن الاعتماد بعد', `يوجد ${c.t.pending} بند يحتاج قرارك (تأكيد ربط أو صنف غير موجود بعرض السعر). راجع البنود المعلّمة باللون البرتقالي أو الأحمر.`);
              if (s.segregation && !isAdmin && (env.preparers || []).includes(DB.user.username)) return U.alert('لا يمكنك اعتماد هذا الظرف', 'الفصل بين المُعِد والمعتمِد مفعّل، وأنت شاركت في إعداد هذا الظرف. يعتمده مستخدم آخر لديه صلاحية الاعتماد.');
              const chk = await Envelopes.preApprove(env, s);
              if (chk.issues.length) {
                draw();
                if (!isAdmin) return U.alert('لا يمكن اعتماد الظرف', chk.issues.join('\n') + '\n\nاحذف الفاتورة من الظرف، أو اطلب من المورد فاتورة صحيحة.');
                const go = await U.modal({ title: 'تنبيه قبل الاعتماد', body: h('p', { style: 'margin:0;line-height:1.8;white-space:pre-line' }, chk.issues.join('\n') + '\n\nبصلاحية المدير تقدر تعتمد رغم ذلك، ويُسجل ذلك في سجل النشاط.'),
                  actions: [{ label: 'اعتماد رغم ذلك (المدير)', value: true, cls: 'danger' }, { label: 'إلغاء', value: false }] });
                if (!go) return;
                await Activity.add('envelopes', 'تخطٍّ بصلاحية المدير', Activity.envTarget(env, s), 'اعتماد رغم: ' + chk.issues.join(' · '));
              }
              if (!await U.confirm(`اعتماد الظرف؟ صافي المستحق للمورد ${U.fmt(c.t.payable)} وطلب إشعار دائن بإجمالي ${U.fmt(c.t.cnTotal)}. سيتم حفظ ربط الأصناف في الذاكرة للمرات القادمة.${chk.checked ? `\n\n✓ تم التحقق من ${chk.checked} فاتورة على منظومة الضرائب.` : ''}${chk.notes.length ? '\n\nتنبيه: ' + chk.notes.join('\n') : ''}`, 'اعتماد')) return;
              env.etaCheck = { at: new Date().toISOString(), checked: chk.checked, skipped: chk.skipped };
              env.whtRate = Engine.whtRateOf(env, s); // تُثبت نسبة الخصم والإضافة التي اعتُمد بها الظرف
              await Engine.learn(env, quotesById);
              env.status = 'approved'; env.approvedAt = new Date().toISOString(); env.approvedBy = DB.user.username;
              await Activity.add('envelopes', 'ملخص اعتماد الظرف', Activity.envTarget(env, s),
                `${env.invoices.length} فاتورة · إجمالي الفواتير ${U.fmt(c.t.invTotal)} · الإشعار الدائن ${U.fmt(c.t.cnTotal)} · خصم وإضافة ${U.fmt(c.t.wht)} · المستحق ${U.fmt(c.t.payable)}\nالتحقق من المنظومة: ${chk.checked} فاتورة${chk.notes.length ? '\n' + chk.notes.join('\n') : ''}`);
              await save();
              location.hash = '#/report/' + env.id;
            },
          }, 'اعتماد الظرف') : null,
          env.status === 'approved' && DB.can('approve') && (!closed || isAdmin) ? h('button', { type: 'button', class: 'btn', onClick: async () => { if (!await U.confirm('إعادة فتح الظرف المعتمد للتعديل أو لإضافة فواتير؟ سيرجع "قيد المراجعة" حتى تعتمده مرة أخرى.', 'إعادة فتح')) return; env.status = 'draft'; env.reopenedAt = new Date().toISOString(); env.reopenedBy = DB.user.username; await Activity.add('envelopes', 'إعادة فتح ظرف (تفاصيل)', Activity.envTarget(env, s), `كان معتمداً بواسطة ${env.approvedBy || ''} يوم ${Settings.fmtDT(Date.parse(env.approvedAt))}`); await save(); draw(); } }, 'إعادة فتح الظرف') : null,
          h('button', { type: 'button', class: 'btn', onClick: () => Activity.showFor(env.id, 'سجل تعديلات الظرف') }, 'سجل التعديلات'),
          isAdmin || (!closed && !lock && DB.can('envDelete')) ? h('button', { type: 'button', class: 'btn danger', onClick: async () => {
            if (!await U.confirm('حذف الظرف بكل فواتيره؟', 'حذف', true)) return;
            const c = Engine.calcEnvelope(env, quotesById, s);
            await Activity.add('envelopes', 'حذف ظرف', Activity.envTarget(env, s), `الحالة: ${env.status === 'approved' ? 'معتمد' : 'قيد المراجعة'} · الفواتير: ${env.invoices.map((i) => i.internalID).join('، ') || 'لا يوجد'} · إجمالي ${U.fmt(c.t.invTotal)}`);
            envs.splice(envs.indexOf(env), 1); await save(); location.hash = '#/envelopes';
          } }, 'حذف') : null)),

      h('div', { class: 'grid' },
        h('label', { class: 'field' }, 'اسم المورد (للعرض فقط)', h('input', { class: 'input', value: env.supplier, disabled: lock, onChange: async (e) => { const old = env.supplier; env.supplier = e.target.value.trim(); await Activity.add('envelopes', 'تعديل اسم المورد', Activity.envTarget(env, s), `من «${old || 'فارغ'}» إلى «${env.supplier || 'فارغ'}»`); await save(); draw(); } })),
        h('div', { class: 'field' }, 'شهر التسعير', h('div', { class: 'input', style: 'display:flex;align-items:center;font-weight:600;border-color:var(--accent)' }, U.monthName(env.month))),
        h('div', { class: 'field' }, 'نوع التوريد', h('div', { class: 'input', style: 'display:flex;align-items:center' }, Settings.catName(env.category, s))),
        h('div', { class: 'field' }, 'الفواتير', h('div', { class: 'input', style: 'display:flex;align-items:center' }, `${env.invoices.length} فاتورة`))),

      closed && !isAdmin ? h('div', { class: 'notice bad' }, `شهر ${U.monthName(env.month)} مقفل — الظرف للعرض فقط. الفتح من المدير (الإعدادات ← إقفال الفترات) بسبب مكتوب.`) : null,
      isAdmin && (closed || env.status === 'approved') ? h('div', { class: 'notice' }, `${closed ? `شهر ${U.monthName(env.month)} مقفل` : 'الظرف معتمد'} — بصلاحية مدير النظام تقدر تعدّل مباشرة، وكل تعديل يُسجل في سجل النشاط باسمك.`) : null,
      s.segregation && env.status !== 'approved' && (env.preparers || []).length ? h('div', { class: 'small muted' }, `أعدّ الظرف: ${(env.preparers || []).join('، ')} — الاعتماد لمستخدم آخر (الفصل بين المُعِد والمعتمِد مفعّل)`) : null,
      issuers.length > 1 ? h('div', { class: 'notice' }, 'تنبيه: الظرف يحتوي فواتير من أكثر من رقم تسجيل ضريبي.') : null,
      env.invoices.some((i) => Envelopes.wrongBuyer(i, s) || !Envelopes.validStatus(i.status)) ? h('div', { class: 'notice bad' }, 'يوجد فواتير ملغاة/مرفوضة أو صادرة لرقم ضريبي غير رقم شركتك (معلّمة بالأحمر) — لن يُسمح باعتماد الظرف بها.') : null,
      env.status === 'approved' ? Envelopes.cnCard(env, envs, t, s, draw) : null,

      lock ? null : h('div', { style: 'display:flex;flex-wrap:wrap;gap:12px;align-items:stretch' },
        drop,
        h('div', { style: 'flex:2 1 420px;display:flex;flex-direction:column;gap:8px' }, paste,
          h('div', null, h('button', { type: 'button', class: 'btn primary', onClick: () => { if (!paste.value.trim()) return U.toast('الصق نص الفاتورة أولاً', 'err'); addSources([{ name: '', text: paste.value }]); } }, 'إضافة الفاتورة الملصوقة'))),
        ETA.available() ? h('div', { class: 'drop', style: 'flex:1 1 260px;flex-direction:column;align-items:stretch;justify-content:center;border-style:solid;border-color:var(--accent);background:var(--accent-tint)' },
          h('div', { style: 'font-weight:600;color:var(--accent-dark)' }, 'جلب من منظومة الضرائب'),
          h('div', { class: 'small muted' }, 'اكتب الرقم الضريبي للمورد واختار الفواتير'),
          h('button', { type: 'button', class: 'btn primary', onClick: () => ETA.fetchDialog(env, envs, s, async (sources) => {
            await addSources(sources);
            // لو المستخدم تنقّل أثناء تصغير النافذة نعيد رسم الشاشة الحالية
            App.route();
          }) }, 'بحث بالرقم الضريبي')) : null),

      env.invoices.length ? h('div', { class: 'grid' },
        Envelopes.stat('صافي المبلغ بعد الإشعار', t.finalNet),
        Envelopes.stat('القيمة المضافة بعد الإشعار', t.finalVat),
        Envelopes.stat('طلب إشعار دائن', t.cnTotal, 'warn'),
        Envelopes.stat(`خصم وإضافة ${calc.whtRate}%`, t.wht, null, true),
        Envelopes.stat('المستحق للمورد', t.payable, 'good')) : null,

      env.invoices.length ? h('div', { class: t.pending && !lock ? 'notice' : 'notice info' },
        `تمت مراجعة ${doneCount} من ${env.invoices.length} فاتورة`,
        t.pending && !lock ? ` · ${t.pending} بند يحتاج قرارك قبل الاعتماد` : '',
        !lock ? ' · أضف الفاتورة التالية من الأعلى، أو اضغط "حفظ وإغلاق" وكمّل في وقت لاحق.' : '') : null,

      (s.restaurants || []).length && env.invoices.length && !tagLock ? (() => {
        let pick = '';
        const missing = env.invoices.filter((i) => !i.restaurantId).length;
        return h('div', { class: 'row small', style: 'gap:8px' },
          h('span', { class: 'muted' }, `المطاعم: ${missing ? missing + ' فاتورة بدون مطعم · ' : 'كل الفواتير موزعة · '}تعيين مطعم لكل فواتير الظرف`),
          U.select([{ value: '', label: 'اختر المطعم' }].concat(s.restaurants.map((r) => ({ value: r.id, label: r.name }))), '', (v) => { pick = v; }, { class: 'input cell', style: 'width:170px', 'aria-label': 'مطعم لكل الفواتير' }),
          h('button', { type: 'button', class: 'btn sm', onClick: async () => {
            if (!pick) return U.toast('اختر المطعم', 'err');
            if (!await U.confirm(`تعيين «${Envelopes.restName(pick, s)}» لكل فواتير الظرف (${env.invoices.length})؟`, 'تعيين')) return;
            for (const i of env.invoices) i.restaurantId = pick;
            await Activity.add('envelopes', 'تحديد مطعم لكل الفواتير', Activity.envTarget(env, s), Envelopes.restName(pick, s));
            await save(); draw();
          } }, 'تطبيق'));
      })() : null,

      ...calc.invs.map((x) => Envelopes.invoiceCard(env, x, s, lock, save, draw, opened, tagLock)));
  };
  draw();
  return root;
};

Envelopes.stat = (label, val, cls, neg) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, neg ? '(' : '', U.num(val), neg ? ')' : ''));

Envelopes.invoiceCard = (env, x, s, lock, save, draw, opened, tagLock) => {
  const { inv, quote, rows, t } = x;
  const vatOpts = [{ value: '', label: 'تلقائي' }, { value: '0', label: '0%' }, { value: '14', label: '14%' }];
  // الفاتورة المكتملة تُطوى تلقائياً في شريط رفيع، وأي فاتورة يقدر المستخدم يطويها أو يفتحها
  const st = opened ? opened.get(inv.id) : undefined;
  const collapsed = st === false || (st === undefined && !t.pending && inv.lines.length > 0);
  const setOpen = (v) => { opened.set(inv.id, v); draw(); };
  const no = inv.internalID || '—';
  const rest = Envelopes.restControl(env, inv, s, tagLock === undefined ? lock : tagLock, save, draw);
  const flags = [
    !Envelopes.validStatus(inv.status) ? h('span', { class: 'chip bad' }, `حالتها على المنظومة: ${inv.status}`) : null,
    Envelopes.wrongBuyer(inv, s) ? h('span', { class: 'chip bad' }, `صادرة لرقم ضريبي آخر (${inv.receiverId})`) : null,
  ];
  if (collapsed) {
    return h('section', { class: 'card inv-bar', 'aria-label': 'فاتورة ' + no },
      h('button', { type: 'button', class: 'bar-toggle', 'aria-expanded': 'false', 'aria-label': `فتح الفاتورة ${no}`, title: 'فتح الفاتورة', onClick: () => setOpen(true) }, '+'),
      h('strong', null, `فاتورة ${no}`),
      h('span', { class: 'small muted' }, U.fmtDate(inv.dateIssued)),
      rest,
      h('span', { class: 'small muted' }, `${inv.lines.length} بند`),
      h('span', { class: 'small' }, 'الصافي ', U.num(t.invNet)),
      t.cnTotal ? h('span', { class: 'small', style: 'color:var(--warn-dark);font-weight:600' }, 'إشعار ', U.num(t.cnTotal)) : null,
      h('span', { class: 'small' }, 'المستحق ', h('strong', null, U.num(t.payable))),
      h('span', { class: 'spacer' }),
      ...flags,
      t.pending ? h('span', { class: 'chip warn' }, `${t.pending} يحتاج قرار`) : h('span', { class: 'chip ok' }, '✓ تمت المراجعة'));
  }
  const toggle = h('button', { type: 'button', class: 'bar-toggle', 'aria-expanded': 'true', 'aria-label': `طي الفاتورة ${no}`, title: 'طي الفاتورة', onClick: () => setOpen(false) }, '−');
  const head = h('div', { class: 'card-head' },
    h('div', { class: 'inv-head' },
      toggle,
      h('h2', null, `فاتورة ${no}`),
      rest,
      h('span', { class: 'small muted' }, `صدرت ${U.fmtDate(inv.dateIssued)}`),
      h('span', { class: 'small muted' }, inv.issuerName),
      quote ? h('a', { class: 'small', href: '#/quote/' + quote.id }, `عرض السعر: ${U.fmtDay(quote.from)} – ${U.fmtDay(quote.to)}`) : h('span', { class: 'chip bad' }, 'عرض السعر محذوف'),
      t.pending ? h('span', { class: 'chip warn' }, `${t.pending} يحتاج قرار`) : h('span', { class: 'chip ok' }, '✓ تمت المراجعة'),
      ...flags,
      inv.reviewedAt ? h('span', { class: 'small muted' }, `${Settings.fmtDT(Date.parse(inv.reviewedAt))}${inv.reviewedBy ? ' · ' + inv.reviewedBy : ''}`) : null),
    lock || !quote ? null : h('div', { class: 'row' },
      h('button', {
        type: 'button', class: 'btn sm', onClick: async () => {
          if (!await AI.ready()) return U.alert('الذكاء الاصطناعي غير مُعد', 'أدخل مفتاح API من الإعدادات.');
          const b = U.busy('إعادة المطابقة بالذكاء الاصطناعي...');
          try {
            for (const l of inv.lines) if (!l.confirmed && l.m && l.m.src !== 'manual') l.m = null;
            await Engine.matchInvoice(inv, quote, env.category, { useAI: true, onStatus: b.set });
            await Activity.add('envelopes', 'إعادة المطابقة بالذكاء الاصطناعي', Activity.envTarget(env, s), `فاتورة ${inv.internalID || '—'}`);
            await save();
          } catch (e) { U.toast(e.message, 'err'); } finally { b.done(); draw(); }
        },
      }, 'إعادة المطابقة بالذكاء الاصطناعي'),
      h('button', { type: 'button', class: 'btn sm danger', onClick: async () => {
        if (!await U.confirm('حذف الفاتورة من الظرف؟', 'حذف', true)) return;
        await Activity.add('envelopes', 'حذف فاتورة', Activity.envTarget(env, s), `فاتورة ${inv.internalID || '—'} · ${inv.issuerName || ''} · صدرت ${U.fmtDate(inv.dateIssued)} · الإجمالي ${U.fmt(t.invTotal)}\nUUID: ${inv.uuid || '—'}`);
        env.invoices.splice(env.invoices.indexOf(inv), 1); await save(); draw();
      } }, 'حذف الفاتورة')));

  const body = h('tbody', null, rows.map(({ line: l, c }) => {
    // كل تعديل على البند يُسجل في سجل النشاط بالقيمة قبل وبعد
    const snap = () => {
      const it = l.m && quote ? quote.items.find((i) => i.id === l.m.itemId) : null;
      return {
        received: l.received == null ? l.qty : l.received, item: it ? Engine.itemLabel(it) : '', factor: l.m ? Number(l.m.factor) || 1 : null,
        vat: l.vatOverride == null ? 'تلقائي' : l.vatOverride + '%', rejected: !!l.rejected, accepted: !!l.noQuoteAccepted, confirmed: !!l.confirmed,
        manual: l.manualApproval ? Envelopes.manualText(l.manualApproval) : '',
      };
    };
    const logDiff = async (a, b) => {
      const tgt = Activity.envTarget(env, s);
      const pre = Activity.lineText(inv, l);
      const items = [];
      if (a.received !== b.received) items.push(['تعديل الكمية المستلمة', `من ${U.fmtQ(a.received)} إلى ${U.fmtQ(b.received)} (كمية الفاتورة ${U.fmtQ(l.qty)})`]);
      if (a.item !== b.item) items.push(['تغيير الصنف المربوط', `من «${a.item || 'بدون'}» إلى «${b.item || 'بدون'}»`]);
      else if (a.factor !== b.factor && b.factor != null) items.push(['تعديل معامل العبوة', `من ×${a.factor} إلى ×${b.factor}`]);
      if (a.vat !== b.vat) items.push(['تعديل نسبة ق.م', `من ${a.vat} إلى ${b.vat}`]);
      if (a.rejected !== b.rejected) items.push([b.rejected ? 'رفض صنف' : 'التراجع عن رفض صنف', '']);
      if (a.accepted !== b.accepted) items.push([b.accepted ? 'قبول صنف بسعر الفاتورة' : 'التراجع عن قبول صنف', '']);
      if (a.manual !== b.manual) {
        if (!a.manual) items.push(['اعتماد يدوي لصنف خارج العرض', b.manual]);
        else if (!b.manual) items.push(['إلغاء الاعتماد اليدوي', `كان: ${a.manual}`]);
        else items.push(['تعديل الاعتماد اليدوي', `من: ${a.manual}\nإلى: ${b.manual}`]);
      }
      if (!items.length && !a.confirmed && b.confirmed) items.push(['تأكيد ربط صنف', `مع «${b.item}» ×${b.factor}`]);
      for (const [action, d] of items) await Activity.add('envelopes', action, tgt, pre + (d ? '\n' + d : ''));
    };
    const set = async (fn) => { const a = snap(); fn(); await logDiff(a, snap()); await save(); draw(); };
    // تأكيد/اختيار الصنف/تعديل المعامل: يُحفظ في الذاكرة فوراً ويُطبق على البنود المشابهة
    const learn = async (fn) => {
      const a = snap();
      fn();
      await logDiff(a, snap());
      if (l.m && l.confirmed && !l.rejected) {
        const n = await Engine.remember(env, l, quote);
        if (n) await Activity.add('envelopes', 'تأكيد تلقائي من الذاكرة', Activity.envTarget(env, s), `${n} بند آخر بنفس اسم «${l.description}»`);
        U.toast(n ? `تم الحفظ في الذاكرة، وتأكد ${n} بند مشابه تلقائياً` : 'تم حفظ الربط في الذاكرة — لن يُطلب تأكيده مرة أخرى', 'ok');
      }
      await save(); draw();
    };
    const linkTo = (it) => learn(() => { l.m = { itemId: it.id, factor: Envelopes.guessFactor(l.price, it.price), conf: 1, src: 'manual', note: '' }; l.confirmed = true; l.noQuoteAccepted = false; l.manualApproval = null; l.rejected = false; });
    const pickAndLearn = async () => {
      const it = await Envelopes.pickItem(l, quote);
      if (it) linkTo(it);
    };
    // قائمة منسدلة بالبحث لاختيار/تغيير الصنف المقابل مباشرة من الجدول
    const combo = !lock && quote ? U.combo({
      placeholder: c.item ? 'تغيير: اكتب رقم البند أو الاسم' : 'اكتب رقم البند أو اسم الصنف',
      ariaLabel: 'اختيار الصنف المقابل من عرض السعر',
      search: (qq) => Engine.searchItems(quote, qq, l.description).map((it) => ({
        value: it.id, label: `${it.no ? it.no + ' — ' : ''}${Engine.itemLabel(it)}`, sub: it.unit || '', right: it.price == null ? '—' : U.fmt(it.price),
      })),
      onPick: (id) => { const it = quote.items.find((x) => x.id === id); if (it) linkTo(it); },
    }) : null;
    const manualApprove = async () => {
      const ma = await Envelopes.manualDialog(l, l.manualApproval);
      if (ma) set(() => { l.manualApproval = ma; l.m = null; l.confirmed = true; l.noQuoteAccepted = false; l.rejected = false; });
    };
    const statusCell = h('td', { style: 'min-width:210px' });
    const add = (...k) => statusCell.append(...k.flat(Infinity).filter((x) => x != null && x !== false));
    if (l.rejected) {
      add(h('span', { class: 'chip bad' }, 'مرفوض'), lock ? null : h('div', null, h('button', { type: 'button', class: 'linkbtn small', onClick: () => set(() => { l.rejected = false; }) }, 'تراجع')));
    } else if (c.status === 'nomatch') {
      add(h('span', { class: 'chip bad' }, 'غير موجود بالعرض'), lock ? null : h('div', { class: 'row', style: 'margin-top:6px' },
        h('button', { type: 'button', class: 'btn sm', onClick: pickAndLearn }, 'اختيار صنف'),
        h('button', { type: 'button', class: 'btn sm primary', onClick: manualApprove }, 'اعتماد يدوي'),
        h('button', { type: 'button', class: 'btn sm danger', onClick: () => set(() => { l.rejected = true; }) }, 'رفض')));
    } else if (c.status === 'review') {
      add(h('span', { class: 'chip warn' }, 'أكّد الربط'), h('div', { class: 'sub' }, `${Envelopes.SRC[l.m.src] || ''} · ثقة ${Math.round((l.m.conf || 0) * 100)}%`),
        lock ? null : h('div', { class: 'row', style: 'margin-top:6px' },
          h('button', { type: 'button', class: 'btn sm primary', onClick: () => learn(() => { l.confirmed = true; }) }, 'تأكيد'),
          h('button', { type: 'button', class: 'btn sm', onClick: pickAndLearn }, 'تغيير'),
          h('button', { type: 'button', class: 'btn sm', onClick: manualApprove, title: 'الصنف غير موجود في عرض السعر وإدارة المشتريات اعتمدته يدوياً' }, 'اعتماد يدوي'),
          h('button', { type: 'button', class: 'btn sm danger', onClick: () => set(() => { l.rejected = true; }) }, 'رفض')));
    } else if (c.manual) {
      const ma = c.manual;
      add(h('span', { class: 'chip dark' }, 'اعتماد يدوي'), c.reasons.length ? h('span', { class: 'chip warn', style: 'margin-inline-start:4px' }, 'إشعار دائن') : null,
        h('div', { class: 'sub', style: 'max-width:240px' }, `معتمد من: ${ma.by}${ma.ref ? ' · مرجع ' + ma.ref : ''} · السعر ${U.fmt(ma.price)}`),
        ma.reason ? h('div', { class: 'sub', style: 'max-width:240px' }, `السبب: ${ma.reason}`) : null,
        lock ? null : h('div', { class: 'row', style: 'margin-top:4px' },
          h('button', { type: 'button', class: 'linkbtn small', onClick: manualApprove }, 'تعديل'),
          h('button', { type: 'button', class: 'linkbtn small', onClick: pickAndLearn }, 'ربط بصنف من العرض'),
          h('button', { type: 'button', class: 'linkbtn small', onClick: () => set(() => { l.manualApproval = null; }) }, 'إلغاء الاعتماد')));
    } else {
      add(c.reasons.length ? h('span', { class: 'chip warn' }, 'إشعار دائن') : h('span', { class: 'chip ok' }, l.noQuoteAccepted ? 'مقبول بسعر الفاتورة' : 'مطابق'),
        l.m ? h('div', { class: 'sub' }, Envelopes.SRC[l.m.src] || '') : null,
        !lock && l.m ? h('div', null, h('button', { type: 'button', class: 'linkbtn small', onClick: pickAndLearn }, 'تغيير الصنف')) : null,
        !lock && l.noQuoteAccepted ? h('div', null, h('button', { type: 'button', class: 'linkbtn small', onClick: () => set(() => { l.noQuoteAccepted = false; }) }, 'تراجع')) : null);
    }
    if (c.notes.length || c.reasons.length) add(h('div', { class: 'sub', style: 'margin-top:4px;max-width:240px' }, [...c.reasons, ...c.notes].join(' · ')));

    const cls = c.status === 'nomatch' || l.rejected ? 'bad' : (c.cnTotal > 0 || c.status === 'review' ? 'short' : '');
    return h('tr', { class: cls },
      h('td', { class: 'muted' }, l.n),
      h('td', { style: 'min-width:190px' }, h('div', { style: 'font-weight:600' }, l.description), h('div', { class: 'sub' }, `كود ${l.internalCode || l.itemCode} · ${l.unitType}${l.itemName ? ' · ' + l.itemName : ''}`)),
      h('td', { style: 'min-width:240px' }, c.item ? [h('div', null, Engine.itemLabel(c.item)), h('div', { class: 'sub' }, `بند ${c.item.no || '—'} · ${c.item.unit || 'بدون وحدة'} · `, h('strong', { class: 'num' }, c.quotePrice != null ? U.fmt(c.quotePrice) : 'بدون سعر'))] : null,
        combo ? h('div', { style: c.item ? 'margin-top:6px' : '' }, combo) : (c.item ? null : h('span', { class: 'muted' }, '—'))),
      h('td', null, c.item ? (lock ? '×' + c.factor : h('input', { class: 'input cell short', type: 'number', min: '0', step: 'any', value: c.factor, 'aria-label': 'معامل العبوة', onChange: (e) => learn(() => { const v = Number(e.target.value); if (v > 0) { l.m.factor = v; l.m.src = 'manual'; l.confirmed = true; } }) })) : '—'),
      h('td', { style: 'font-weight:600' }, c.expected != null ? U.num(c.expected) : '—'),
      h('td', { style: c.expected != null && l.price > c.expected + 0.005 ? 'color:var(--danger);font-weight:700' : '' }, U.num(l.price)),
      h('td', null, U.fmtQ(l.qty)),
      h('td', null, lock ? U.fmtQ(c.received) : h('input', {
        class: 'input cell qty' + (c.received < l.qty ? ' changed' : ''), type: 'number', min: '0', max: String(l.qty), step: 'any', value: c.received, 'aria-label': 'المستلم فعلياً', disabled: l.rejected,
        onChange: (e) => set(() => {
          let v = e.target.value === '' ? l.qty : Number(e.target.value);
          if (v > l.qty) { U.toast('المستلم لا يمكن أن يزيد عن كمية الفاتورة', 'err'); v = l.qty; }
          l.received = Math.max(0, v);
        }),
      })),
      h('td', null, lock ? c.vatRate + '%' : U.select(vatOpts, l.vatOverride == null ? '' : l.vatOverride, (v) => set(() => { l.vatOverride = v === '' ? null : Number(v); }), { class: 'input cell', style: 'width:86px', 'aria-label': 'نسبة القيمة المضافة' }),
        h('div', { class: 'sub' }, `الفاتورة ${l.vatRate}%`)),
      h('td', { style: 'font-weight:600;color:var(--warn-dark)' }, c.cnTotal ? U.num(c.cnTotal) : '—'),
      statusCell);
  }));

  return h('section', { class: 'card', 'aria-label': 'فاتورة ' + (inv.internalID || '') }, head,
    h('div', { class: 'table-wrap' }, h('table', { class: 't', style: 'min-width:1100px' },
      h('thead', null, h('tr', null, ['#', 'صنف الفاتورة', 'الصنف في عرض السعر · سعره', 'معامل العبوة', 'السعر المرجعي', 'سعر الفاتورة', 'كمية الفاتورة', 'المستلم فعلياً', 'ق.م', 'الإشعار الدائن', 'الحالة'].map((x) => h('th', null, x)))),
      body,
      h('tfoot', null, h('tr', null,
        h('td', { colspan: 3 }, 'الفاتورة: صافي ', U.num(t.invNet), ' + ق.م ', U.num(t.invVat), t.other ? [' + ضرائب أخرى ', U.num(t.other)] : null, ' = ', U.num(t.invTotal)),
        h('td', { colspan: 3 }, 'بعد الإشعار: صافي ', U.num(t.finalNet), ' + ق.م ', U.num(t.finalVat)),
        h('td', { colspan: 3 }, `خصم وإضافة ${x.whtRate}%: `, U.num(t.wht), ' · المستحق ', U.num(t.payable)),
        h('td', { style: 'color:var(--warn-dark)' }, U.num(t.cnTotal)),
        h('td', null, ''))))));
};

/* ===== التقرير: ملخص الظرف + بيان الإشعار الدائن ===== */
Envelopes.report = async (id) => {
  const { s, quotesById } = await Envelopes.ctx();
  const envs = await DB.load('envelopes', []);
  const env = envs.find((e) => e.id === id);
  if (!env) return h('div', { class: 'notice bad' }, 'الظرف غير موجود');
  const calc = Engine.calcEnvelope(env, quotesById, s);
  const t = calc.t;
  const cnRows = [];
  for (const x of calc.invs) for (const r of x.rows) if (r.c.cnTotal > 0) cnRows.push({ inv: x.inv, l: r.line, c: r.c });
  const manualRows = [];
  for (const x of calc.invs) for (const r of x.rows) if (r.c.manual && !r.line.rejected) manualRows.push({ inv: x.inv, l: r.line, c: r.c });

  return h('div', { style: 'display:flex;flex-direction:column;gap:18px' },
    h('div', { class: 'page-head' },
      h('div', null,
        h('div', { class: 'crumb' }, h('a', { href: '#/envelope/' + env.id, class: 'no-print' }, 'رجوع للظرف'), ' ', `ظرف: ${env.supplier} · ${Settings.catName(env.category, s)} · تسعير ${U.monthName(env.month)}`),
        h('h1', null, 'ملخص ظرف المدفوعات'),
        h('div', { class: 'small muted', style: 'margin-top:4px' }, env.status === 'approved' ? `معتمد بواسطة ${env.approvedBy} في ${U.fmtDate(env.approvedAt)}` : 'مسودة — لم يُعتمد بعد')),
      h('div', { class: 'row no-print' },
        h('button', { type: 'button', class: 'btn', onClick: () => Envelopes.exportExcel(env, calc, cnRows, s, manualRows) }, 'تصدير Excel'),
        h('button', { type: 'button', class: 'btn primary', onClick: () => window.print() }, 'طباعة / حفظ PDF'))),
    t.pending ? h('div', { class: 'notice' }, `يوجد ${t.pending} بند لم يُحسم بعد في الظرف — الأرقام قد تتغير.`) : null,

    h('section', { class: 'card summary', 'aria-label': 'الخلاصة المالية' },
      h('div', { class: 'card-body grid' },
        Envelopes.band('صافي المبلغ بعد الإشعار', t.finalNet),
        Envelopes.band('القيمة المضافة بعد الإشعار', t.finalVat),
        Envelopes.band('طلب إشعار دائن (إجمالي)', t.cnTotal, true, 'var(--warn)'),
        Envelopes.band(`يخصم: خصم وإضافة ${calc.whtRate}%`, t.wht, true),
        Envelopes.band('صافي المستحق للدفع', t.payable, false, 'var(--accent)', true))),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'الفواتير داخل الظرف')),
      h('div', { class: 'table-wrap' }, h('table', { class: 't', style: 'min-width:900px' },
        h('thead', null, h('tr', null, ['رقم الفاتورة', 'تاريخ الإصدار', 'المطعم', 'الصافي', 'ق.م', 'الإجمالي', 'الإشعار الدائن', 'الصافي الفعلي', `خصم وإضافة ${calc.whtRate}%`, 'المستحق'].map((x) => h('th', null, x)))),
        h('tbody', null, calc.invs.map((x) => h('tr', null,
          h('td', null, h('strong', null, x.inv.internalID || '—'), h('div', { class: 'sub num' }, x.inv.uuid)),
          h('td', null, U.fmtDate(x.inv.dateIssued)),
          h('td', null, Envelopes.restName(x.inv.restaurantId, s) || h('span', { class: 'muted' }, '—')),
          h('td', null, U.num(x.t.invNet)), h('td', null, U.num(x.t.invVat)), h('td', null, U.num(x.t.invTotal)),
          h('td', { style: 'color:var(--warn-dark);font-weight:600' }, x.t.cnTotal ? U.num(x.t.cnTotal) : '—'),
          h('td', null, U.num(x.t.finalNet)), h('td', null, U.num(x.t.wht)), h('td', null, h('strong', null, U.num(x.t.payable)))))),
        h('tfoot', null, h('tr', null, h('td', { colspan: 3 }, 'إجمالي الظرف'),
          h('td', null, U.num(t.invNet)), h('td', null, U.num(t.invVat)), h('td', null, U.num(t.invTotal)),
          h('td', { style: 'color:var(--warn-dark)' }, U.num(t.cnTotal)), h('td', null, U.num(t.finalNet)), h('td', null, U.num(t.wht)), h('td', null, U.num(t.payable))))))),

    h('section', { class: 'card warn' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', { style: 'color:var(--warn-dark)' }, 'بيان طلب إشعار دائن — للإرسال للمورد'), h('div', { class: 'small muted' }, 'تُرسله أنت للمورد؛ البرنامج لا يرسل شيئاً'))),
      cnRows.length ? h('div', { class: 'table-wrap' }, h('table', { class: 't', style: 'min-width:900px' },
        h('thead', null, h('tr', null, ['الفاتورة', 'الصنف', 'سبب الفرق', 'الصافي', 'ق.م', 'الإجمالي'].map((x) => h('th', null, x)))),
        h('tbody', null, cnRows.map(({ inv, l, c }) => h('tr', null,
          h('td', null, inv.internalID),
          h('td', { style: 'font-weight:600' }, l.description),
          h('td', null, c.reasons.map((r) => h('div', { class: 'small' }, r))),
          h('td', null, U.num(c.cnNet)), h('td', null, U.num(c.cnVat)), h('td', null, h('strong', null, U.num(c.cnTotal)))))),
        h('tfoot', null, h('tr', null, h('td', { colspan: 3 }, 'إجمالي الإشعار الدائن المطلوب'),
          h('td', null, U.num(t.cnNet)), h('td', null, U.num(t.cnVat)), h('td', null, U.num(t.cnTotal))))))
        : h('div', { class: 'card-body muted' }, 'لا توجد فروقات — لا حاجة لإشعار دائن.')),

    Envelopes.restSummary(calc, s),

    env.status === 'approved' ? Envelopes.cnCard(env, envs, t, s, () => App.route()) : null,

    manualRows.length ? h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', null, h('h2', null, `أصناف معتمدة يدوياً خارج عرض السعر (${manualRows.length})`), h('div', { class: 'small muted' }, 'أصناف غير مدرجة بعرض سعر المشتريات واعتُمدت بموافقة يدوية'))),
      h('div', { class: 'table-wrap' }, h('table', { class: 't', style: 'min-width:1000px' },
        h('thead', null, h('tr', null, ['الفاتورة', 'الصنف', 'الكمية المستلمة', 'سعر الفاتورة', 'السعر المعتمد', 'الصافي المعتمد', 'معتمد من', 'المرجع', 'السبب', 'سُجل بواسطة'].map((x) => h('th', null, x)))),
        h('tbody', null, manualRows.map(({ inv, l, c }) => h('tr', null,
          h('td', null, inv.internalID),
          h('td', { style: 'font-weight:600' }, l.description),
          h('td', null, U.fmtQ(c.received)),
          h('td', null, U.num(l.price)),
          h('td', null, U.num(c.manual.price)),
          h('td', null, U.num(c.finalNet)),
          h('td', null, c.manual.by),
          h('td', null, c.manual.ref || '—'),
          h('td', { class: 'small' }, c.manual.reason || ''),
          h('td', { class: 'small' }, c.manual.recordedBy, h('div', { class: 'sub num' }, Settings.fmtDT(Date.parse(c.manual.recordedAt)))))))))) : null,

    h('div', { class: 'small muted' }, `ضريبة الخصم والإضافة محسوبة على الصافي الفعلي المعتمد بعد التعديلات · أُعد بواسطة ${DB.user.displayName} · ${new Date().toLocaleString('en-GB')}`));
};

/* توزيع قيمة الظرف على المطاعم (في التقرير) */
Envelopes.restTotals = (calc, s) => {
  const m = new Map();
  for (const x of calc.invs) {
    const k = x.inv.restaurantId && Envelopes.restName(x.inv.restaurantId, s) ? x.inv.restaurantId : '';
    const g = m.get(k) || { id: k, name: k ? Envelopes.restName(k, s) : 'بدون مطعم', invs: 0, net: 0, vat: 0, payable: 0 };
    g.invs++; g.net = U.r2(g.net + x.t.finalNet); g.vat = U.r2(g.vat + x.t.finalVat); g.payable = U.r2(g.payable + x.t.payable);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.net - a.net);
};
Envelopes.restSummary = (calc, s) => {
  if (!(s.restaurants || []).length || !calc.invs.length) return null;
  const rows = Envelopes.restTotals(calc, s);
  const total = rows.reduce((a, r) => a + r.net, 0);
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'التوزيع على المطاعم'), h('div', { class: 'small muted' }, 'قيمة التوريد الفعلية لكل مطعم في هذا الظرف (بعد الإشعار الدائن)'))),
    h('div', { class: 'table-wrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['المطعم', 'الفواتير', 'الصافي الفعلي', 'ق.م', 'الإجمالي شامل ق.م', 'النسبة'].map((x) => h('th', null, x)))),
      h('tbody', null, rows.map((r) => h('tr', { class: r.id ? '' : 'short' },
        h('td', { style: 'font-weight:600' }, r.name), h('td', null, r.invs), h('td', null, U.num(r.net)), h('td', null, U.num(r.vat)), h('td', null, U.num(U.r2(r.net + r.vat))),
        h('td', null, total ? Math.round((r.net / total) * 100) + '%' : '—')))))));
};

Envelopes.band = (label, val, neg, color, big) => h('div', { style: 'display:flex;flex-direction:column;gap:4px' },
  h('span', { class: 'small', style: 'color:' + (color || 'var(--muted)') }, label),
  h('span', { style: `font-size:${big ? 28 : 21}px;font-weight:700;color:${color || 'var(--ink)'}` }, neg ? '(' : '', U.num(val), neg ? ')' : ''));

Envelopes.exportExcel = async (env, calc, cnRows, s, manualRows) => {
  await Quotes.ensureXLSX();
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }, { RTL: true }, { RTL: true }] };
  const t = calc.t;
  const sum = [
    ['المورد', env.supplier], ['نوع التوريد', Settings.catName(env.category, s)], ['شهر التسعير', U.monthName(env.month)], [],
    ['رقم الفاتورة', 'UUID', 'تاريخ الإصدار', 'الصافي', 'ق.م', 'الإجمالي', 'الإشعار الدائن', 'الصافي الفعلي', 'ق.م الفعلية', `خصم وإضافة ${calc.whtRate}%`, 'المستحق', 'المطعم'],
    ...calc.invs.map((x) => [x.inv.internalID, x.inv.uuid, U.fmtDate(x.inv.dateIssued), x.t.invNet, x.t.invVat, x.t.invTotal, x.t.cnTotal, x.t.finalNet, x.t.finalVat, x.t.wht, x.t.payable, Envelopes.restName(x.inv.restaurantId, s)]),
    ['الإجمالي', '', '', t.invNet, t.invVat, t.invTotal, t.cnTotal, t.finalNet, t.finalVat, t.wht, t.payable],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(sum);
  ws1['!cols'] = [{ wch: 14 }, { wch: 30 }, { wch: 12 }, ...Array(8).fill({ wch: 13 })];
  XLSX.utils.book_append_sheet(wb, ws1, 'ملخص الظرف');
  const cn = [['الفاتورة', 'الصنف', 'سبب الفرق', 'الصافي', 'ق.م', 'الإجمالي'],
    ...cnRows.map(({ inv, l, c }) => [inv.internalID, l.description, c.reasons.join(' / '), c.cnNet, c.cnVat, c.cnTotal]),
    ['الإجمالي', '', '', t.cnNet, t.cnVat, t.cnTotal]];
  const ws2 = XLSX.utils.aoa_to_sheet(cn);
  ws2['!cols'] = [{ wch: 12 }, { wch: 36 }, { wch: 44 }, { wch: 12 }, { wch: 12 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws2, 'طلب إشعار دائن');
  const det = [['الفاتورة', '#', 'صنف الفاتورة', 'الصنف في العرض', 'سعر العرض', 'المعامل', 'السعر المرجعي', 'سعر الفاتورة', 'كمية الفاتورة', 'المستلم', 'ق.م %', 'صافي الفاتورة', 'الصافي الفعلي', 'الإشعار الدائن']];
  for (const x of calc.invs) for (const { line: l, c } of x.rows) {
    det.push([x.inv.internalID, l.n, l.description, c.item ? Engine.itemLabel(c.item) : '', c.quotePrice, c.factor, c.expected, U.r2(l.price), l.qty, c.received, c.vatRate, l.netTotal, c.finalNet, c.cnTotal]);
  }
  const ws3 = XLSX.utils.aoa_to_sheet(det);
  ws3['!cols'] = [{ wch: 10 }, { wch: 4 }, { wch: 34 }, { wch: 34 }, ...Array(10).fill({ wch: 11 })];
  XLSX.utils.book_append_sheet(wb, ws3, 'تفاصيل البنود');
  if (manualRows && manualRows.length) {
    const ws4 = XLSX.utils.aoa_to_sheet([['الفاتورة', 'الصنف', 'الكمية المستلمة', 'سعر الفاتورة', 'السعر المعتمد', 'الصافي المعتمد', 'معتمد من', 'المرجع', 'السبب', 'سُجل بواسطة', 'وقت التسجيل']]
      .concat(manualRows.map(({ inv, l, c }) => [inv.internalID, l.description, c.received, U.r2(l.price), c.manual.price, c.finalNet, c.manual.by, c.manual.ref || '', c.manual.reason || '', c.manual.recordedBy, Settings.fmtDT(Date.parse(c.manual.recordedAt))])));
    ws4['!cols'] = [{ wch: 10 }, { wch: 32 }, { wch: 10 }, { wch: 11 }, { wch: 11 }, { wch: 12 }, { wch: 22 }, { wch: 18 }, { wch: 34 }, { wch: 12 }, { wch: 20 }];
    wb.Workbook.Views.push({ RTL: true });
    XLSX.utils.book_append_sheet(wb, ws4, 'اعتماد يدوي');
  }
  XLSX.writeFile(wb, `ظرف ${env.supplier || ''} ${Settings.catName(env.category, s)} ${U.monthName(env.month)}.xlsx`);
};

/* ===== استيراد ظرف من ملف Excel سبق تصديره من البرنامج =====
 * الملف فيه: "ملخص الظرف" و"تفاصيل البنود" (و"اعتماد يدوي" إن وُجد). نعيد بناء الظرف منه.
 * ملاحظة: الإكسل لا يحمل ملف الفاتورة الأصلي (JSON)، فنُعيد الأرقام والربط والكميات المستلمة. */
Envelopes.parseDDMMYYYY = (t) => { const m = String(t || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T00:00:00Z` : ''; };
Envelopes.parseMonthName = (t) => {
  const m = String(t || '').trim().match(/^(\S+)\s+(\d{4})$/);
  if (!m) return null;
  const i = U.MONTHS.indexOf(m[1]);
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, '0')}`;
};

Envelopes.readExcelEnvelope = async (file) => {
  await Quotes.ensureXLSX();
  const wb = XLSX.read(await U.readBuffer(file), { type: 'array' });
  const sheet = (name) => wb.Sheets[wb.SheetNames.find((n) => n.trim() === name)];
  const sum = sheet('ملخص الظرف'), det = sheet('تفاصيل البنود');
  if (!sum || !det) throw new Error('الملف ليس ظرفاً مصدّراً من البرنامج (لا يحتوي ورقتي "ملخص الظرف" و"تفاصيل البنود").');
  const rows = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  const S = rows(sum);
  const meta = {};
  for (const r of S.slice(0, 6)) { if (r[0] === 'المورد') meta.supplier = String(r[1]); if (r[0] === 'نوع التوريد') meta.category = String(r[1]); if (r[0] === 'شهر التسعير') meta.month = String(r[1]); }
  const hi = S.findIndex((r) => r[0] === 'رقم الفاتورة');
  if (hi < 0) throw new Error('لم يتم العثور على جدول الفواتير في ورقة "ملخص الظرف".');
  const invoices = [];
  for (const r of S.slice(hi + 1)) {
    if (r[0] === '' || r[0] === 'الإجمالي') break;
    invoices.push({ internalID: String(r[0]), uuid: String(r[1] || ''), dateIssued: Envelopes.parseDDMMYYYY(r[2]), netTotal: Number(r[3]) || 0, vatTotal: Number(r[4]) || 0, total: Number(r[5]) || 0, restaurantName: String(r[11] || '').trim(), lines: [] });
  }
  const byNo = new Map(invoices.map((i) => [i.internalID, i]));
  const manual = new Map();
  const man = sheet('اعتماد يدوي');
  if (man) for (const r of rows(man).slice(1)) if (r[0] !== '') manual.set(`${r[0]}|${U.norm(r[1])}`, { by: String(r[6] || ''), ref: String(r[7] || ''), price: Number(r[4]) || Number(r[3]) || 0, reason: String(r[8] || ''), recordedBy: String(r[9] || DB.user.username), recordedAt: new Date().toISOString() });
  const D = rows(det);
  for (const r of D.slice(1)) {
    const inv = byNo.get(String(r[0]));
    if (!inv || r[2] === '') continue;
    inv.lines.push({
      n: Number(r[1]) || inv.lines.length + 1, description: String(r[2]), matchedLabel: String(r[3] || ''), factor: Number(r[5]) || 1,
      price: Number(r[7]) || 0, qty: Number(r[8]) || 0, received: Number(r[9]), vatRate: Number(r[10]) || 0, netTotal: Number(r[11]) || 0, actualNet: Number(r[12]) || 0,
      manual: manual.get(`${r[0]}|${U.norm(r[2])}`) || null,
    });
  }
  return { meta, invoices: invoices.filter((i) => i.lines.length) };
};

Envelopes.importExcel = async () => {
  if (!DB.can('envelopes')) return U.toast('ليس لديك صلاحية استيراد الأظرف', 'err');
  const pick = h('input', { type: 'file', accept: '.xlsx', class: 'hidden' });
  const file = await new Promise((res) => { pick.addEventListener('change', () => res(pick.files[0] || null)); pick.addEventListener('cancel', () => res(null)); pick.click(); });
  if (file) Envelopes.importExcelFile(file);
};

Envelopes.importExcelFile = async (file) => {
  if (!DB.can('envelopes')) return U.toast('ليس لديك صلاحية استيراد الأظرف', 'err');
  const s = await DB.load('settings');
  let data;
  const b = U.busy('قراءة ملف Excel...');
  try { data = await Envelopes.readExcelEnvelope(file); } catch (e) { b.done(); return U.alert('تعذر قراءة الملف', e.message); }
  b.done();
  const month = Envelopes.parseMonthName(data.meta.month);
  const cat = s.categories.find((c) => c.name === data.meta.category);
  if (!month || !cat) return U.alert('تعذر تحديد الظرف', `شهر التسعير أو نوع التوريد غير واضح في الملف (الشهر: ${data.meta.month || '—'} · النوع: ${data.meta.category || '—'}).`);
  const qs = (await Engine.quotesFor(month, cat.id)).filter((q) => q.status === 'approved').sort((a, c) => a.from.localeCompare(c.from));
  if (!qs.length) return U.alert('لا يوجد عرض سعر معتمد', `لاسترجاع الظرف لازم يكون عرض سعر "${cat.name}" لشهر ${U.monthName(month)} موجوداً ومعتمداً في أرشيف عروض الأسعار.`);
  const quote = qs.find((q) => Engine.coversMonth(q)) || qs[0];
  const envs = await DB.load('envelopes', []);
  const chosen = new Set(data.invoices.map((i) => i.internalID));
  const info = data.invoices.map((i) => ({ i, dups: Envelopes.findInvoice(envs, { uuid: i.uuid, internalID: i.internalID, issuerId: '' }) }));
  const ok = await U.modal({
    title: 'استيراد ظرف من Excel', wide: true,
    body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'notice info' }, `${data.meta.supplier} — ${cat.name} — ${U.monthName(month)} · ${data.invoices.length} فاتورة · سيُربط بعرض السعر ${U.fmtDay(quote.from)} – ${U.fmtDay(quote.to)}`),
      info.some((x) => x.dups.length) ? h('div', { class: 'notice' }, 'بعض الفواتير موجودة بالفعل في ظرف آخر. استيرادها يعني نسخة ثانية منها، فاحذف النسخة القديمة بعد الاستيراد حتى لا تُصرف مرتين.') : null,
      h('div', { class: 'table-wrap', style: 'max-height:340px;overflow-y:auto' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['', 'الفاتورة', 'التاريخ', 'البنود', 'الإجمالي', 'ملاحظة'].map((x) => h('th', null, x)))),
        h('tbody', null, info.map(({ i, dups }) => h('tr', { class: dups.length ? 'short' : '' },
          h('td', null, h('input', { type: 'checkbox', checked: true, 'aria-label': 'استيراد ' + i.internalID, onChange: (e) => { if (e.target.checked) chosen.add(i.internalID); else chosen.delete(i.internalID); } })),
          h('td', null, h('strong', null, i.internalID)), h('td', null, U.fmtDate(i.dateIssued)), h('td', null, i.lines.length), h('td', null, U.num(i.total)),
          h('td', { class: 'small' }, dups.length ? 'موجودة في: ' + dups.map((x) => `«${x.env.supplier || ''} — ${U.monthName(x.env.month)}»`).join('، ') : ''))))))),
    actions: [{ label: 'استيراد المحدد', value: true, cls: 'primary', validate: () => { if (!chosen.size) { U.toast('اختر فاتورة واحدة على الأقل', 'err'); return false; } return true; } }, { label: 'إلغاء', value: false }],
  });
  if (!ok) return;

  // إعادة بناء الظرف
  const byLabel = new Map(quote.items.map((it) => [U.norm(Engine.itemLabel(it)), it]));
  const findItem = (label) => { const k = U.norm(label); if (byLabel.has(k)) return byLabel.get(k); const best = Engine.fuzzy(label, quote.items, 1)[0]; return best && best.score >= 0.9 ? best.it : null; };
  let unmatched = 0, vatDiffs = 0;
  const invoices = [];
  for (const x of data.invoices.filter((v) => chosen.has(v.internalID))) {
    const lines = x.lines.map((l) => {
      const it = l.matchedLabel ? findItem(l.matchedLabel) : null;
      const vatAmount = U.r2(l.netTotal * l.vatRate / 100);
      const line = {
        n: l.n, description: l.description, itemName: '', itemCode: '', internalCode: '', unitType: '', qty: l.qty, unitValue: l.price, discount: 0, netTotal: l.netTotal,
        price: l.price, vatRate: l.vatRate, vatAmount, otherTaxes: 0, total: U.r2(l.netTotal + vatAmount),
        m: null, received: Number.isFinite(l.received) && l.received !== l.qty ? l.received : null, rejected: false, confirmed: false, noQuoteAccepted: false, manualApproval: null, vatOverride: null,
      };
      if (it) { line.m = { itemId: it.id, factor: l.factor, conf: 1, src: 'manual', note: '' }; line.confirmed = true; }
      else if (l.manual) line.manualApproval = l.manual;
      else if (!l.matchedLabel) { if (l.actualNet === 0 && l.netTotal > 0) line.rejected = true; else line.noQuoteAccepted = true; }
      else unmatched++;
      return line;
    });
    // مطابقة ضريبة القيمة المضافة لإجمالي الفاتورة الأصلي (فرق التقريب فقط)
    const diff = U.r2(x.vatTotal - lines.reduce((a, l) => a + l.vatAmount, 0));
    if (Math.abs(diff) > 0 && lines.length) { const big = lines.reduce((a, l) => (l.netTotal > a.netTotal ? l : a), lines[0]); big.vatAmount = U.r2(big.vatAmount + diff); big.total = U.r2(big.netTotal + big.vatAmount); if (Math.abs(diff) > 1) vatDiffs++; }
    invoices.push({
      id: U.uid(), restaurantId: ((s.restaurants || []).find((r) => r.name === x.restaurantName) || {}).id, uuid: x.uuid, internalID: x.internalID, documentType: 'I', dateIssued: x.dateIssued, issuerName: data.meta.supplier, issuerId: '', receiverName: '', status: 'Valid',
      netTotal: x.netTotal, vatTotal: x.vatTotal, otherTaxes: 0, total: x.total, lines, quoteId: quote.id, addedAt: new Date().toISOString(), addedBy: DB.user.username, importedFrom: file.name,
    });
  }
  const env = { id: U.uid(), supplier: data.meta.supplier, month, category: cat.id, status: 'draft', invoices, createdAt: new Date().toISOString(), createdBy: DB.user.username, updatedAt: new Date().toISOString(), updatedBy: DB.user.username, importedFrom: file.name };
  envs.push(env);
  await Activity.add('envelopes', 'استيراد ظرف من Excel', Activity.envTarget(env, s), `الملف ${file.name} · ${invoices.length} فاتورة${unmatched ? ` · ${unmatched} بند يحتاج ربط` : ''}`);
  await DB.save('envelopes', envs);
  U.toast(`تم استيراد ${invoices.length} فاتورة${unmatched ? ` — ${unmatched} بند يحتاج تأكيد الربط` : ' — كل البنود مربوطة'}${vatDiffs ? ' · راجع ضريبة القيمة المضافة في ' + vatDiffs + ' فاتورة' : ''}`, 'ok');
  location.hash = '#/envelope/' + env.id;
};
