/* الربط الرسمي مع منظومة الفاتورة الإلكترونية (مصلحة الضرائب المصرية)
 * الطلبات تمر عبر الخادم المحلي (/api/v2/eta) لأن المتصفح لا يستطيع الاتصال بالمنظومة مباشرة.
 * Client Secret محفوظ عند الخادم فقط: يُكتب من الإعدادات ولا يعود للمتصفح أبداً (hasSecret فقط).
 */
'use strict';

const ETA = {
  SEARCH_GAP_MS: 2100, // حد المنظومة: طلب بحث كل ثانيتين
  DETAILS_GAP_MS: 600, // حد المنظومة: طلبان في الثانية لتفاصيل المستند
  MAX_DAYS: 29, // أقصى فترة بحث 30 يوماً
};

ETA.ENVS = { prod: 'الإنتاج (الحقيقي)', preprod: 'التجريبي (Pre-production)' };

ETA.available = () => true;
/* الإعدادات الظاهرة للمتصفح: بدون السر (hasSecret فقط) */
ETA.cfg = async () => Object.assign({ env: 'prod', clientId: '', receiverId: '', hasSecret: false }, (await DB.load('settings')).eta || {});
ETA.ready = async () => { try { return !!(await DB.call('GET', '/api/v2/eta/status')).ready; } catch (e) { return false; } };

ETA.friendly = (status, body) => {
  const msg = (body && (body.error && (body.error.message || body.error.details || body.error))) || '';
  if (status === 401 || /invalid_client/i.test(String(msg))) return 'بيانات الربط غير صحيحة (Client ID أو Client Secret) — راجعها في الإعدادات ← ربط الضرائب.';
  if (status === 403) return 'المنظومة رفضت استرجاع المستندات لهذا الحساب. غالباً الحساب عليه قيد "B2B Deny ERP Document Retrieval" على بوابة الضرائب — يُرفع من إعدادات الممول على البوابة.';
  if (status === 404) return 'المستند غير موجود على المنظومة.';
  if (status === 429) return 'المنظومة طلبت الانتظار بسبب كثرة الطلبات — حاول بعد دقيقة.';
  if (status === 502 || msg === 'network') return 'تعذر الاتصال بمنظومة الضرائب — تأكد من الإنترنت.';
  return 'خطأ من منظومة الضرائب' + (status ? ` (${status})` : '') + (msg && typeof msg === 'string' ? ': ' + msg : '');
};

ETA.call = async (p, query) => {
  for (let attempt = 0; attempt < 4; attempt++) {
    let j;
    try { j = await DB.call('POST', '/api/v2/eta', { path: p, query }); }
    catch (e) {
      if (e.code === 'eta-not-configured') throw new Error('أدخل Client ID و Client Secret من الإعدادات ← ربط الضرائب.');
      if (e.status === 502) throw new Error(ETA.friendly(502));
      throw e;
    }
    if (j.ok === false) throw new Error(ETA.friendly(j.status, { error: j.message }));
    if (j.status === 429 && attempt < 3) { await AI.sleep(((j.retryAfter || 2) + 1) * 1000); continue; }
    if (j.status < 200 || j.status >= 300) throw new Error(ETA.friendly(j.status, j.body));
    return j.body;
  }
  throw new Error(ETA.friendly(429));
};

/* اختبار الاتصال بالاعتمادات المحفوظة عند الخادم */
ETA.test = async () => {
  try {
    const r = await DB.call('POST', '/api/v2/eta/test', {});
    if (r.ok === false) throw new Error(ETA.friendly(r.status, { error: r.message }));
    return true;
  }
  catch (e) {
    if (e.code === 'eta-not-configured') throw new Error('أدخل Client ID و Client Secret من الإعدادات ← ربط الضرائب.');
    throw e;
  }
};

/* تحويل تاريخ يوم (بتوقيت القاهرة) إلى UTC بالصيغة المطلوبة، مع هامش يغطي التوقيت الصيفي والشتوي */
ETA.utcStart = (ymd) => new Date(ymd + 'T00:00:00+03:00').toISOString().slice(0, 19);
ETA.utcEnd = (ymd) => new Date(ymd + 'T23:59:59+02:00').toISOString().slice(0, 19);
ETA.addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
ETA.cairoDay = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });

/* البحث عن فواتير مستلمة من مورد خلال فترة (تُقسم لفترات 30 يوماً) */
ETA.searchReceived = async ({ issuerId, from, to, onlyValid, onProgress, docType }) => {
  const out = new Map();
  let start = from, chunk = 0;
  const chunks = [];
  while (start <= to) { const end = ETA.addDays(start, ETA.MAX_DAYS) < to ? ETA.addDays(start, ETA.MAX_DAYS) : to; chunks.push([start, end]); start = ETA.addDays(end, 1); }
  for (const [a, b] of chunks) {
    chunk++;
    let token = '', page = 0;
    do {
      if (page || chunk > 1) await AI.sleep(ETA.SEARCH_GAP_MS);
      page++;
      onProgress && onProgress(`البحث في منظومة الضرائب: ${U.fmtDay(a)} – ${U.fmtDay(b)} (صفحة ${page})...`);
      const body = await ETA.call('/api/v1.0/documents/search', {
        issueDateFrom: ETA.utcStart(a), issueDateTo: ETA.utcEnd(b), direction: 'Received', issuerId: (issuerId || '').trim(),
        documentType: docType || 'i', status: onlyValid ? 'Valid' : '', pageSize: 100, continuationToken: token,
      });
      for (const d of (body.result || [])) {
        const day = d.dateTimeIssued ? ETA.cairoDay(d.dateTimeIssued) : '';
        if (day && (day < from || day > to)) continue;
        out.set(d.uuid, d);
      }
      token = body.metadata && body.metadata.continuationToken;
    } while (token && token !== 'EndofResultSet');
  }
  return [...out.values()].sort((x, y) => (x.dateTimeIssued || '').localeCompare(y.dateTimeIssued || ''));
};

/* حالة المستند الحالية على المنظومة (للتحقق قبل الاعتماد): {status, receiverId} */
ETA.statusOf = async (uuid) => {
  const d = await ETA.call(`/api/v1.0/documents/${encodeURIComponent(uuid)}/details`, {});
  let receiverId = d && (d.receiverId || (d.receiver && d.receiver.id));
  if (!receiverId && d && typeof d.document === 'string') { try { const doc = JSON.parse(d.document); receiverId = doc.receiver && doc.receiver.id; } catch (e) { /* */ } }
  return { status: (d && d.status) || '', receiverId: String(receiverId || '') };
};

ETA.details = async (uuid) => {
  const d = await ETA.call(`/api/v1.0/documents/${encodeURIComponent(uuid)}/details`, {});
  if (d && !d.uuid) d.uuid = uuid; // نضمن وجود رقم المستند لاكتشاف التكرار
  return d;
};

/* ===== شاشة الإعدادات ===== */
ETA.settingsView = async () => {
  const s = await DB.load('settings');
  const c = await ETA.cfg();
  let env = c.env;
  const clientId = h('input', { class: 'input', value: c.clientId, autocomplete: 'off', style: 'direction:ltr' });
  const secret = h('input', { class: 'input', type: 'password', value: '', autocomplete: 'new-password', style: 'direction:ltr', placeholder: c.hasSecret ? 'محفوظ ✓ — اكتب قيمة جديدة فقط لو أردت تغييره' : 'Client Secret' });
  const rin = h('input', { class: 'input', value: c.receiverId, placeholder: 'مثلاً 123456789', style: 'direction:ltr' });
  const save = async (extra) => {
    // الخادم يسجل التغيير في سجل النشاط بنفسه؛ السر يُرسل فقط لو كتبته
    s.eta = Object.assign({ env, clientId: clientId.value.trim(), receiverId: rin.value.trim() }, secret.value.trim() ? { clientSecret: secret.value.trim() } : {}, extra || {});
    await DB.saveSettings(s);
    secret.value = '';
  };
  return h('div', { style: 'display:flex;flex-direction:column;gap:14px' },
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'ربط منظومة الفاتورة الإلكترونية')),
      h('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:12px' },
        h('div', { class: 'notice info', style: 'line-height:1.9' },
          'من أين أحصل على البيانات؟ مدير حساب الشركة على بوابة الفاتورة الإلكترونية يدخل على: ملف الممول (Taxpayer Profile) ← تسجيل نظام ERP (Register ERP)، فتظهر قيم Client ID و Client Secret. ',
          'البرنامج يستخدمها للقراءة فقط (البحث عن الفواتير المستلمة وجلب تفاصيلها) ولا يرسل أو يلغي أو يرفض أي مستند. الـ Client Secret يُحفظ مشفراً عند الخادم ولا يُعرض بعد الحفظ.'),
        h('label', { class: 'field' }, 'البيئة', U.select(Object.entries(ETA.ENVS).map(([v, label]) => ({ value: v, label })), env, (v) => { env = v; })),
        h('div', { class: 'grid' },
          h('label', { class: 'field' }, 'Client ID', clientId),
          h('label', { class: 'field' }, 'Client Secret', secret),
          h('label', { class: 'field' }, 'رقم التسجيل الضريبي للشركة (اختياري)', rin)),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn primary', onClick: async () => { try { await save(); U.toast('تم الحفظ', 'ok'); } catch (e) { U.toast(e.message, 'err'); } } }, 'حفظ'),
          h('button', {
            type: 'button', class: 'btn', onClick: async () => {
              const b = U.busy('الاتصال بمنظومة الضرائب...');
              try { await save(); await ETA.test(); U.toast('تم الاتصال بمنظومة الضرائب بنجاح ✓', 'ok'); } catch (e) { U.alert('تعذر الاتصال', e.message); } finally { b.done(); }
            },
          }, 'اختبار الاتصال'),
          c.hasSecret ? h('button', { type: 'button', class: 'btn danger', onClick: async () => { if (!await U.confirm('حذف Client Secret المحفوظ؟', 'حذف', true)) return; try { await save({ clearSecret: true }); U.toast('تم حذف السر', 'ok'); App.route(); } catch (e) { U.toast(e.message, 'err'); } } }, 'حذف السر المحفوظ') : null))));
};

/* ===== جلب فواتير مورد إلى الظرف ===== */
ETA.fetchDialog = async (env, envs, s, onDone) => {
  if (!await ETA.ready()) return U.alert('الربط غير مُعد', ETA.available() ? 'أدخل Client ID و Client Secret من الإعدادات ← ربط الضرائب.' : 'الربط مع الضرائب يعمل من نسخة سطح المكتب فقط.');
  const lastIssuer = env.supplierTaxId || (env.invoices.find((i) => i.issuerId) || {}).issuerId || '';
  const taxId = h('input', { class: 'input', value: lastIssuer, placeholder: 'الرقم الضريبي للمورد (9 أرقام)', style: 'direction:ltr' });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  const from = h('input', { class: 'input', type: 'date', value: U.monthFirst(env.month) });
  const toDef = ETA.addDays(U.monthLast(env.month), 60) < today ? ETA.addDays(U.monthLast(env.month), 60) : today;
  const to = h('input', { class: 'input', type: 'date', value: toDef });
  const onlyValid = h('input', { type: 'checkbox', checked: true });
  const results = h('div');
  let found = [];
  const picked = new Set();
  const counter = h('div', { class: 'small muted', style: 'margin-bottom:6px', 'aria-live': 'polite' });
  const allBox = h('input', { type: 'checkbox', 'aria-label': 'تحديد الكل' });
  const selectable = () => found.filter((d) => !d._dup);
  const updateCount = () => {
    counter.textContent = `${found.length} فاتورة · المحدد ${picked.size}`;
    allBox.checked = picked.size > 0 && picked.size === selectable().length;
  };
  allBox.addEventListener('change', () => {
    picked.clear();
    if (allBox.checked) for (const d of selectable()) picked.add(d.uuid);
    for (const box of results.querySelectorAll('.pick-box')) {
      const d = found[[...results.querySelectorAll('.pick-box')].indexOf(box)];
      box.checked = picked.has(d.uuid);
    }
    updateCount();
  });

  const drawResults = () => {
    if (!found.length) { U.fill(results, h('div', { class: 'muted small' }, 'لا توجد نتائج بعد.')); return; }
    updateCount();
    U.fill(results,
      counter,
      h('div', { class: 'table-wrap', style: 'max-height:340px;overflow-y:auto' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, h('th', null, allBox),
          ['رقم الفاتورة', 'تاريخ الإصدار', 'الإجمالي', 'الحالة', 'ملاحظة'].map((x) => h('th', null, x)))),
        h('tbody', null, found.map((d) => h('tr', { class: d._dup ? 'short' : '' },
          // التعليم يغيّر الخانة والعداد فقط بدون إعادة رسم الجدول، فيبقى مكان التمرير كما هو
          h('td', null, h('input', { type: 'checkbox', class: 'pick-box', 'aria-label': 'تحديد ' + d.internalId, checked: picked.has(d.uuid), onChange: (e) => { if (e.target.checked) picked.add(d.uuid); else picked.delete(d.uuid); updateCount(); } })),
          h('td', null, h('strong', null, d.internalId || '—'), h('div', { class: 'sub num' }, d.uuid)),
          h('td', null, U.fmtDate(d.dateTimeIssued)),
          h('td', null, U.num(d.total)),
          h('td', null, d.status === 'Valid' ? h('span', { class: 'chip ok' }, 'صالحة') : h('span', { class: 'chip warn' }, d.status)),
          h('td', { class: 'small' }, d._dup ? d._dup : '')))))));
  };

  const search = async () => {
    if (!/^\d{9}$/.test(taxId.value.trim())) return U.toast('الرقم الضريبي للمورد 9 أرقام', 'err');
    if (!from.value || !to.value || from.value > to.value) return U.toast('حدد فترة صحيحة', 'err');
    const b = U.busy('البحث في منظومة الضرائب...');
    try {
      found = await ETA.searchReceived({ issuerId: taxId.value, from: from.value, to: to.value, onlyValid: onlyValid.checked, onProgress: b.set });
      picked.clear();
      for (const d of found) {
        const dups = Envelopes.findInvoice(envs, { uuid: d.uuid, internalID: d.internalId, issuerId: d.issuerId });
        d._dup = dups.length ? 'سبق إضافتها: ' + dups.map((x) => `ظرف «${x.env.supplier || ''} — ${U.monthName(x.env.month)}»${x.inv.reviewedAt ? ' (تمت مراجعتها)' : ''}`).join('، ') : '';
        if (!d._dup) picked.add(d.uuid);
      }
      drawResults();
      if (!found.length) U.toast('لا توجد فواتير لهذا المورد في الفترة المحددة', 'warn');
    } catch (e) { U.alert('تعذر البحث', e.message); } finally { b.done(); }
  };
  drawResults();

  const ok = await U.modal({
    title: `جلب فواتير المورد من منظومة الضرائب — ${env.supplier || 'ظرف'} ${U.monthName(env.month)}`,
    wide: true,
    minimizable: true,
    confirmClose: () => found.length > 0 || taxId.value.trim() !== lastIssuer,
    closeMsg: 'هل تريد إغلاق نافذة الجلب؟ نتائج البحث الحالية ستُفقد ولن تُضاف أي فاتورة للظرف.',
    body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'grid' },
        h('label', { class: 'field' }, 'الرقم الضريبي للمورد', taxId),
        h('label', { class: 'field' }, 'تاريخ الإصدار من', from),
        h('label', { class: 'field' }, 'إلى', to)),
      h('div', { class: 'row' },
        h('label', { class: 'row small' }, onlyValid, 'الفواتير الصالحة فقط'),
        h('button', { type: 'button', class: 'btn primary', onClick: search }, 'بحث')),
      h('div', { class: 'small muted' }, `شهر التسعير ثابت (${U.monthName(env.month)}) مهما كان تاريخ إصدار الفاتورة. الفترة الافتراضية من بداية الشهر حتى شهرين بعده لأن بعض الموردين يصدرون الفاتورة متأخرة.`),
      results),
    actions: [{ label: 'إضافة المحدد للظرف', value: true, cls: 'primary', validate: () => { if (!picked.size) { U.toast('اختر فاتورة واحدة على الأقل', 'err'); return false; } return true; } }, { label: 'إلغاء', value: false }],
  });
  if (!ok) return;

  const uuids = found.filter((d) => picked.has(d.uuid)).map((d) => d.uuid);
  const sources = [];
  const b = U.busy('جلب تفاصيل الفواتير...');
  try {
    for (let i = 0; i < uuids.length; i++) {
      b.set(`جلب تفاصيل الفاتورة ${i + 1} من ${uuids.length}...`);
      if (i) await AI.sleep(ETA.DETAILS_GAP_MS);
      const d = await ETA.details(uuids[i]);
      sources.push({ name: 'ETA', text: JSON.stringify(d) });
    }
  } catch (e) { b.done(); if (!sources.length) return U.alert('تعذر جلب الفواتير', e.message); U.toast('توقف الجلب: ' + e.message, 'err'); }
  b.done();
  env.supplierTaxId = taxId.value.trim();
  await Activity.add('envelopes', 'جلب فواتير من منظومة الضرائب', Activity.envTarget(env, s), `الرقم الضريبي للمورد ${env.supplierTaxId} · الفترة ${U.fmtDay(from.value)} – ${U.fmtDay(to.value)} · تم جلب ${sources.length} فاتورة`);
  onDone(sources);
};
