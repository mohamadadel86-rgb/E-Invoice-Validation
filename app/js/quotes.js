/* أرشيف عروض الأسعار الشهرية: رفع (PDF عبر الذكاء الاصطناعي / Excel)، مراجعة، اعتماد */
'use strict';

const Quotes = {};

/* المكتبات محلية داخل البرنامج (app/vendor) مع بصمة تحقق SRI، فلا يُحمَّل أي كود من الإنترنت.
 * المصدر: SheetJS 0.20.3 من cdn.sheetjs.com · pdf.js 3.11.174 من npm (طابقت بصمتها بصمة jsDelivr الرسمية).
 * عند تحديث أي ملف يجب تحديث البصمة هنا واختبار tests/server.test.js يتحقق من تطابقهما. */
Quotes.LIBS = {
  xlsx: { src: 'app/vendor/xlsx/xlsx.full.min.js', integrity: 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT' },
  pdf: { src: 'app/vendor/pdfjs/pdf.min.js', integrity: 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e' },
  pdfWorker: { src: 'app/vendor/pdfjs/pdf.worker.min.js', integrity: 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2' },
};

Quotes.loadScript = (lib) => new Promise((resolve, reject) => {
  const abs = new URL(lib.src, document.baseURI).href;
  if ([...document.scripts].some((x) => x.src === abs)) return resolve();
  const s = document.createElement('script');
  s.src = lib.src; s.integrity = lib.integrity; s.crossOrigin = 'anonymous';
  s.onload = resolve;
  s.onerror = () => reject(new Error('تعذر تحميل مكتبة القراءة (ملف مفقود أو تم تعديله)'));
  document.head.append(s);
});
Quotes.ensureXLSX = async () => { if (!window.XLSX) await Quotes.loadScript(Quotes.LIBS.xlsx); };
Quotes.ensurePDF = async () => {
  if (!window.pdfjsLib) await Quotes.loadScript(Quotes.LIBS.pdf);
  // العامل (Worker) يُحمَّل من نفس موقع البرنامج (متوافق مع CSP: worker-src 'self')
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(Quotes.LIBS.pdfWorker.src, document.baseURI).href;
};
/* صور الصفحات تُخزن مشفرة منفصلة عن بيانات العرض */
Quotes.savePages = async (quoteId, pages) => {
  for (let i = 0; i < pages.length; i++) await DB.putImage(quoteId, i, pages[i]);
};
Quotes.loadPage = (quoteId, i) => DB.getImage(quoteId, i);
Quotes.deletePages = async (quoteId, n) => {
  for (let i = 0; i < n; i++) await DB.delImage(quoteId, i);
};

/* تغيير نوع عرض السعر (مثلاً من بقالة إلى جنرال).
 * ممنوع لو العرض مستخدم في أظرف محفوظة (الأظرف والربط المحفوظ مرتبطان بالنوع)، وممنوع لو يتداخل مع عرض آخر في النوع الجديد. */
Quotes.changeCategory = async (q, quotes, s, onDone) => {
  const envs = await DB.load('envelopes', []);
  if (envs.some((e) => e.invoices.some((i) => i.quoteId === q.id))) return U.alert('لا يمكن تغيير النوع', 'عرض السعر مستخدم في أظرف محفوظة، وتغيير نوعه يخلّ بمطابقتها. احذف الفواتير من الأظرف أولاً أو ارفع العرض من جديد بالنوع الصحيح.');
  let cat = q.category;
  const sel = U.select(s.categories.map((c) => ({ value: c.id, label: c.name })), cat, (v) => { cat = v; });
  const ok = await U.modal({
    title: 'تغيير نوع عرض السعر',
    body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'muted small' }, `النوع الحالي: ${Settings.catName(q.category, s)} — ${U.monthName(q.month)}`),
      h('label', { class: 'field' }, 'النوع الجديد', sel)),
    actions: [{ label: 'تغيير', value: true, cls: 'primary' }, { label: 'إلغاء', value: false }],
  });
  if (!ok || cat === q.category) return;
  const clash = quotes.filter((x) => x !== q && x.month === q.month && x.category === cat && x.from <= q.to && x.to >= q.from);
  if (clash.length) return U.alert('لا يمكن تغيير النوع', `يوجد عرض سعر "${Settings.catName(cat, s)}" لنفس الشهر وفترة متداخلة. عدّل فترة أحدهما أو احذف المكرر أولاً.`);
  const old = q.category;
  q.category = cat;
  await Activity.add('quotes', 'تعديل نوع عرض السعر', Activity.quoteTarget(q, s), `من ${Settings.catName(old, s)} إلى ${Settings.catName(cat, s)}`);
  await onDone();
  U.toast('تم تغيير النوع', 'ok');
};

Quotes.parsePrice = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = U.norm(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return s ? Number(s[0]) : null;
};

Quotes.flags = (q) => {
  const counts = {};
  for (const it of q.items) if (it.no) counts[it.no] = (counts[it.no] || 0) + 1;
  return q.items.map((it) => {
    const f = [];
    if (!it.name) f.push('اسم فارغ');
    if (it.price == null) f.push('سعر فارغ');
    else if (Number(it.price) <= 0) f.push('سعر صفر');
    if (!it.unit) f.push('وحدة غير مذكورة');
    if (it.no && counts[it.no] > 1) f.push('رقم مكرر');
    return f;
  });
};

/* ===== الأرشيف ===== */
Quotes.archive = async () => {
  const s = await DB.load('settings');
  const quotes = await DB.load('quotes', []);
  const months = [...new Set(quotes.map((q) => q.month))].sort().reverse();
  const cats = s.categories;
  const page = h('div', { style: 'display:flex;flex-direction:column;gap:18px' },
    h('div', { class: 'page-head' },
      h('div', null, h('div', { class: 'crumb' }, 'تُرفع مرة واحدة لكل شهر وتُستدعى تلقائياً عند فتح أي ظرف'), h('h1', null, 'أرشيف عروض الأسعار الشهرية')),
      DB.can('quotes') ? h('button', { type: 'button', class: 'btn primary', onClick: () => Quotes.upload() }, '+ رفع عرض سعر') : null));

  if (!months.length) {
    page.append(h('div', { class: 'card card-body', style: 'text-align:center;padding:40px' },
      h('h2', null, 'لا توجد عروض أسعار بعد'),
      h('p', { class: 'muted' }, 'ارفع عروض أسعار الشهر (PDF أو Excel) وحدد لكل ملف الشهر ونوع التوريد.'),
      DB.can('quotes') ? h('button', { type: 'button', class: 'btn primary', onClick: () => Quotes.upload() }, 'رفع أول عرض سعر') : null));
    return page;
  }

  page.append(h('div', { class: 'card table-wrap' }, h('table', { class: 't', style: 'min-width:860px' },
    h('thead', null, h('tr', null, h('th', null, 'الشهر'), cats.map((c) => h('th', null, c.name)))),
    h('tbody', null, months.map((m) => h('tr', null,
      h('th', { scope: 'row', style: 'background:#fff;font-size:15px;color:var(--ink)' }, U.monthName(m)),
      cats.map((c) => {
        const qs = quotes.filter((q) => q.month === m && q.category === c.id).sort((a, b) => a.from.localeCompare(b.from));
        if (!qs.length) {
          return h('td', null, h('div', { class: 'cell-box none' }, h('strong', null, 'غير مرفوع'),
            DB.can('quotes') ? h('button', { type: 'button', class: 'linkbtn small', onClick: () => Quotes.upload({ month: m, category: c.id }) }, 'رفع الآن') : null));
        }
        return h('td', null, h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, qs.map((q) => {
          const full = Engine.coversMonth(q);
          const cls = q.status !== 'approved' ? 'draft' : (full ? 'ok' : 'partial');
          return h('a', { href: '#/quote/' + q.id, class: 'cell-box ' + cls, style: 'text-decoration:none' },
            h('strong', null, q.status !== 'approved' ? 'مسودة — تحتاج مراجعة' : (full ? 'معتمد' : 'معتمد · فترة جزئية')),
            h('span', { class: 'small' }, `${q.items.length} صنف · ${U.fmtDay(q.from)} – ${U.fmtDay(q.to)}`));
        })));
      })))))));
  return page;
};

/* ===== الرفع ===== */
Quotes.upload = async (preset) => {
  if (!DB.can('quotes')) return U.toast('ليس لديك صلاحية رفع عروض الأسعار', 'err');
  const s = await DB.load('settings');
  const now = new Date();
  const defMonth = (preset && preset.month) || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const month = h('input', { class: 'input', type: 'month', value: defMonth });
  const from = h('input', { class: 'input', type: 'date', value: U.monthFirst(defMonth) });
  const to = h('input', { class: 'input', type: 'date', value: U.monthLast(defMonth) });
  month.addEventListener('change', () => { if (month.value) { from.value = U.monthFirst(month.value); to.value = U.monthLast(month.value); } });
  let category = (preset && preset.category) || s.categories[0].id;
  const catSel = U.select(s.categories.map((c) => ({ value: c.id, label: c.name })), category, (v) => { category = v; });
  const file = h('input', { class: 'input', type: 'file', accept: '.pdf,.xlsx,.xls,.csv,.jpg,.jpeg,.png,.webp', style: 'padding-top:8px' });
  const ok = await U.modal({
    title: 'رفع عرض سعر', minimizable: true, confirmClose: () => !!file.files[0],
    body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'grid' }, h('label', { class: 'field' }, 'شهر التسعير', month), h('label', { class: 'field' }, 'نوع التوريد', catSel)),
      h('div', { class: 'grid' }, h('label', { class: 'field' }, 'يسري من', from), h('label', { class: 'field' }, 'إلى', to)),
      h('div', { class: 'small muted' }, 'غيّر الفترة لو العرض لجزء من الشهر فقط (مثل السمك من 1 إلى 15).'),
      h('label', { class: 'field' }, 'الملف: PDF (يُقرأ بالذكاء الاصطناعي) أو Excel أو صورة', file)),
    actions: [{
      label: 'متابعة', value: true, cls: 'primary', validate: () => {
        if (!month.value || !from.value || !to.value) { U.toast('حدد الشهر والفترة', 'err'); return false; }
        if (from.value > to.value) { U.toast('تاريخ البداية بعد النهاية', 'err'); return false; }
        if (!file.files[0]) { U.toast('اختر الملف', 'err'); return false; }
        return true;
      },
    }, { label: 'إلغاء', value: false }],
  });
  if (!ok) return;
  const f = file.files[0];
  const meta = { month: month.value, category, from: from.value, to: to.value, source: f.name };
  if (Envelopes.isClosed(s, meta.month) && DB.user.role !== 'admin') return U.alert('الشهر مقفل', `شهر ${U.monthName(meta.month)} مقفل. لا يمكن رفع عروض أسعار له إلا بعد فتح الفترة من المدير.`);

  // عرض موجود لنفس الشهر والنوع والفترة المتداخلة؟
  const quotes = await DB.load('quotes', []);
  const overlap = quotes.filter((q) => q.month === meta.month && q.category === meta.category && q.from <= meta.to && q.to >= meta.from);
  let replace = [];
  if (overlap.length) {
    const r = await U.modal({
      title: 'يوجد عرض سعر لنفس الفترة',
      body: h('p', { style: 'margin:0;line-height:1.8' }, `يوجد ${overlap.length} عرض سعر "${Settings.catName(meta.category, s)}" لـ ${U.monthName(meta.month)} في فترة متداخلة. هل تريد استبداله؟`),
      actions: [{ label: 'استبدال القديم', value: 'replace', cls: 'warn' }, { label: 'إضافة بجانبه', value: 'add' }, { label: 'إلغاء', value: null }],
    });
    if (!r) return;
    if (r === 'replace') {
      const envs = await DB.load('envelopes', []);
      const used = overlap.filter((q) => envs.some((e) => e.invoices.some((i) => i.quoteId === q.id)));
      if (used.length) return U.alert('لا يمكن الاستبدال', 'عرض السعر القديم مستخدم في أظرف محفوظة. أضف العرض الجديد بجانبه أو احذف الأظرف أولاً.');
      replace = overlap;
    }
  }

  const ext = f.name.split('.').pop().toLowerCase();
  let items = [], pages = [], title = '';
  const failedPages = [];
  let lastErr = '';
  try {
    if (['xlsx', 'xls', 'csv'].includes(ext)) {
      items = await Quotes.fromExcel(f);
      if (!items) return;
    } else {
      if (!await AI.ready()) return U.alert('الذكاء الاصطناعي غير مُعد', 'ملفات PDF والصور تُقرأ بالذكاء الاصطناعي. أدخل مفتاح API من الإعدادات ← الذكاء الاصطناعي، أو ارفع الملف بصيغة Excel.');
      const b = U.busy('تجهيز صفحات الملف...');
      try {
        pages = ext === 'pdf' ? await Quotes.renderPDF(f) : [await Quotes.imageFile(f)];
        for (let i = 0; i < pages.length; i++) {
          b.set(`قراءة الصفحة ${i + 1} من ${pages.length} بالذكاء الاصطناعي...`);
          try {
            const res = await AI.extractQuotePage(pages[i], i + 1, Settings.catName(meta.category, s));
            if (!title && res.title) title = res.title;
            items.push(...Quotes.rowsToItems(res.rows, i + 1));
          } catch (e) { failedPages.push(i + 1); lastErr = e.message; }
        }
      } finally { b.done(); }
      if (failedPages.length === pages.length) return U.alert('تعذر قراءة الملف', lastErr);
    }
  } catch (e) { return U.alert('تعذر قراءة الملف', e.message); }

  const catVat = (s.categories.find((c) => c.id === meta.category) || {}).vat;
  items = items.filter((it) => it.name).map((it) => Object.assign({ id: U.uid(), vat: catVat == null ? null : catVat }, it));
  if (!items.length) return U.alert('لا توجد أصناف', 'لم يتم استخراج أي صنف من الملف.');

  const q = Object.assign({ id: U.uid(), title, status: 'draft', items, pageCount: pages.length, failedPages, createdAt: new Date().toISOString(), createdBy: DB.user.username }, meta);
  if (pages.length) await Quotes.savePages(q.id, pages);
  let list = await DB.load('quotes', []);
  for (const old of replace) await Quotes.deletePages(old.id, old.pageCount || 0);
  list = list.filter((x) => !replace.includes(x));
  list.push(q);
  for (const old of replace) await Activity.add('quotes', 'استبدال عرض سعر', Activity.quoteTarget(old, s), `حُذف واستُبدل بالملف ${meta.source} · كان به ${old.items.length} صنف`);
  await Activity.add('quotes', 'رفع عرض سعر', Activity.quoteTarget(q, s),
    `الملف ${meta.source} · ${items.length} صنف${pages.length ? ` · ${pages.length} صفحة مقروءة بالذكاء الاصطناعي` : ' · من Excel'}${failedPages.length ? ` · صفحات لم تُقرأ: ${failedPages.join('، ')}` : ''}`);
  await DB.save('quotes', list);
  if (failedPages.length) U.toast(`تعذر قراءة الصفحات: ${failedPages.join('، ')} — أعد قراءتها من شاشة عرض السعر`, 'err');
  else U.toast(`تم استخراج ${items.length} صنف — راجعها ثم اعتمد العرض`, 'ok');
  location.hash = '#/quote/' + q.id;
};

Quotes.rowsToItems = (rows, page) => rows.map((r) => ({
  no: r.no == null ? '' : String(r.no).trim(), name: String(r.name || '').trim(), spec: String(r.spec || '').trim(),
  unit: String(r.unit || '').trim(), price: Quotes.parsePrice(r.price), page,
}));

/* إعادة قراءة صفحة (فشلت أو قراءتها غير دقيقة) واستبدال أصنافها */
Quotes.rereadPage = async (q, quotes, pageNo, s) => {
  const img = await Quotes.loadPage(q.id, pageNo - 1);
  if (!img) return U.toast('صورة الصفحة غير محفوظة', 'err');
  const b = U.busy(`قراءة الصفحة ${pageNo} بالذكاء الاصطناعي...`);
  try {
    const res = await AI.extractQuotePage(img, pageNo, Settings.catName(q.category, s));
    const catVat = (s.categories.find((c) => c.id === q.category) || {}).vat;
    const fresh = Quotes.rowsToItems(res.rows, pageNo).filter((it) => it.name).map((it) => Object.assign({ id: U.uid(), vat: catVat == null ? null : catVat }, it));
    // الأصناف المستخدمة في أظرف لا تُحذف
    const envs = await DB.load('envelopes', []);
    const used = new Set();
    for (const e of envs) for (const inv of e.invoices) if (inv.quoteId === q.id) for (const l of inv.lines) if (l.m) used.add(l.m.itemId);
    const keep = q.items.filter((it) => it.page !== pageNo || used.has(it.id));
    const firstIdx = q.items.findIndex((it) => it.page > pageNo);
    const before = keep.filter((it) => !it.page || it.page < pageNo);
    const after = keep.filter((it) => it.page && it.page >= pageNo);
    q.items = firstIdx < 0 && !after.length ? keep.concat(fresh) : before.concat(fresh, after);
    q.failedPages = (q.failedPages || []).filter((p) => p !== pageNo);
    await Activity.add('quotes', 'إعادة قراءة صفحة', Activity.quoteTarget(q, s), `الصفحة ${pageNo} · ${fresh.length} صنف جديد`);
    await DB.save('quotes', quotes);
    U.toast(`تمت قراءة ${fresh.length} صنف من الصفحة ${pageNo}`, 'ok');
    return true;
  } catch (e) { U.alert('تعذر قراءة الصفحة', e.message); return false; } finally { b.done(); }
};

Quotes.renderPDF = async (file) => {
  await Quotes.ensurePDF();
  // isEvalSupported:false يغلق ثغرة CVE-2024-4367 (تنفيذ كود من خطوط PDF مخرّبة) · enableXfa:false يمنع نماذج XFA
  const pdf = await pdfjsLib.getDocument({ data: await U.readBuffer(file), isEvalSupported: false, enableXfa: false }).promise;
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2.5, 1600 / base.width) });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    // intent: print يمنع التوقف لو المستخدم انتقل لتبويب آخر أثناء القراءة
    await page.render({ canvasContext: ctx, viewport, intent: 'print' }).promise;
    out.push({ mime: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.85).split(',')[1] });
  }
  return out;
};
Quotes.imageFile = async (file) => {
  const url = await U.readDataURL(file);
  const [head, data] = url.split(',');
  return { mime: head.match(/data:([^;]+)/)[1], data };
};

Quotes.fromExcel = async (file) => {
  await Quotes.ensureXLSX();
  const wb = XLSX.read(await U.readBuffer(file), { type: 'array' });
  let sheetName = wb.SheetNames[0];
  const getRows = () => XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
  let rows = getRows();
  const guess = () => {
    let hr = rows.findIndex((r) => r.some((c) => /الصنف|البيان|اسم/.test(String(c))));
    if (hr < 0) hr = 0;
    const hdr = rows[hr] || [];
    const find = (re) => hdr.findIndex((c) => re.test(String(c).trim()));
    return { hr, name: find(/الصنف|البيان|اسم/), unit: find(/وحد/), price: find(/سعر/), spec: find(/مواصف|حجم|وزن/), no: find(/^(م|رقم|مسلسل|#)$/) };
  };
  let g = guess();
  const colLabel = (i) => XLSX.utils.encode_col(i) + (rows[g.hr] && rows[g.hr][i] ? ' — ' + rows[g.hr][i] : '');
  const wrap = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
  const draw = () => {
    const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
    const opts = [{ value: '-1', label: '— لا يوجد —' }].concat(Array.from({ length: width }, (_, i) => ({ value: String(i), label: colLabel(i) })));
    const sel = (k, label) => h('label', { class: 'field' }, label, U.select(opts, g[k], (v) => { g[k] = Number(v); draw(); }));
    const preview = rows.slice(g.hr + 1, g.hr + 9);
    U.fill(wrap, 
      wb.SheetNames.length > 1 ? h('label', { class: 'field' }, 'الورقة', U.select(wb.SheetNames.map((n) => ({ value: n, label: n })), sheetName, (v) => { sheetName = v; rows = getRows(); g = guess(); draw(); })) : null,
      h('label', { class: 'field' }, 'صف العناوين', h('input', { class: 'input short', type: 'number', min: '1', value: g.hr + 1, onChange: (e) => { g.hr = Math.max(0, Number(e.target.value) - 1); draw(); } })),
      h('div', { class: 'grid' }, sel('name', 'عمود الصنف *'), sel('price', 'عمود السعر *'), sel('unit', 'عمود الوحدة'), sel('spec', 'عمود المواصفة'), sel('no', 'عمود الرقم')),
      h('div', { class: 'table-wrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['الرقم', 'الصنف', 'المواصفة', 'الوحدة', 'السعر'].map((x) => h('th', null, x)))),
        h('tbody', null, preview.map((r) => h('tr', null, [g.no, g.name, g.spec, g.unit, g.price].map((i) => h('td', null, i >= 0 ? String(r[i]) : ''))))))));
  };
  draw();
  const ok = await U.modal({
    title: 'تحديد أعمدة ملف Excel', wide: true, body: wrap, minimizable: true, confirmClose: true, closeMsg: 'إلغاء استيراد ملف Excel؟',
    actions: [{ label: 'استيراد', value: true, cls: 'primary', validate: () => { if (g.name < 0 || g.price < 0) { U.toast('حدد عمود الصنف وعمود السعر', 'err'); return false; } return true; } }, { label: 'إلغاء', value: false }],
  });
  if (!ok) return null;
  const cell = (r, i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '');
  return rows.slice(g.hr + 1)
    .filter((r) => cell(r, g.name))
    .map((r) => ({ no: cell(r, g.no), name: cell(r, g.name), spec: cell(r, g.spec), unit: cell(r, g.unit), price: Quotes.parsePrice(g.price >= 0 ? r[g.price] : null) }));
};

/* ===== مراجعة / عرض عرض السعر ===== */
Quotes.view = async (id) => {
  const s = await DB.load('settings');
  const quotes = await DB.load('quotes', []);
  const q = quotes.find((x) => x.id === id);
  if (!q) return h('div', { class: 'notice bad' }, 'عرض السعر غير موجود');
  const closed = Envelopes.isClosed(s, q.month);
  const canEdit = DB.can('quotes') && (!closed || DB.user.role === 'admin');
  const save = async () => { await DB.save('quotes', quotes); };
  let onlyFlags = false, pageNo = 0, term = '';
  const root = h('div', { style: 'display:flex;flex-direction:column;gap:16px' });
  const img = h('img', { alt: 'صورة صفحة عرض السعر', style: 'width:100%;border-radius:8px;border:1px solid var(--line);background:#EEF1F3;min-height:200px' });
  const showPage = async () => { const p = await Quotes.loadPage(q.id, pageNo); img.src = p ? `data:${p.mime};base64,${p.data}` : ''; };

  const draw = () => {
    const flags = Quotes.flags(q);
    const flagged = flags.filter((f) => f.length).length;
    const t = U.norm(term);
    const vatOpts = [{ value: '', label: 'غير محدد' }, { value: '0', label: '0%' }, { value: '14', label: '14%' }];
    const rows = q.items.map((it, i) => ({ it, f: flags[i] })).filter((r) => (!onlyFlags || r.f.length) && (!t || U.norm(r.it.name + ' ' + r.it.spec).includes(t)));
    const FIELD = { no: 'رقم البند', name: 'اسم الصنف', spec: 'المواصفة', unit: 'الوحدة', price: 'السعر' };
    const tgt = Activity.quoteTarget(q, s);
    const inp = (it, k, cls, type) => canEdit
      ? h('input', { class: 'input cell ' + (cls || ''), type: type || 'text', step: type === 'number' ? 'any' : null, value: it[k] == null ? '' : it[k], onChange: async (e) => {
        const old = it[k];
        it[k] = type === 'number' ? Quotes.parsePrice(e.target.value) : e.target.value.trim();
        if (String(old ?? '') !== String(it[k] ?? '')) await Activity.add('quotes', `تعديل ${FIELD[k]}`, tgt, `الصنف «${it.name}»${q.status === 'approved' ? ' (عرض معتمد)' : ''}\nمن ${Activity.v(old)} إلى ${Activity.v(it[k])}`);
        await save(); draw();
      } })
      : (it[k] == null ? '' : String(it[k]));
    const full = Engine.coversMonth(q);
    U.fill(root, 
      h('div', { class: 'page-head' },
        h('div', null,
          h('div', { class: 'crumb' }, h('a', { href: '#/quotes' }, 'أرشيف عروض الأسعار'), ' ‹ ', q.source || ''),
          h('h1', null, `عرض سعر ${Settings.catName(q.category, s)} — ${U.monthName(q.month)}`),
          q.title ? h('div', { class: 'muted small', style: 'margin-top:4px' }, q.title) : null),
        h('div', { class: 'row' },
          q.status === 'approved' ? h('span', { class: 'chip ok' }, 'معتمد') : h('span', { class: 'chip warn' }, 'مسودة'),
          canEdit && q.status !== 'approved' ? h('button', {
            type: 'button', class: 'btn primary', onClick: async () => {
              if (flagged && !await U.confirm(`يوجد ${flagged} صنف عليه ملاحظات. اعتماد العرض على أي حال؟`, 'اعتماد')) return;
              q.status = 'approved'; q.approvedAt = new Date().toISOString(); q.approvedBy = DB.user.username;
              await Activity.add('quotes', 'اعتماد عرض سعر', tgt, `${q.items.length} صنف${flagged ? ` · ${flagged} صنف عليه ملاحظات` : ''}`);
              await save(); draw(); U.toast('تم اعتماد عرض السعر', 'ok');
            },
          }, 'اعتماد عرض السعر') : null,
          canEdit && q.status === 'approved' ? h('button', { type: 'button', class: 'btn', onClick: async () => { q.status = 'draft'; await Activity.add('quotes', 'إرجاع عرض سعر لمسودة', tgt, ''); await save(); draw(); } }, 'إرجاع لمسودة') : null,
          h('button', { type: 'button', class: 'btn', onClick: () => Quotes.exportExcel(q, s) }, 'تصدير Excel'),
          h('button', { type: 'button', class: 'btn', onClick: () => Activity.showFor(q.id, 'سجل تعديلات عرض السعر') }, 'سجل التعديلات'),
          canEdit ? h('button', {
            type: 'button', class: 'btn danger', onClick: async () => {
              const envs = await DB.load('envelopes', []);
              if (envs.some((e) => e.invoices.some((i) => i.quoteId === q.id))) return U.alert('لا يمكن الحذف', 'عرض السعر مستخدم في أظرف محفوظة.');
              if (!await U.confirm('حذف عرض السعر نهائياً؟', 'حذف', true)) return;
              await Activity.add('quotes', 'حذف عرض سعر', tgt, `الملف ${q.source || ''} · ${q.items.length} صنف · الحالة ${q.status === 'approved' ? 'معتمد' : 'مسودة'}`);
              await Quotes.deletePages(q.id, q.pageCount || 0);
              await DB.save('quotes', quotes.filter((x) => x !== q));
              location.hash = '#/quotes';
            },
          }, 'حذف') : null)),
      h('div', { class: 'card card-body grid' },
        h('div', null, h('div', { class: 'muted small' }, 'الشهر'), h('strong', null, U.monthName(q.month))),
        h('div', null, h('div', { class: 'muted small' }, 'النوع'), h('div', { class: 'row', style: 'gap:8px' }, h('strong', null, Settings.catName(q.category, s)),
          canEdit ? h('button', { type: 'button', class: 'btn sm', title: 'تغيير نوع عرض السعر', 'aria-label': 'تغيير نوع عرض السعر', onClick: () => Quotes.changeCategory(q, quotes, s, async () => { await save(); draw(); }) }, '⇄ تغيير') : null)),
        h('label', { class: 'field' }, 'يسري من', canEdit ? h('input', { class: 'input cell', type: 'date', value: q.from, onChange: async (e) => { const old = q.from; q.from = e.target.value; await Activity.add('quotes', 'تعديل فترة السريان', tgt, `البداية من ${U.fmtDay(old)} إلى ${U.fmtDay(q.from)}`); await save(); draw(); } }) : U.fmtDay(q.from)),
        h('label', { class: 'field' }, 'إلى', canEdit ? h('input', { class: 'input cell', type: 'date', value: q.to, onChange: async (e) => { const old = q.to; q.to = e.target.value; await Activity.add('quotes', 'تعديل فترة السريان', tgt, `النهاية من ${U.fmtDay(old)} إلى ${U.fmtDay(q.to)}`); await save(); draw(); } }) : U.fmtDay(q.to)),
        h('div', null, h('div', { class: 'muted small' }, 'التغطية'), full ? h('span', { class: 'chip ok' }, 'الشهر كامل') : h('span', { class: 'chip warn' }, 'جزء من الشهر'))),
      closed ? h('div', { class: DB.user.role === 'admin' ? 'notice' : 'notice bad' }, DB.user.role === 'admin' ? `شهر ${U.monthName(q.month)} مقفل — تعديلك بصلاحية المدير يُسجل في سجل النشاط.` : `شهر ${U.monthName(q.month)} مقفل — عرض السعر للعرض فقط.`) : null,
      q.failedPages && q.failedPages.length ? h('div', { class: 'notice bad row' },
        h('span', null, `لم تتم قراءة ${q.failedPages.length === 1 ? 'الصفحة' : 'الصفحات'} ${q.failedPages.join('، ')} بسبب انشغال خدمة الذكاء الاصطناعي.`),
        canEdit ? q.failedPages.map((p) => h('button', { type: 'button', class: 'btn sm', onClick: async () => { if (await Quotes.rereadPage(q, quotes, p, s)) draw(); } }, `قراءة صفحة ${p} الآن`)) : null) : null,
      h('div', { style: 'display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start' },
        q.pageCount ? h('div', { class: 'card', style: 'flex:1 1 300px;max-width:520px' },
          h('div', { class: 'card-head' }, h('h2', null, 'الملف الأصلي'),
            h('div', { class: 'row' },
              h('button', { type: 'button', class: 'btn sm', disabled: pageNo <= 0, onClick: () => { pageNo--; draw(); showPage(); } }, 'السابقة'),
              h('span', { class: 'small' }, `صفحة ${pageNo + 1} من ${q.pageCount}`),
              h('button', { type: 'button', class: 'btn sm', disabled: pageNo >= q.pageCount - 1, onClick: () => { pageNo++; draw(); showPage(); } }, 'التالية'),
              canEdit && q.status !== 'approved' ? h('button', { type: 'button', class: 'btn sm', onClick: async () => { if (await Quotes.rereadPage(q, quotes, pageNo + 1, s)) draw(); } }, 'إعادة قراءة الصفحة') : null)),
          h('div', { class: 'card-body' }, img)) : null,
        h('div', { class: 'card', style: 'flex:999 1 560px;min-width:0' },
          h('div', { class: 'card-head' },
            h('div', null, h('h2', null, `الأصناف (${q.items.length})`), h('div', { class: 'muted small' }, q.pageCount ? 'مستخرجة بالذكاء الاصطناعي من صورة ممسوحة — قارنها بالأصل وعدّل أي خطأ' : 'مستوردة من Excel')),
            h('div', { class: 'row' },
              h('input', { class: 'input', placeholder: 'بحث...', value: term, style: 'width:180px', onInput: (e) => { term = e.target.value; clearTimeout(Quotes._t); Quotes._t = setTimeout(() => { draw(); const el = root.querySelector('input[placeholder="بحث..."]'); el.focus(); el.setSelectionRange(term.length, term.length); }, 250); } }),
              flagged ? h('button', { type: 'button', class: 'btn sm ' + (onlyFlags ? 'warn' : ''), onClick: () => { onlyFlags = !onlyFlags; draw(); } }, `${flagged} ملاحظة`) : h('span', { class: 'chip ok' }, 'لا ملاحظات'))),
          h('div', { class: 'table-wrap' }, h('table', { class: 't', style: 'min-width:760px' },
            h('thead', null, h('tr', null, ['بند', 'الصنف', 'المواصفة', 'الوحدة', 'السعر', 'ق.م', 'ملاحظة', ''].map((x) => h('th', null, x)))),
            h('tbody', null, rows.map(({ it, f }) => h('tr', { class: f.length ? 'short' : '' },
              h('td', { style: 'width:70px' }, inp(it, 'no', 'short')),
              h('td', { style: 'min-width:220px' }, inp(it, 'name'), it.page && q.pageCount ? h('button', { type: 'button', class: 'linkbtn sub', onClick: () => { pageNo = it.page - 1; draw(); showPage(); } }, 'صفحة ' + it.page) : null),
              h('td', null, inp(it, 'spec')),
              h('td', { style: 'width:110px' }, inp(it, 'unit')),
              h('td', { style: 'width:110px' }, inp(it, 'price', 'short', 'number')),
              h('td', { style: 'width:110px' }, canEdit ? U.select(vatOpts, it.vat == null ? '' : it.vat, async (v) => { const old = it.vat; it.vat = v === '' ? null : Number(v); await Activity.add('quotes', 'تعديل نسبة ق.م', tgt, `الصنف «${it.name}»\nمن ${Settings.vatLabel(old)} إلى ${Settings.vatLabel(it.vat)}`); await save(); }, { class: 'input cell', 'aria-label': 'ق.م' }) : Settings.vatLabel(it.vat)),
              h('td', { class: 'small', style: 'color:var(--warn-dark);font-weight:600' }, f.join('، ')),
              h('td', null, canEdit ? h('button', { type: 'button', class: 'btn sm danger', 'aria-label': 'حذف الصنف', onClick: async () => { q.items = q.items.filter((x) => x !== it); await Activity.add('quotes', 'حذف صنف', tgt, `«${it.name}» · بند ${it.no || '—'} · ${it.unit || ''} · السعر ${Activity.v(it.price)}`); await save(); draw(); } }, '×') : null)))))),
          canEdit ? h('div', { class: 'card-body' }, h('button', { type: 'button', class: 'btn sm', onClick: async () => { q.items.push({ id: U.uid(), no: '', name: 'صنف جديد', spec: '', unit: '', price: null, vat: null }); await Activity.add('quotes', 'إضافة صنف', tgt, 'صنف جديد يدوياً'); await save(); draw(); } }, '+ إضافة صنف')) : null)));
  };
  draw();
  if (q.pageCount) showPage();
  return root;
};

Quotes.exportExcel = async (q, s) => {
  await Quotes.ensureXLSX();
  const data = [['بند', 'الصنف', 'المواصفة', 'الوحدة', 'السعر', 'ق.م %']].concat(q.items.map((it) => [it.no, it.name, it.spec, it.unit, it.price, it.vat == null ? '' : it.vat]));
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 6 }, { wch: 40 }, { wch: 22 }, { wch: 10 }, { wch: 10 }, { wch: 7 }];
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, 'عرض السعر');
  XLSX.writeFile(wb, `عرض سعر ${Settings.catName(q.category, s)} ${U.monthName(q.month)}.xlsx`);
};
