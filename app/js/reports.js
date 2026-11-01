/* التقارير والمتابعة: الإشعارات الدائنة، نموذج 41 (الخصم والإضافة)، تقييم الموردين، اللوحة الشهرية، والتنبيهات */
'use strict';

const Reports = {};

Reports.today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
Reports.thisMonth = () => Reports.today().slice(0, 7);
Reports.addMonths = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

Reports.load = async () => {
  const { s, quotes, quotesById } = await Envelopes.ctx();
  const envs = await DB.load('envelopes', []);
  const rows = envs.map((env) => ({ env, calc: Engine.calcEnvelope(env, quotesById, s) }));
  return { s, quotes, quotesById, envs, rows };
};
/* مفتاح المورد: الرقم الضريبي إن وُجد، وإلا الاسم */
Reports.supplierOf = (env) => {
  const inv = env.invoices.find((i) => i.issuerId) || env.invoices[0] || {};
  return { id: env.supplierTaxId || inv.issuerId || '', name: env.supplier || inv.issuerName || 'بدون اسم' };
};
Reports.xlsx = async (file, sheets) => {
  await Quotes.ensureXLSX();
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: sheets.map(() => ({ RTL: true })) };
  for (const [name, aoa, cols] of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (cols) ws['!cols'] = cols.map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  XLSX.writeFile(wb, file);
};
Reports.head = (title, sub, ...actions) => h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('div', { class: 'small muted', style: 'margin-top:4px' }, sub) : null), h('div', { class: 'row no-print' }, ...actions));

/* ===== متابعة الإشعارات الدائنة ===== */
Reports.creditNotes = async () => {
  const { s, rows } = await Reports.load();
  const list = rows.filter((r) => r.env.status === 'approved' && r.calc.t.cnTotal > 0.005).map((r) => ({ ...r, info: Envelopes.cnInfo(r.env, r.calc.t), sup: Reports.supplierOf(r.env) }));
  let fStatus = 'open', term = '';
  const body = h('div');
  const filtered = () => list.filter((x) => (fStatus === 'all' || (fStatus === 'open' ? ['pending', 'partial'].includes(x.info.st) : ['received', 'settled'].includes(x.info.st)))
    && (!term || U.norm(x.sup.name + ' ' + x.sup.id).includes(U.norm(term)))).sort((a, b) => (b.info.since || 0) - (a.info.since || 0));
  const draw = () => {
    const l = filtered();
    const sum = (k) => U.r2(l.reduce((a, x) => a + x.info[k], 0));
    U.fill(body,
      h('div', { class: 'grid' },
        Envelopes.stat('إشعارات مطلوبة', sum('req'), 'warn'),
        Envelopes.stat('صدر من الموردين', sum('got')),
        Envelopes.stat('المتبقي لم يصدر', sum('rem'), sum('rem') > 0 ? 'warn' : null),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'متأخر أكثر من 30 يوم'), h('div', { class: 'value' }, l.filter((x) => x.info.rem > 0.01 && x.info.since > 30).length))),
      h('div', { class: 'card table-wrap' }, h('table', { class: 't', style: 'min-width:980px' },
        h('thead', null, h('tr', null, ['المورد', 'شهر التسعير', 'تاريخ الاعتماد', 'المطلوب', 'الصادر', 'المتبقي', 'منذ', 'تاريخ السداد', 'الحالة'].map((x) => h('th', null, x)))),
        h('tbody', null, l.length ? l.map((x) => h('tr', { class: 'clickable' + (x.info.rem > 0.01 && x.info.since > 30 ? ' bad' : ''), onClick: () => { location.hash = '#/report/' + x.env.id; } },
          h('td', null, h('a', { href: '#/report/' + x.env.id, style: 'font-weight:600' }, x.sup.name), h('div', { class: 'sub num' }, x.sup.id)),
          h('td', null, U.monthName(x.env.month)), h('td', null, U.fmtDate(x.env.approvedAt)),
          h('td', null, U.num(x.info.req)), h('td', null, U.num(x.info.got)), h('td', { style: x.info.rem > 0.01 ? 'font-weight:700;color:var(--warn-dark)' : '' }, U.num(x.info.rem)),
          h('td', null, x.info.since == null ? '—' : `${x.info.since} يوم`), h('td', null, x.info.paidAt ? U.fmtDay(x.info.paidAt) : '—'),
          h('td', null, Envelopes.cnChip(x.info.st)))) : h('tr', null, h('td', { colspan: 9, class: 'muted', style: 'text-align:center;padding:20px' }, 'لا توجد إشعارات في هذا الاختيار'))))));
  };
  draw();
  const exp = () => Reports.xlsx(`متابعة الإشعارات الدائنة ${Reports.today()}.xlsx`, [['الإشعارات الدائنة',
    [['المورد', 'الرقم الضريبي', 'شهر التسعير', 'تاريخ الاعتماد', 'المطلوب', 'الصادر', 'المتبقي', 'أيام منذ الاعتماد', 'تاريخ السداد', 'الحالة', 'أرقام الإشعارات']]
      .concat(filtered().map((x) => [x.sup.name, x.sup.id, U.monthName(x.env.month), U.fmtDate(x.env.approvedAt), x.info.req, x.info.got, x.info.rem, x.info.since, x.info.paidAt, Envelopes.CN_LABEL[x.info.st][0], ((x.env.cn && x.env.cn.docs) || []).map((d) => d.internalId).join('، ')])),
    [26, 12, 14, 12, 12, 12, 12, 10, 12, 16, 30]]]);
  return h('div', { style: 'display:flex;flex-direction:column;gap:18px' },
    Reports.head('متابعة الإشعارات الدائنة', 'كل إشعار طلبته من مورد في ظرف معتمد: هل أصدره فعلاً؟ اضغط على الظرف لربط الإشعار أو تسجيل التسوية والسداد.',
      U.select([{ value: 'open', label: 'لم تصدر بالكامل' }, { value: 'done', label: 'صدرت / تمت التسوية' }, { value: 'all', label: 'الكل' }], fStatus, (v) => { fStatus = v; draw(); }, { style: 'width:170px', 'aria-label': 'الحالة' }),
      h('input', { class: 'input', placeholder: 'بحث بالمورد', style: 'width:200px', onInput: (e) => { term = e.target.value; draw(); } }),
      h('button', { type: 'button', class: 'btn', onClick: exp }, 'تصدير Excel')),
    body);
};

/* ===== التقارير ===== */
Reports.view = async (tab) => {
  const tabs = [['restaurants', 'استهلاك المطاعم'], ['41', 'نموذج 41 (الخصم والإضافة)'], ['suppliers', 'تقييم الموردين'], ['dashboard', 'اللوحة الشهرية']];
  if (!tabs.some((x) => x[0] === tab)) tab = 'restaurants';
  const ctx = await Reports.load();
  const fn = { restaurants: Reports.restaurants, 41: Reports.form41, suppliers: Reports.suppliers, dashboard: Reports.dashboard }[tab];
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
    h('nav', { class: 'tabs no-print', 'aria-label': 'التقارير' }, tabs.map(([id, label]) => h('a', { href: '#/reports/' + id, class: id === tab ? 'active' : '' }, label))),
    await fn(ctx));
};

/* نموذج 41: ضريبة الخصم والإضافة المخصومة من الموردين في ربع سنة.
 * المصادر: (1) فواتير المنظومة المسحوبة — كل الموردين حتى غير المراجعين، بنسبة كل مورد، وتُطرح الإشعارات الدائنة،
 * ولو الفاتورة في ظرف معتمد يؤخذ صافيها الفعلي بعد المراجعة؛ (2) الأظرف المعتمدة حسب تاريخ السداد؛ (3) حسب شهر التسعير. */
Reports.form41 = async ({ s, rows }) => {
  const approved = rows.filter((r) => r.env.status === 'approved');
  let docs = [];
  try { docs = await DB.load('etadocs', []); } catch (e) { /* */ }
  // الصافي الفعلي لكل فاتورة داخل ظرف معتمد (بالـ UUID)
  const actual = new Map();
  for (const r of approved) for (const x of r.calc.invs) if (x.inv.uuid) actual.set(x.inv.uuid, x.t.finalNet);
  const now = Reports.thisMonth();
  const years = [...new Set(approved.map((r) => r.env.month.slice(0, 4)).concat(docs.map((d) => (d.date || '').slice(0, 4)).filter(Boolean), [now.slice(0, 4)]))].sort().reverse();
  let year = now.slice(0, 4), quarter = String(Math.floor((Number(now.slice(5)) - 1) / 3) + 1), basis = docs.length ? 'eta' : 'paid';
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
  const quarterMonths = () => [1, 2, 3].map((i) => `${year}-${String((Number(quarter) - 1) * 3 + i).padStart(2, '0')}`);

  /* سطور موحدة: {id, name, base, wht, rate, invs, detail[]} */
  const pick = () => {
    const ms = quarterMonths();
    const entries = [];
    let missing = 0;
    if (basis === 'eta') {
      for (const d of docs) {
        if (!d.date || !ms.includes(d.date.slice(0, 7)) || !Envelopes.validStatus(d.status)) continue;
        const sp = EtaDocs.supplier(s, d.issuerId, d.issuerName);
        const rate = EtaDocs.rateOf(s, d.issuerId);
        const fromEnv = d.type !== 'c' && actual.has(d.uuid);
        const base = d.type === 'c' ? -d.net : (fromEnv ? actual.get(d.uuid) : d.net);
        entries.push({ id: d.issuerId, name: sp.name, base: U.r2(base), rate, inv: d.type === 'i' ? 1 : 0,
          detail: [sp.name, d.issuerId, d.internalId, EtaDocs.TYPE[d.type] || d.type, d.date, U.r2(base), rate / 100, U.r2(base * rate / 100), fromEnv ? 'الصافي الفعلي من ظرف معتمد' : 'قيمة المنظومة'] });
      }
    } else {
      for (const r of approved) {
        const paid = r.env.cn && r.env.cn.paidAt;
        if (basis === 'paid' && !paid) { if (ms.includes(r.env.month)) missing++; continue; }
        if (!ms.includes(basis === 'paid' ? paid.slice(0, 7) : r.env.month)) continue;
        const sp = Reports.supplierOf(r.env);
        entries.push({ id: sp.id, name: EtaDocs.supplier(s, sp.id, sp.name).name, base: r.calc.t.finalNet, rate: r.calc.whtRate, wht: r.calc.t.wht, inv: r.env.invoices.length,
          detail: [sp.name, sp.id, r.env.invoices.map((i) => i.internalID).join('، '), 'ظرف معتمد', paid || U.monthName(r.env.month), r.calc.t.finalNet, r.calc.whtRate / 100, r.calc.t.wht, 'الأظرف المعتمدة'] });
      }
    }
    return { ms, entries, missing };
  };
  const group = (entries) => {
    const m = new Map();
    for (const e of entries) {
      const k = e.id || e.name;
      const g = m.get(k) || { id: e.id, name: e.name, invs: 0, base: 0, wht: 0, rates: new Set() };
      g.invs += e.inv; g.base = U.r2(g.base + e.base); g.rates.add(e.rate);
      g.wht = U.r2(g.wht + (e.wht != null ? e.wht : e.base * e.rate / 100));
      m.set(k, g);
    }
    return [...m.values()].map((g) => ({ ...g, rateText: [...g.rates].map((r) => r + '%').join(' / ') })).filter((g) => Math.abs(g.base) > 0.004 || g.invs).sort((a, b) => b.wht - a.wht);
  };
  const draw = () => {
    const { ms, entries, missing } = pick();
    const g = group(entries);
    const tot = (k) => U.r2(g.reduce((a, x) => a + x[k], 0));
    U.fill(body,
      basis === 'eta' && !docs.length ? h('div', { class: 'notice' }, 'لم تُسحب فواتير من المنظومة بعد. اسحبها من شاشة "فواتير المنظومة" ليشمل النموذج كل الموردين.') : null,
      basis === 'eta' ? h('div', { class: 'notice info' }, 'المصدر: كل فواتير المنظومة الصالحة في الربع (حسب تاريخ الإصدار) بنسبة كل مورد. الإشعارات الدائنة تُطرح، والفاتورة الموجودة في ظرف معتمد يُحسب صافيها الفعلي بعد المراجعة.') : null,
      missing ? h('div', { class: 'notice' }, `${missing} ظرف معتمد في هذا الربع بدون "تاريخ السداد" فلم يدخل الحساب. سجّل تاريخ السداد من شاشة الظرف، أو اختر مصدراً آخر.`) : null,
      g.some((x) => !x.id) ? h('div', { class: 'notice bad' }, 'بعض الموردين بدون رقم ضريبي (أظرف مستوردة من Excel) — أكمل الرقم قبل التقديم.') : null,
      h('div', { class: 'grid' },
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'عدد الموردين'), h('div', { class: 'value' }, g.length)),
        Envelopes.stat('إجمالي القيمة الخاضعة', tot('base')),
        Envelopes.stat('الضريبة المخصومة', tot('wht'), 'good')),
      h('div', { class: 'card table-wrap' }, h('table', { class: 't', style: 'min-width:860px' },
        h('thead', null, h('tr', null, ['م', 'اسم المورد', 'الرقم الضريبي', 'طبيعة التعامل', 'عدد الفواتير', 'القيمة الصافية', 'النسبة', 'الضريبة المخصومة'].map((x) => h('th', null, x)))),
        h('tbody', null, g.length ? g.map((x, i) => h('tr', null, h('td', null, i + 1), h('td', { style: 'font-weight:600' }, x.name), h('td', { class: 'num' }, x.id || h('span', { class: 'chip bad' }, 'ناقص')),
          h('td', null, 'توريدات'), h('td', null, x.invs), h('td', null, U.num(x.base)),
          h('td', null, basis === 'eta' && x.id ? EtaDocs.rateInput(s, x.id, x.name, draw) : x.rateText), h('td', null, h('strong', null, U.num(x.wht))))) : h('tr', null, h('td', { colspan: 8, class: 'muted', style: 'text-align:center;padding:20px' }, 'لا توجد بيانات في هذا الربع'))),
        g.length ? h('tfoot', null, h('tr', null, h('td', { colspan: 5 }, `الإجمالي — الربع ${quarter} لسنة ${year} (${ms.map(U.monthName).join('، ')})`), h('td', null, U.num(tot('base'))), h('td', null, ''), h('td', null, U.num(tot('wht'))))) : null)),
      h('div', { class: 'small muted' }, 'هذا جدول عمل جاهز لتعبئة نموذج 41 ومطابقته. راجع الشكل والأعمدة المطلوبة على منظومة الخصم والإضافة وقت التقديم. نسبة كل مورد تتعدل من هنا أو من شاشة "فواتير المنظومة" (فارغة = النسبة العامة).'));
  };
  const exp = () => {
    const { ms, entries } = pick();
    const g = group(entries);
    const src = { eta: 'فواتير المنظومة حسب تاريخ الإصدار', paid: 'الأظرف المعتمدة حسب تاريخ السداد', month: 'الأظرف المعتمدة حسب شهر التسعير' }[basis];
    Reports.xlsx(`نموذج 41 - ${year} الربع ${quarter}.xlsx`, [
      ['ملخص نموذج 41', [['م', 'اسم المورد', 'الرقم الضريبي', 'طبيعة التعامل', 'عدد الفواتير', 'القيمة الصافية', 'نسبة الخصم', 'الضريبة المخصومة']]
        .concat(g.map((x, i) => [i + 1, x.name, x.id, 'توريدات', x.invs, x.base, x.rateText, x.wht]))
        .concat([['', 'الإجمالي', '', '', '', U.r2(g.reduce((a, x) => a + x.base, 0)), '', U.r2(g.reduce((a, x) => a + x.wht, 0))]]), [5, 34, 14, 12, 9, 14, 10, 14]],
      ['التفاصيل', [['المورد', 'الرقم الضريبي', 'المستند', 'النوع', 'التاريخ', 'الأساس', 'النسبة', 'الضريبة', 'مصدر القيمة']].concat(entries.map((e) => e.detail)), [28, 12, 22, 12, 12, 13, 8, 12, 24]],
      ['معلومات', [['الفترة', `الربع ${quarter} سنة ${year}`], ['الشهور', ms.map(U.monthName).join('، ')], ['المصدر', src], ['أُعد بواسطة', DB.user.displayName], ['التاريخ', Reports.today()]], [16, 44]],
    ]);
  };
  draw();
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
    Reports.head('نموذج 41 — ضريبة الخصم والإضافة', 'المبالغ المخصومة من الموردين في ربع السنة، مجمّعة لكل مورد بالرقم الضريبي وبنسبة كل مورد.',
      U.select(years.map((y) => ({ value: y, label: y })), year, (v) => { year = v; draw(); }, { style: 'width:100px', 'aria-label': 'السنة' }),
      U.select([1, 2, 3, 4].map((q) => ({ value: String(q), label: 'الربع ' + q })), quarter, (v) => { quarter = v; draw(); }, { style: 'width:110px', 'aria-label': 'الربع' }),
      U.select([{ value: 'eta', label: 'من فواتير المنظومة (كل الموردين)' }, { value: 'paid', label: 'الأظرف المعتمدة — تاريخ السداد' }, { value: 'month', label: 'الأظرف المعتمدة — شهر التسعير' }], basis, (v) => { basis = v; draw(); }, { style: 'width:250px', 'aria-label': 'المصدر' }),
      h('button', { type: 'button', class: 'btn primary', onClick: exp }, 'تصدير Excel')),
    body);
};

/* تقييم الموردين: انضباط الأسعار والكميات والإشعارات */
Reports.lineFacts = (row) => {
  const { line: l, c } = row;
  if (l.rejected) return { price: 0, qty: 0, priceDiff: 0, qtyDiff: U.r2(l.netTotal) };
  const priceDiff = l.price > c.approvedPrice + 0.005 ? U.r2((l.price - c.approvedPrice) * c.received) : 0;
  const qtyDiff = c.received < l.qty ? U.r2((l.qty - c.received) * l.price) : 0;
  return { price: priceDiff > 0 ? 1 : 0, qty: qtyDiff > 0 ? 1 : 0, priceDiff, qtyDiff };
};
Reports.suppliers = async ({ rows }) => {
  const months = [...new Set(rows.map((r) => r.env.month))].sort();
  let from = months.length ? months[Math.max(0, months.length - 6)] : Reports.thisMonth(), to = months.length ? months[months.length - 1] : Reports.thisMonth();
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
  const compute = () => {
    const sup = new Map(), items = new Map();
    for (const r of rows.filter((x) => x.env.month >= from && x.env.month <= to)) {
      const sp = Reports.supplierOf(r.env);
      const k = sp.id || sp.name;
      const g = sup.get(k) || { ...sp, envs: 0, invs: 0, lines: 0, total: 0, priceLines: 0, qtyLines: 0, priceDiff: 0, qtyDiff: 0, cn: 0, rem: 0 };
      g.envs++; g.invs += r.env.invoices.length; g.total = U.r2(g.total + r.calc.t.invTotal); g.cn = U.r2(g.cn + r.calc.t.cnTotal);
      if (r.env.status === 'approved') g.rem = U.r2(g.rem + Envelopes.cnInfo(r.env, r.calc.t).rem);
      for (const x of r.calc.invs) for (const row of x.rows) {
        const f = Reports.lineFacts(row);
        g.lines++; g.priceLines += f.price; g.qtyLines += f.qty; g.priceDiff = U.r2(g.priceDiff + f.priceDiff); g.qtyDiff = U.r2(g.qtyDiff + f.qtyDiff);
        if (f.priceDiff > 0) {
          const ik = U.norm(row.line.description);
          const it = items.get(ik) || { name: row.line.description, supplier: sp.name, times: 0, diff: 0 };
          it.times++; it.diff = U.r2(it.diff + f.priceDiff);
          items.set(ik, it);
        }
      }
      sup.set(k, g);
    }
    return { sup: [...sup.values()].sort((a, b) => b.cn - a.cn), items: [...items.values()].sort((a, b) => b.diff - a.diff).slice(0, 15) };
  };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const grade = (g) => { const p = pct(g.priceLines + g.qtyLines, g.lines); return p <= 2 ? ['ممتاز', 'ok'] : p <= 8 ? ['جيد', 'ok'] : p <= 15 ? ['يحتاج متابعة', 'warn'] : ['ضعيف', 'bad']; };
  const draw = () => {
    const { sup, items } = compute();
    U.fill(body,
      h('div', { class: 'card table-wrap' }, h('table', { class: 't', style: 'min-width:1100px' },
        h('thead', null, h('tr', null, ['المورد', 'أظرف', 'فواتير', 'إجمالي الفواتير', 'بنود بسعر أعلى من العرض', 'قيمة فرق السعر', 'بنود بنقص كمية', 'قيمة نقص الكمية', 'إشعارات مطلوبة', 'لم يصدر منها', 'التقييم'].map((x) => h('th', null, x)))),
        h('tbody', null, sup.length ? sup.map((g) => { const gr = grade(g); return h('tr', null,
          h('td', null, h('strong', null, g.name), h('div', { class: 'sub num' }, g.id)), h('td', null, g.envs), h('td', null, g.invs), h('td', null, U.num(g.total)),
          h('td', null, `${g.priceLines} (${pct(g.priceLines, g.lines)}%)`), h('td', null, U.num(g.priceDiff)),
          h('td', null, `${g.qtyLines} (${pct(g.qtyLines, g.lines)}%)`), h('td', null, U.num(g.qtyDiff)),
          h('td', null, U.num(g.cn)), h('td', { style: g.rem > 0.01 ? 'color:var(--warn-dark);font-weight:700' : '' }, U.num(g.rem)),
          h('td', null, h('span', { class: 'chip ' + gr[1] }, gr[0]))); }) : h('tr', null, h('td', { colspan: 11, class: 'muted', style: 'text-align:center;padding:20px' }, 'لا توجد بيانات في هذه الفترة'))))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'أكثر الأصناف تكراراً في فروق السعر')),
        h('div', { class: 'table-wrap' }, h('table', { class: 't' },
          h('thead', null, h('tr', null, ['الصنف في الفاتورة', 'المورد', 'عدد المرات', 'إجمالي فرق السعر'].map((x) => h('th', null, x)))),
          h('tbody', null, items.length ? items.map((it) => h('tr', null, h('td', { style: 'font-weight:600' }, it.name), h('td', null, it.supplier), h('td', null, it.times), h('td', null, U.num(it.diff)))) : h('tr', null, h('td', { colspan: 4, class: 'muted' }, 'لا توجد فروق أسعار في الفترة')))))),
      h('div', { class: 'small muted' }, 'التقييم حسب نسبة البنود التي بها فرق سعر أو نقص كمية: حتى 2% ممتاز، حتى 8% جيد، حتى 15% يحتاج متابعة، وأكثر ضعيف.'));
  };
  const exp = () => { const { sup, items } = compute(); Reports.xlsx(`تقييم الموردين ${from} إلى ${to}.xlsx`, [
    ['تقييم الموردين', [['المورد', 'الرقم الضريبي', 'أظرف', 'فواتير', 'إجمالي الفواتير', 'عدد البنود', 'بنود فرق سعر', 'قيمة فرق السعر', 'بنود نقص كمية', 'قيمة نقص الكمية', 'إشعارات مطلوبة', 'لم يصدر', 'التقييم']]
      .concat(sup.map((g) => [g.name, g.id, g.envs, g.invs, g.total, g.lines, g.priceLines, g.priceDiff, g.qtyLines, g.qtyDiff, g.cn, g.rem, grade(g)[0]])), [28, 12, 7, 7, 13, 9, 10, 12, 10, 12, 12, 12, 12]],
    ['أصناف فروق السعر', [['الصنف', 'المورد', 'عدد المرات', 'إجمالي الفرق']].concat(items.map((i) => [i.name, i.supplier, i.times, i.diff])), [40, 28, 10, 14]]]); };
  draw();
  const mOpts = (months.length ? months : [Reports.thisMonth()]).map((m) => ({ value: m, label: U.monthName(m) }));
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
    Reports.head('تقييم الموردين', 'انضباط كل مورد في الأسعار والكميات والإشعارات الدائنة — مفيد للتفاوض أو تغيير المورد.',
      h('label', { class: 'row small' }, 'من', U.select(mOpts, from, (v) => { from = v; draw(); }, { style: 'width:140px' })),
      h('label', { class: 'row small' }, 'إلى', U.select(mOpts, to, (v) => { to = v; draw(); }, { style: 'width:140px' })),
      h('button', { type: 'button', class: 'btn', onClick: exp }, 'تصدير Excel')),
    body);
};

/* اللوحة الشهرية: المشتريات حسب النوع والمورد، ومقارنة بالشهر السابق، وأعلى ارتفاع في أسعار العروض */
Reports.dashboard = async ({ s, rows, quotes }) => {
  const months = [...new Set(rows.map((r) => r.env.month))].sort();
  let month = months.length ? months[months.length - 1] : Reports.thisMonth();
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });
  const totals = (m) => {
    const l = rows.filter((r) => r.env.month === m);
    const sum = (k) => U.r2(l.reduce((a, r) => a + r.calc.t[k], 0));
    const byCat = new Map(), bySup = new Map();
    for (const r of l) {
      byCat.set(r.env.category, U.r2((byCat.get(r.env.category) || 0) + r.calc.t.finalNet));
      const sp = Reports.supplierOf(r.env).name;
      bySup.set(sp, U.r2((bySup.get(sp) || 0) + r.calc.t.finalNet));
    }
    return { n: l.length, drafts: l.filter((r) => r.env.status !== 'approved').length, inv: sum('invTotal'), net: sum('finalNet'), cn: sum('cnTotal'), pay: sum('payable'), byCat, bySup };
  };
  const delta = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  const deltaChip = (a, b) => { const d = delta(a, b); return d == null ? h('span', { class: 'sub' }, '—') : h('span', { class: 'chip ' + (d > 5 ? 'bad' : d < -5 ? 'ok' : 'gray') }, (d > 0 ? '+' : '') + d + '%'); };
  /* ارتفاع أسعار العروض: نفس الصنف بين عرض هذا الشهر والشهر السابق لنفس النوع */
  const priceMoves = (m) => {
    const prev = Reports.addMonths(m, -1);
    const out = [];
    for (const cat of s.categories) {
      const cur = quotes.filter((q) => q.month === m && q.category === cat.id && q.status === 'approved');
      const old = quotes.filter((q) => q.month === prev && q.category === cat.id && q.status === 'approved');
      if (!cur.length || !old.length) continue;
      const oldMap = new Map();
      for (const q of old) for (const it of q.items) if (Number(it.price) > 0) oldMap.set(Engine.itemKey(it), Number(it.price));
      const seen = new Set();
      for (const q of cur) for (const it of q.items) {
        const k = Engine.itemKey(it), p = Number(it.price), o = oldMap.get(k);
        if (!(p > 0) || !o || seen.has(k)) continue;
        seen.add(k);
        if (Math.abs(p - o) > 0.005) out.push({ cat: cat.name, name: Engine.itemLabel(it), unit: it.unit, old: o, now: p, pct: Math.round(((p - o) / o) * 1000) / 10 });
      }
    }
    return out.sort((a, b) => b.pct - a.pct);
  };
  const draw = () => {
    const t = totals(month), p = totals(Reports.addMonths(month, -1));
    const moves = priceMoves(month);
    const sortMap = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);
    U.fill(body,
      t.drafts ? h('div', { class: 'notice' }, `${t.drafts} ظرف في هذا الشهر لم يُعتمد بعد — الأرقام قد تتغير.`) : null,
      h('div', { class: 'grid' },
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'إجمالي فواتير الموردين'), h('div', { class: 'value' }, U.num(t.inv)), h('div', null, deltaChip(t.inv, p.inv), h('span', { class: 'sub' }, ' عن الشهر السابق'))),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'الصافي الفعلي المعتمد'), h('div', { class: 'value' }, U.num(t.net)), h('div', null, deltaChip(t.net, p.net))),
        h('div', { class: 'stat warn' }, h('div', { class: 'label' }, 'إشعارات دائنة مطلوبة'), h('div', { class: 'value' }, U.num(t.cn)), h('div', { class: 'sub' }, t.inv ? `${Math.round((t.cn / t.inv) * 1000) / 10}% من الفواتير` : '')),
        h('div', { class: 'stat good' }, h('div', { class: 'label' }, 'المستحق للموردين'), h('div', { class: 'value' }, U.num(t.pay)))),
      h('div', { class: 'grid', style: 'align-items:start' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'حسب نوع التوريد')),
          h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['النوع', 'الصافي', 'الشهر السابق', 'التغير'].map((x) => h('th', null, x)))),
            h('tbody', null, sortMap(t.byCat).map(([c, v]) => h('tr', null, h('td', null, Settings.catName(c, s)), h('td', null, U.num(v)), h('td', null, U.num(p.byCat.get(c) || 0)), h('td', null, deltaChip(v, p.byCat.get(c) || 0)))))))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'حسب المورد')),
          h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['المورد', 'الصافي', 'النسبة'].map((x) => h('th', null, x)))),
            h('tbody', null, sortMap(t.bySup).map(([n, v]) => h('tr', null, h('td', null, n), h('td', null, U.num(v)), h('td', null, t.net ? Math.round((v / t.net) * 100) + '%' : '—')))))))),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'تغيّر أسعار عروض الأسعار عن الشهر السابق'), h('div', { class: 'small muted' }, 'نفس الصنف في عرض هذا الشهر مقارنة بعرض الشهر السابق لنفس النوع'))),
        h('div', { class: 'table-wrap' }, h('table', { class: 't' },
          h('thead', null, h('tr', null, ['النوع', 'الصنف', 'الوحدة', 'السعر السابق', 'السعر الحالي', 'التغير'].map((x) => h('th', null, x)))),
          h('tbody', null, moves.length ? moves.slice(0, 25).map((x) => h('tr', null, h('td', null, x.cat), h('td', { style: 'font-weight:600' }, x.name), h('td', null, x.unit || ''), h('td', null, U.num(x.old)), h('td', null, U.num(x.now)),
            h('td', null, h('span', { class: 'chip ' + (x.pct > 0 ? 'bad' : 'ok') }, (x.pct > 0 ? '+' : '') + x.pct + '%')))) : h('tr', null, h('td', { colspan: 6, class: 'muted' }, 'لا توجد عروض معتمدة للشهرين لنفس النوع للمقارنة')))))));
  };
  draw();
  const mOpts = (months.length ? months : [month]).slice().reverse().map((m) => ({ value: m, label: U.monthName(m) }));
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
    Reports.head('اللوحة الشهرية', 'المشتريات حسب شهر التسعير، مقارنة بالشهر السابق.', U.select(mOpts, month, (v) => { month = v; draw(); }, { style: 'width:160px', 'aria-label': 'الشهر' })),
    body);
};

/* ===== استهلاك المطاعم: لوحة تفاعلية بقيمة التوريد ===== */
/* ألوان الفئات بترتيب ثابت (مُتحقق منها لعمى الألوان)؛ اللون يتبع المطعم حسب ترتيبه في الإعدادات وليس حسب ترتيبه في القيمة */
Reports.SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
Reports.OTHER = '#8c96a0';
Reports.svg = (tag, attrs, ...kids) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};
Reports.short = (n) => (Math.abs(n) >= 1e6 ? U.r2(n / 1e6) + 'م' : Math.abs(n) >= 1e3 ? Math.round(n / 1e3) + 'ألف' : String(Math.round(n)));

Reports.restaurants = async ({ s, rows }) => {
  const rests = s.restaurants || [];
  if (!rests.length) {
    return h('div', { class: 'card card-body', style: 'display:flex;flex-direction:column;gap:12px' },
      h('h2', null, 'استهلاك المطاعم'),
      h('div', { class: 'notice' }, 'لم تُسجل أسماء المطاعم بعد. أضفها من الإعدادات ← المطاعم، ثم اختر مطعم كل فاتورة من القائمة المنسدلة داخل الظرف.'),
      DB.can('settingsGeneral') ? h('div', null, h('a', { class: 'btn primary', href: '#/settings/restaurants' }, 'إضافة المطاعم')) : null);
  }
  const colorOf = new Map(rests.map((r, i) => [r.id, i < Reports.SERIES.length ? Reports.SERIES[i] : Reports.OTHER]));
  const months = [...new Set(rows.map((r) => r.env.month))].sort();
  const suppliers = [...new Set(rows.map((r) => Reports.supplierOf(r.env).name))].sort();
  const f = { from: months[Math.max(0, months.length - 6)] || Reports.thisMonth(), to: months[months.length - 1] || Reports.thisMonth(), cat: '', sup: '', basis: 'net', approved: true, sel: '' };

  /* كل فاتورة = سجل واحد بقيمته ومطعمه */
  const facts = () => {
    const out = [];
    for (const r of rows) {
      if (r.env.month < f.from || r.env.month > f.to) continue;
      if (f.approved && r.env.status !== 'approved') continue;
      if (f.cat && r.env.category !== f.cat) continue;
      const sup = Reports.supplierOf(r.env).name;
      if (f.sup && sup !== f.sup) continue;
      for (const x of r.calc.invs) {
        const rid = x.inv.restaurantId && colorOf.has(x.inv.restaurantId) ? x.inv.restaurantId : '';
        const val = U.r2(f.basis === 'gross' ? x.t.finalNet + x.t.finalVat : x.t.finalNet);
        out.push({ rid, month: r.env.month, cat: r.env.category, sup, val, x });
      }
    }
    return out;
  };
  const sum = (l) => U.r2(l.reduce((a, q) => a + q.val, 0));
  const nameOf = (rid) => (rid ? Envelopes.restName(rid, s) : 'بدون مطعم');

  const tip = h('div', { class: 'viz-tip', role: 'status', 'aria-live': 'polite' });
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:14px' });

  /* أعمدة أفقية لكل مطعم (قيمة واحدة → لون واحد) — الضغط على مطعم يعرض تفاصيله */
  const barList = (byR, total) => {
    const max = Math.max(...byR.map((g) => g.val), 1);
    return h('div', { class: 'viz-bars', role: 'list' }, byR.map((g) => h('button', {
      type: 'button', role: 'listitem', class: 'viz-bar' + (f.sel === g.rid ? ' on' : '') + (f.sel && f.sel !== g.rid ? ' dim' : ''),
      'aria-pressed': f.sel === g.rid ? 'true' : 'false', 'aria-label': `${g.name}: ${U.fmt(g.val)}`,
      title: `${g.name}\n${U.fmt(g.val)} · ${total ? Math.round((g.val / total) * 100) : 0}% · ${g.n} فاتورة`,
      onClick: () => { f.sel = f.sel === g.rid ? '' : g.rid; draw(); },
    },
      h('span', { class: 'viz-bar-label' }, h('span', { class: 'viz-key', style: `background:${g.rid ? colorOf.get(g.rid) : Reports.OTHER}` }), g.name),
      h('span', { class: 'viz-bar-track' }, h('span', { class: 'viz-bar-fill', style: `width:${Math.max(0.6, (g.val / max) * 100)}%` })),
      h('span', { class: 'viz-bar-value num' }, U.fmt(g.val)),
      h('span', { class: 'viz-bar-pct' }, total ? Math.round((g.val / total) * 100) + '%' : ''))));
  };

  /* اتجاه شهري: خط لكل مطعم (حتى 8، والباقي في "أخرى")، الزمن من اليمين لليسار مع اتجاه القراءة */
  const trend = (l, ms) => {
    const W = 760, H = 260, padL = 64, padR = 16, padT = 14, padB = 34;
    const series = new Map();
    for (const q of l) {
      const k = q.rid || '__none';
      const m = series.get(k) || new Map();
      m.set(q.month, U.r2((m.get(q.month) || 0) + q.val));
      series.set(k, m);
    }
    const keys = [...series.keys()].filter((k) => k !== '__none').sort((a, b) => rests.findIndex((r) => r.id === a) - rests.findIndex((r) => r.id === b));
    if (series.has('__none')) keys.push('__none');
    const maxV = Math.max(1, ...[...series.values()].flatMap((m) => [...m.values()]));
    const nice = (() => { const p = Math.pow(10, Math.floor(Math.log10(maxV))); return Math.ceil(maxV / p) * p; })();
    const xs = (i) => (ms.length === 1 ? (W - padR + padL) / 2 : W - padR - (i * (W - padL - padR)) / (ms.length - 1));
    const ys = (v) => padT + (1 - v / nice) * (H - padT - padB);
    const svg = Reports.svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz-svg', role: 'img', 'aria-label': 'اتجاه قيمة التوريد الشهرية لكل مطعم' });
    for (let i = 0; i <= 4; i++) {
      const v = (nice * i) / 4, y = ys(v);
      svg.append(Reports.svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, class: 'viz-grid' }), Reports.svg('text', { x: padL - 8, y: y + 4, 'text-anchor': 'end', class: 'viz-axis' }, Reports.short(v)));
    }
    ms.forEach((m, i) => svg.append(Reports.svg('text', { x: xs(i), y: H - 10, 'text-anchor': 'middle', class: 'viz-axis' }, U.monthName(m).replace(/ \d{4}$/, '') + ' ' + m.slice(2, 4))));
    for (const k of keys) {
      const m = series.get(k), col = k === '__none' ? Reports.OTHER : colorOf.get(k);
      const dim = f.sel && f.sel !== (k === '__none' ? '' : k);
      const pts = ms.map((mm, i) => [xs(i), ys(m.get(mm) || 0)]);
      svg.append(Reports.svg('polyline', { points: pts.map((p) => p.join(',')).join(' '), fill: 'none', stroke: col, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-dasharray': k === '__none' ? '5 4' : null, opacity: dim ? 0.18 : 1 }));
      for (const [x, y] of pts) svg.append(Reports.svg('circle', { cx: x, cy: y, r: 4, fill: col, stroke: '#fff', 'stroke-width': 2, opacity: dim ? 0.18 : 1 }));
    }
    const cross = Reports.svg('line', { y1: padT, y2: H - padB, class: 'viz-cross', visibility: 'hidden' });
    svg.append(cross);
    const hit = Reports.svg('rect', { x: padL, y: padT, width: W - padL - padR, height: H - padT - padB, fill: 'transparent' });
    svg.append(hit);
    const wrap = h('div', { class: 'viz-chart' }, svg, tip);
    const show = (evt) => {
      const r = svg.getBoundingClientRect();
      const px = ((evt.clientX - r.left) / r.width) * W;
      let best = 0, bd = Infinity;
      ms.forEach((_, i) => { const d = Math.abs(xs(i) - px); if (d < bd) { bd = d; best = i; } });
      const mm = ms[best];
      cross.setAttribute('x1', xs(best)); cross.setAttribute('x2', xs(best)); cross.setAttribute('visibility', 'visible');
      const items = keys.map((k) => ({ k, v: series.get(k).get(mm) || 0 })).sort((a, b) => b.v - a.v);
      U.fill(tip, h('div', { style: 'font-weight:700;margin-bottom:4px' }, U.monthName(mm)),
        items.map((it) => h('div', { class: 'viz-tip-row' }, h('span', { class: 'viz-key', style: `background:${it.k === '__none' ? Reports.OTHER : colorOf.get(it.k)}` }), h('span', null, nameOf(it.k === '__none' ? '' : it.k)), h('span', { class: 'num', style: 'margin-inline-start:auto;font-weight:600' }, U.fmt(it.v)))),
        h('div', { class: 'viz-tip-row', style: 'border-top:1px solid var(--line);margin-top:4px;padding-top:4px' }, h('span', null, 'الإجمالي'), h('span', { class: 'num', style: 'margin-inline-start:auto;font-weight:700' }, U.fmt(items.reduce((a, it) => a + it.v, 0)))));
      tip.style.display = 'block';
      const cx = ((xs(best)) / W) * r.width;
      tip.style.left = Math.min(Math.max(8, cx - tip.offsetWidth / 2), r.width - tip.offsetWidth - 8) + 'px';
    };
    hit.addEventListener('mousemove', show);
    hit.addEventListener('mouseleave', () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); });
    const legend = h('div', { class: 'viz-legend' }, keys.map((k) => h('button', { type: 'button', class: 'viz-legend-item' + (f.sel && f.sel !== (k === '__none' ? '' : k) ? ' dim' : ''), onClick: () => { const id = k === '__none' ? '' : k; f.sel = f.sel === id ? '' : id; draw(); } },
      h('span', { class: 'viz-key', style: `background:${k === '__none' ? Reports.OTHER : colorOf.get(k)}` }), nameOf(k === '__none' ? '' : k))));
    return h('div', null, legend, wrap);
  };

  const draw = () => {
    const l = facts();
    const total = sum(l);
    const ms = [...new Set(l.map((q) => q.month))].sort();
    const byR = [];
    for (const rid of [...rests.map((r) => r.id), '']) {
      const g = l.filter((q) => q.rid === rid);
      if (g.length) byR.push({ rid, name: nameOf(rid), val: sum(g), n: g.length });
    }
    byR.sort((a, b) => b.val - a.val);
    const top = byR.find((g) => g.rid);
    const none = byR.find((g) => !g.rid);
    const sel = f.sel !== '' ? l.filter((q) => q.rid === f.sel) : null;
    // تفاصيل المطعم المحدد: أعلى الأصناف والموردين
    const detail = () => {
      if (!sel) return null;
      const items = new Map(), sups = new Map();
      for (const q of sel) {
        sups.set(q.sup, U.r2((sups.get(q.sup) || 0) + q.val));
        for (const row of q.x.rows) {
          if (row.line.rejected) continue;
          const v = U.r2(f.basis === 'gross' ? row.c.finalNet + row.c.finalVat : row.c.finalNet);
          const k = row.c.item ? Engine.itemLabel(row.c.item) : row.line.description;
          const it = items.get(k) || { name: k, unit: row.c.item ? row.c.item.unit : row.line.unitType, qty: 0, val: 0 };
          it.qty = U.r2(it.qty + (row.c.received || 0) * (row.c.factor || 1)); it.val = U.r2(it.val + v);
          items.set(k, it);
        }
      }
      const topItems = [...items.values()].sort((a, b) => b.val - a.val).slice(0, 15);
      return h('div', { class: 'grid', style: 'align-items:start' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, `أعلى الأصناف — ${nameOf(f.sel)}`)),
          h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['الصنف', 'الكمية المستلمة', 'القيمة', 'النسبة'].map((x) => h('th', null, x)))),
            h('tbody', null, topItems.map((it) => h('tr', null, h('td', { style: 'font-weight:600' }, it.name), h('td', null, U.fmtQ(it.qty), ' ', h('span', { class: 'sub' }, it.unit || '')), h('td', null, U.num(it.val)), h('td', null, sum(sel) ? Math.round((it.val / sum(sel)) * 100) + '%' : '—'))))))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, `الموردون — ${nameOf(f.sel)}`)),
          h('div', { class: 'table-wrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['المورد', 'القيمة'].map((x) => h('th', null, x)))),
            h('tbody', null, [...sups.entries()].sort((a, b) => b[1] - a[1]).map(([n, v]) => h('tr', null, h('td', null, n), h('td', null, U.num(v)))))))));
    };
    // مصفوفة المطعم × نوع التوريد (بديل الجدول للمخطط)
    const cats = s.categories.filter((c) => l.some((q) => q.cat === c.id));
    U.fill(body,
      none && none.val > 0 ? h('div', { class: 'notice' }, `${none.n} فاتورة بقيمة ${U.fmt(none.val)} لم يُحدد مطعمها — اختر المطعم من القائمة المنسدلة داخل الفاتورة في الظرف.`) : null,
      h('div', { class: 'grid' },
        h('div', { class: 'stat good' }, h('div', { class: 'label' }, 'إجمالي قيمة التوريد'), h('div', { class: 'value' }, U.num(total)), h('div', { class: 'label' }, f.basis === 'gross' ? 'شامل ق.م' : 'الصافي الفعلي بدون ق.م')),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'أعلى مطعم'), h('div', { class: 'value', style: 'font-size:18px' }, top ? top.name : '—'), h('div', { class: 'sub' }, top ? `${U.fmt(top.val)} · ${total ? Math.round((top.val / total) * 100) : 0}%` : '')),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'متوسط شهري لكل مطعم'), h('div', { class: 'value' }, U.num(ms.length && byR.filter((g) => g.rid).length ? total / ms.length / byR.filter((g) => g.rid).length : 0))),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'فواتير'), h('div', { class: 'value' }, l.length))),
      l.length ? h('div', { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));align-items:start' },
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'قيمة التوريد لكل مطعم'), h('div', { class: 'small muted' }, 'اضغط على مطعم لعرض تفاصيله وتمييزه في الرسم'))), h('div', { class: 'card-body' }, barList(byR, total))),
        h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('div', null, h('h2', null, 'الاتجاه الشهري'), h('div', { class: 'small muted' }, 'مرّر الماوس على الرسم لقراءة قيم كل شهر'))), h('div', { class: 'card-body' }, trend(l, ms))))
        : h('div', { class: 'card card-body muted' }, 'لا توجد فواتير في هذا الاختيار.'),
      detail(),
      l.length ? h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, 'المطعم × نوع التوريد')),
        h('div', { class: 'table-wrap' }, h('table', { class: 't' },
          h('thead', null, h('tr', null, ['المطعم'].concat(cats.map((c) => c.name), ['الإجمالي', 'النسبة']).map((x) => h('th', null, x)))),
          h('tbody', null, byR.map((g) => h('tr', { class: (f.sel === g.rid ? 'short ' : '') + 'clickable', onClick: () => { f.sel = f.sel === g.rid ? '' : g.rid; draw(); } },
            h('td', { style: 'font-weight:600' }, h('span', { class: 'viz-key', style: `background:${g.rid ? colorOf.get(g.rid) : Reports.OTHER};margin-inline-end:6px` }), g.name),
            cats.map((c) => h('td', null, U.num(sum(l.filter((q) => q.rid === g.rid && q.cat === c.id))))),
            h('td', null, h('strong', null, U.num(g.val))), h('td', null, total ? Math.round((g.val / total) * 100) + '%' : '—')))),
          h('tfoot', null, h('tr', null, h('td', null, 'الإجمالي'), cats.map((c) => h('td', null, U.num(sum(l.filter((q) => q.cat === c.id))))), h('td', null, U.num(total)), h('td', null, '100%')))))) : null);
  };
  const exp = () => {
    const l = facts();
    const ms = [...new Set(l.map((q) => q.month))].sort();
    const ids = [...rests.map((r) => r.id), ''].filter((rid) => l.some((q) => q.rid === rid));
    Reports.xlsx(`استهلاك المطاعم ${f.from} إلى ${f.to}.xlsx`, [
      ['حسب الشهر', [['المطعم'].concat(ms.map(U.monthName), ['الإجمالي'])].concat(ids.map((rid) => [nameOf(rid)].concat(ms.map((m) => sum(l.filter((q) => q.rid === rid && q.month === m))), [sum(l.filter((q) => q.rid === rid))]))), [24].concat(ms.map(() => 13), [14])],
      ['حسب النوع', [['المطعم'].concat(s.categories.map((c) => c.name), ['الإجمالي'])].concat(ids.map((rid) => [nameOf(rid)].concat(s.categories.map((c) => sum(l.filter((q) => q.rid === rid && q.cat === c.id))), [sum(l.filter((q) => q.rid === rid))]))), [24].concat(s.categories.map(() => 13), [14])],
      ['الفواتير', [['المطعم', 'المورد', 'شهر التسعير', 'النوع', 'رقم الفاتورة', 'القيمة']].concat(l.map((q) => [nameOf(q.rid), q.sup, U.monthName(q.month), Settings.catName(q.cat, s), q.x.inv.internalID, q.val])), [22, 26, 14, 12, 14, 13]],
      ['معلومات', [['الفترة', `${U.monthName(f.from)} إلى ${U.monthName(f.to)}`], ['القيمة', f.basis === 'gross' ? 'شامل ق.م' : 'الصافي الفعلي بدون ق.م'], ['الأظرف', f.approved ? 'المعتمدة فقط' : 'كل الأظرف'], ['نوع التوريد', f.cat ? Settings.catName(f.cat, s) : 'الكل'], ['المورد', f.sup || 'الكل']], [14, 40]],
    ]);
  };
  draw();
  const mOpts = (months.length ? months : [Reports.thisMonth()]).map((m) => ({ value: m, label: U.monthName(m) }));
  const sel = (opts, val, key, attrs) => U.select(opts, val, (v) => { f[key] = key === 'approved' ? v === '1' : v; draw(); }, attrs);
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
    Reports.head('استهلاك المطاعم', 'قيمة التوريد لكل مطعم حسب الفواتير الموزعة عليه داخل الأظرف (بعد خصم الإشعارات الدائنة).',
      h('button', { type: 'button', class: 'btn', onClick: exp }, 'تصدير Excel')),
    h('div', { class: 'row no-print', role: 'group', 'aria-label': 'فلاتر' },
      h('label', { class: 'row small' }, 'من', sel(mOpts, f.from, 'from', { style: 'width:140px' })),
      h('label', { class: 'row small' }, 'إلى', sel(mOpts, f.to, 'to', { style: 'width:140px' })),
      sel([{ value: '', label: 'كل الأنواع' }].concat(s.categories.map((c) => ({ value: c.id, label: c.name }))), '', 'cat', { style: 'width:150px', 'aria-label': 'نوع التوريد' }),
      sel([{ value: '', label: 'كل الموردين' }].concat(suppliers.map((n) => ({ value: n, label: n }))), '', 'sup', { style: 'width:190px', 'aria-label': 'المورد' }),
      sel([{ value: 'net', label: 'الصافي بدون ق.م' }, { value: 'gross', label: 'شامل ق.م' }], 'net', 'basis', { style: 'width:150px', 'aria-label': 'القيمة' }),
      sel([{ value: '1', label: 'الأظرف المعتمدة فقط' }, { value: '0', label: 'كل الأظرف' }], '1', 'approved', { style: 'width:170px', 'aria-label': 'الأظرف' })),
    body);
};

/* ===== التنبيهات (أعلى قائمة الأظرف) ===== */
Reports.alerts = async () => {
  const out = [];
  const { s, quotes, envs, rows } = await Reports.load();
  const now = Date.now(), today = Reports.today(), cur = Reports.thisMonth();
  const days = (iso) => Math.floor((now - Date.parse(iso)) / 86400000);
  const stale = envs.filter((e) => e.status !== 'approved' && days(e.updatedAt || e.createdAt) > 14);
  if (stale.length) out.push(['warn', `${stale.length} ظرف مفتوح بدون تعديل منذ أكثر من 14 يوماً: ${stale.slice(0, 3).map((e) => e.supplier || 'بدون اسم').join('، ')}${stale.length > 3 ? '…' : ''}`, '#/envelopes']);
  const lateCn = rows.filter((r) => r.env.status === 'approved').map((r) => Envelopes.cnInfo(r.env, r.calc.t)).filter((i) => i.rem > 0.01 && i.since > 30);
  if (lateCn.length) out.push(['bad', `${lateCn.length} إشعار دائن لم يصدر بعد أكثر من 30 يوماً من الاعتماد — إجمالي ${U.fmt(lateCn.reduce((a, i) => a + i.rem, 0))}`, '#/credit-notes']);
  // عروض الأسعار: أنواع يُتعامل معها بانتظام بدون عرض معتمد للشهر الحالي، أو عرض ينتهي قريباً
  const recent = [1, 2, 3].map((n) => Reports.addMonths(cur, -n));
  for (const c of s.categories) {
    const used = quotes.some((q) => q.category === c.id && recent.includes(q.month));
    const curQ = quotes.filter((q) => q.category === c.id && q.month === cur && q.status === 'approved');
    if (used && !curQ.length) out.push(['warn', `لا يوجد عرض سعر معتمد "${c.name}" لشهر ${U.monthName(cur)}`, '#/quotes']);
    if (curQ.length) {
      const lastTo = curQ.map((q) => q.to).sort().pop();
      const left = Math.floor((Date.parse(lastTo) - Date.parse(today)) / 86400000);
      if (lastTo < U.monthLast(cur) && left >= 0 && left <= 5) out.push(['warn', `عرض سعر "${c.name}" ينتهي يوم ${U.fmtDay(lastTo)} ولا يوجد عرض للفترة التالية`, '#/quotes']);
    }
  }
  if (DB.can('settingsEta') && !s.companyTaxId) out.push(['warn', 'سجّل الرقم الضريبي لشركتك (الإعدادات ← ربط الضرائب) ليتأكد البرنامج أن الفواتير صادرة لشركتك قبل الاعتماد', '#/settings/eta']);
  if (DB.user.role === 'admin') {
    const closed = new Set(s.closedMonths || []);
    const ready = [...new Set(envs.map((e) => e.month))].filter((m) => m < cur && !closed.has(m) && envs.filter((e) => e.month === m).every((e) => e.status === 'approved'));
    if (ready.length) out.push(['info', `شهور جاهزة للإقفال (كل أظرفها معتمدة): ${ready.sort().map(U.monthName).join('، ')}`, '#/settings/periods']);
    try {
      const mr = await DB.call('GET', '/api/v2/mirror');
      if (!mr.dir) out.push(['warn', 'النسخ الاحتياطية على نفس الهارد فقط — فعّل "نسخة تلقائية في مكان ثانٍ" (فلاشة أو OneDrive)', '#/settings/backup']);
      else if (mr.error) out.push(['bad', 'تعذر النسخ للمكان الثاني: ' + mr.error, '#/settings/backup']);
    } catch (e) { /* */ }
  }
  return out;
};
Reports.alertsCard = async () => {
  let list = [];
  try { list = await Reports.alerts(); } catch (e) { console.error('alerts', e); }
  if (!list.length) return null;
  return h('section', { class: 'card', 'aria-label': 'تنبيهات' },
    h('div', { class: 'card-head' }, h('h2', null, `تنبيهات (${list.length})`)),
    h('div', { class: 'card-body', style: 'display:flex;flex-direction:column;gap:8px' },
      list.map(([lvl, text, href]) => h('a', { href, class: 'notice ' + (lvl === 'bad' ? 'bad' : lvl === 'info' ? 'info' : ''), style: 'text-decoration:none;display:block' }, text))));
};
