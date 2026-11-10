/* حسابات الظرف (ملف مشترك): نفس الكود تحسب به الواجهة ما تعرضه، ويحسب به الخادم عند الاعتماد.
 * - الظرف المعتمد "مجمَّد": كل بند يحمل نسخة صنف عرض السعر وقت الاعتماد (line.fz يختمها الخادم فقط)،
 *   فلا تتغير أرقامه لو عُدّل عرض السعر أو حُذف بعد الاعتماد.
 * - التقريب: الأظرف المعتمدة قبل الإصدار 2.6 تبقى بطريقة التقريب القديمة (calcV غير موجود) حتى لا يتغير فيها قرش. */
'use strict';

const Calc = { VERSION: 2 };

/* تقريب لقرشين بنصف القرش لأعلى. يعالج تمثيل الكسور العشرية (576.335 ← 576.34 وليس 576.33) */
Calc.r2 = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return x;
  const a = Math.abs(x);
  if (a >= 1e12) return Math.round(x * 100) / 100;
  return Math.sign(x) * Number(Math.round(Number(a.toFixed(8) + 'e2')) + 'e-2') || 0;
};
/* الطريقة القديمة (قبل 2.6): تُستخدم فقط للأظرف التي اعتُمدت بها */
Calc.r2v1 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
Calc.fmt = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
Calc.fmtQ = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });

/* صنف عرض السعر المربوط بالبند: من النسخة المجمدة لو الظرف مجمد، وإلا من عرض السعر الحالي */
Calc.itemOf = (line, quote, frozen) => {
  if (!line.m || !line.m.itemId) return null;
  if (frozen) return line.fz && typeof line.fz === 'object' ? line.fz : null;
  return quote && Array.isArray(quote.items) ? quote.items.find((i) => i && i.id === line.m.itemId) || null : null;
};

/* ===== حساب بند واحد ===== opts: {frozen, r2} */
Calc.calcLine = (line, quote, settings, opts) => {
  const r2 = (opts && opts.r2) || Calc.r2;
  const item = Calc.itemOf(line, quote, !!(opts && opts.frozen));
  const factor = item ? (Number(line.m.factor) || 1) : 1;
  const quotePrice = item && item.price != null && item.price !== '' ? Number(item.price) : null;
  const expected = quotePrice != null && quotePrice > 0 ? quotePrice * factor : null;
  const P = line.price;
  // اعتماد يدوي من إدارة المشتريات لصنف غير موجود بعرض السعر
  const manual = !item && line.manualApproval ? line.manualApproval : null;
  const manualPrice = manual && Number(manual.price) > 0 ? Number(manual.price) : null;
  let approvedPrice;
  if (line.rejected) approvedPrice = 0;
  else if (expected != null) approvedPrice = Math.min(P, expected); // السعر الأقل من العرض لا يُحاسب عليه
  else if (manualPrice != null) approvedPrice = Math.min(P, manualPrice);
  else approvedPrice = P;
  const received = line.received == null ? line.qty : Math.min(line.qty, Math.max(0, Number(line.received) || 0));
  const quoteVat = item && item.vat != null ? Number(item.vat) : null;
  const vatRate = line.vatOverride != null ? Number(line.vatOverride) : (quoteVat != null ? quoteVat : line.vatRate);
  const actualNet = line.rejected ? 0 : r2(received * approvedPrice);
  const actualVatCalc = r2(actualNet * vatRate / 100);
  const cnNet = Math.max(0, r2(line.netTotal - actualNet));
  const cnVat = Math.max(0, r2(line.vatAmount - actualVatCalc));
  const finalNet = r2(line.netTotal - cnNet);
  const finalVat = r2(line.vatAmount - cnVat);

  const reasons = [];
  if (line.rejected) reasons.push(item ? 'صنف مرفوض بالكامل' : 'صنف غير موجود بعرض السعر — مرفوض');
  else {
    if (received < line.qty) reasons.push(`فرق كمية: الفاتورة ${Calc.fmtQ(line.qty)} والمستلم ${Calc.fmtQ(received)}`);
    if (expected != null && P > expected + 0.005) reasons.push(`فرق سعر: سعر الفاتورة ${Calc.fmt(P)} وسعر العرض ${Calc.fmt(expected)} — الفرق ${Calc.fmt(P - expected)} × ${Calc.fmtQ(received)} = ${Calc.fmt((P - expected) * received)}`);
    if (manualPrice != null && P > manualPrice + 0.005) reasons.push(`فرق سعر: سعر الفاتورة ${Calc.fmt(P)} والسعر المعتمد يدوياً من المشتريات ${Calc.fmt(manualPrice)} — الفرق ${Calc.fmt(P - manualPrice)} × ${Calc.fmtQ(received)} = ${Calc.fmt((P - manualPrice) * received)}`);
  }
  const vatExpectedOnCn = r2(cnNet * line.vatRate / 100);
  if (cnVat > vatExpectedOnCn + 0.01) reasons.push(`ضريبة قيمة مضافة غير مستحقة (${line.vatRate}% بدلاً من ${vatRate}%)`);

  const notes = [];
  let status = 'ok';
  if (!item && !line.rejected && !line.noQuoteAccepted && !manual) { status = 'nomatch'; notes.push('لا يوجد صنف مقابل في عرض السعر'); }
  else if (item && !line.rejected) {
    if (quotePrice == null || quotePrice <= 0) notes.push('سعر العرض صفر أو فارغ');
    if (line.m.note) notes.push(line.m.note);
    if (!line.confirmed) status = 'review';
  }
  if (item && quoteVat == null && line.vatOverride == null) notes.push(`ق.م غير محددة بالعرض: أُخذت ${line.vatRate}% من الفاتورة`);

  return {
    item, factor, quotePrice, expected, approvedPrice, received, vatRate, manual, manualPrice,
    actualNet, cnNet, cnVat, cnTotal: r2(cnNet + cnVat), finalNet, finalVat,
    reasons, notes, status,
  };
};

Calc.calcInvoice = (inv, quote, settings, opts) => {
  const r2 = (opts && opts.r2) || Calc.r2;
  const rows = inv.lines.map((l) => ({ line: l, c: Calc.calcLine(l, quote, settings, opts) }));
  const s = (f) => r2(rows.reduce((a, r) => a + f(r), 0));
  const t = {
    invNet: s((r) => r.line.netTotal),
    invVat: s((r) => r.line.vatAmount),
    other: s((r) => r.line.otherTaxes),
    cnNet: s((r) => r.c.cnNet),
    cnVat: s((r) => r.c.cnVat),
    finalNet: s((r) => r.c.finalNet),
    finalVat: s((r) => r.c.finalVat),
    pending: rows.filter((r) => r.c.status !== 'ok').length,
  };
  t.invTotal = r2(t.invNet + t.invVat + t.other);
  t.cnTotal = r2(t.cnNet + t.cnVat);
  // ضريبة الخصم والإضافة على القيمة الفعلية المعتمدة بعد التعديلات
  t.wht = r2(t.finalNet * (Number(settings.whtRate) || 0) / 100);
  t.payable = r2(t.finalNet + t.finalVat + t.other - t.wht);
  return { rows, t };
};

/* نسبة الخصم والإضافة للمورد: من سجل الموردين (الإعدادات) وإلا النسبة العامة.
 * الظرف المعتمد يحتفظ بالنسبة التي اعتُمد بها حتى لا تتغير أرقامه لو تغيّرت النسبة لاحقاً */
Calc.supplierId = (env) => env.supplierTaxId || ((env.invoices || []).find((i) => i && i.issuerId) || {}).issuerId || '';
Calc.rateForSupplier = (id, settings) => {
  const sp = (settings.suppliers || []).find((x) => x.id === id);
  return sp && sp.whtRate != null ? Number(sp.whtRate) : (Number(settings.whtRate) || 0);
};
Calc.whtRateOf = (env, settings) => (env.status === 'approved' && env.whtRate != null ? Number(env.whtRate) : Calc.rateForSupplier(Calc.supplierId(env), settings));

Calc.TOTAL_KEYS = ['invNet', 'invVat', 'other', 'invTotal', 'cnNet', 'cnVat', 'cnTotal', 'finalNet', 'finalVat', 'wht', 'payable', 'pending'];

Calc.calcEnvelope = (env, quotesById, settings) => {
  const approved = env.status === 'approved';
  const opts = {
    frozen: approved && !!env.frozenAt,
    r2: approved && !(Number(env.calcV) >= 2) ? Calc.r2v1 : Calc.r2,
  };
  const whtRate = Calc.whtRateOf(env, settings);
  const st = whtRate === Number(settings.whtRate) ? settings : Object.assign({}, settings, { whtRate });
  const invs = env.invoices.map((inv) => ({ inv, quote: quotesById[inv.quoteId], whtRate, ...Calc.calcInvoice(inv, quotesById[inv.quoteId], st, opts) }))
    .sort((a, b) => String(a.inv.internalID || '').localeCompare(String(b.inv.internalID || ''), 'en', { numeric: true }));
  const t = {};
  for (const k of Calc.TOTAL_KEYS) t[k] = opts.r2(invs.reduce((a, x) => a + x.t[k], 0));
  return { invs, t, whtRate };
};

if (typeof module !== 'undefined' && module.exports) module.exports = Calc;
