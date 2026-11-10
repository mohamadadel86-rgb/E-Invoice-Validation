/* قارئ الفاتورة الإلكترونية المصرية (ETA)
 * يقبل: ملف JSON من البوابة، أو نص منسوخ من F12 (Response)
 * يدعم: JSON مباشر فيه invoiceLines، أو حقل "document" نصي متسلسل، أو قوائم/أغلفة تحتوي فواتير.
 */
'use strict';

const Invoice = {};

Invoice._tryParse = (text) => {
  let t = String(text || '').trim().replace(/^﻿/, '');
  if (!t) throw new Error('النص فارغ');
  try { return JSON.parse(t); } catch (e) { /* نكمل */ }
  // أحياناً يُنسخ النص ومعه أجزاء زائدة: نأخذ من أول { إلى آخر }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* نكمل */ }
  }
  throw new Error('النص ليس JSON صالحاً — تأكد من نسخ الـ Response كاملاً');
};

/* البحث عن كل كائنات الفواتير داخل أي غلاف */
Invoice._collect = (node, outer, out, depth) => {
  if (!node || depth > 8) return;
  if (Array.isArray(node)) { for (const x of node) Invoice._collect(x, outer, out, depth + 1); return; }
  if (typeof node !== 'object') return;
  if (typeof node.document === 'string') {
    try {
      const inner = JSON.parse(node.document);
      Invoice._collect(inner, node, out, depth + 1);
      return;
    } catch (e) { /* ليس JSON */ }
  }
  if (Array.isArray(node.invoiceLines)) { out.push({ doc: node, outer }); return; }
  for (const v of Object.values(node)) if (v && typeof v === 'object') Invoice._collect(v, node.invoiceLines ? null : node, out, depth + 1);
};

Invoice._line = (l, i) => {
  const qty = Number(l.quantity) || 0;
  const taxes = l.lineTaxableItems || l.taxableItems || [];
  let vatAmount = 0, vatRate = 0, other = 0;
  for (const t of taxes) {
    if (t.taxType === 'T1') { vatAmount += Number(t.amount) || 0; vatRate = Number(t.rate) || vatRate; }
    else other += (t.taxType === 'T4' ? -1 : 1) * (Number(t.amount) || 0);
  }
  const netTotal = Number(l.netTotal != null ? l.netTotal : l.salesTotal) || 0;
  const unitValue = l.unitValue ? Number(l.unitValue.amountEGP) || 0 : 0;
  const discount = (l.discount ? Number(l.discount.amount) || 0 : 0) + (Number(l.itemsDiscount) || 0);
  return {
    n: i + 1,
    description: (l.description || '').trim(),
    itemName: l.itemSecondaryName || l.itemPrimaryName || '',
    itemCode: l.itemCode || '',
    internalCode: l.internalCode || '',
    unitType: l.unitType || '',
    qty,
    unitValue,
    discount: U.r2(discount),
    netTotal: U.r2(netTotal),
    // السعر الفعلي للوحدة بعد أي خصم
    price: qty ? netTotal / qty : unitValue,
    vatRate,
    vatAmount: U.r2(vatAmount),
    otherTaxes: U.r2(other),
    total: U.r2(Number(l.total) || netTotal + vatAmount + other),
  };
};

Invoice.parse = (text) => {
  const root = Invoice._tryParse(text);
  const found = [];
  Invoice._collect(root, null, found, 0);
  if (!found.length) throw new Error('لم يتم العثور على بنود فاتورة (invoiceLines) في النص');
  return found.map(({ doc, outer }) => {
    const meta = Object.assign({}, outer || {}, doc);
    const lines = doc.invoiceLines.map(Invoice._line);
    const sum = (k) => U.r2(lines.reduce((a, l) => a + l[k], 0));
    return {
      id: U.uid(),
      uuid: meta.uuid || (outer && outer.uuid) || '',
      internalID: doc.internalID || meta.internalID || '',
      documentType: doc.documentType || meta.documentType || 'I',
      dateIssued: doc.dateTimeIssued || meta.dateTimeIssued || '',
      issuerName: (doc.issuer && doc.issuer.name) || meta.issuerName || '',
      issuerId: (doc.issuer && doc.issuer.id) || meta.issuerId || '',
      receiverName: (doc.receiver && doc.receiver.name) || meta.receiverName || '',
      receiverId: String((doc.receiver && doc.receiver.id) || meta.receiverId || ''),
      status: meta.status || '',
      netTotal: sum('netTotal'),
      vatTotal: sum('vatAmount'),
      otherTaxes: sum('otherTaxes'),
      total: U.r2(sum('netTotal') + sum('vatAmount') + sum('otherTaxes')),
      // إجمالي المستند كما سجّله المورد على المنظومة، والخصم الإجمالي على الفاتورة (للمطابقة مع مجموع البنود)
      docTotal: doc.totalAmount != null && Number.isFinite(Number(doc.totalAmount)) ? U.r2(Number(doc.totalAmount)) : null,
      extraDiscount: U.r2(Number(doc.extraDiscountAmount) || 0),
      lines,
      addedAt: new Date().toISOString(),
    };
  });
};
