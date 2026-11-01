/* محرك المطابقة والحسابات
 * الذكاء الاصطناعي يربط الأسماء ويقترح معامل العبوة فقط، وكل الحسابات المالية هنا بالكود.
 */
'use strict';

const Engine = {};

Engine.itemKey = (it) => U.norm(it.name + (it.spec ? ' ' + it.spec : ''));
Engine.itemLabel = (it) => it.name + (it.spec ? ' — ' + it.spec : '');
Engine.memKey = (category, description) => category + '|' + U.norm(description);

/* ===== اختيار عرض السعر ===== */
Engine.quotesFor = async (month, category) => {
  const quotes = await DB.load('quotes', []);
  return quotes.filter((q) => q.month === month && q.category === category);
};
Engine.coversMonth = (q) => q.from <= U.monthFirst(q.month) && q.to >= U.monthLast(q.month);

/* ===== حساب بند واحد ===== */
Engine.calcLine = (line, quote, settings) => {
  const item = line.m && line.m.itemId && quote ? quote.items.find((i) => i.id === line.m.itemId) : null;
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
  const actualNet = line.rejected ? 0 : U.r2(received * approvedPrice);
  const actualVatCalc = U.r2(actualNet * vatRate / 100);
  const cnNet = Math.max(0, U.r2(line.netTotal - actualNet));
  const cnVat = Math.max(0, U.r2(line.vatAmount - actualVatCalc));
  const finalNet = U.r2(line.netTotal - cnNet);
  const finalVat = U.r2(line.vatAmount - cnVat);

  const reasons = [];
  if (line.rejected) reasons.push(item ? 'صنف مرفوض بالكامل' : 'صنف غير موجود بعرض السعر — مرفوض');
  else {
    if (received < line.qty) reasons.push(`فرق كمية: الفاتورة ${U.fmtQ(line.qty)} والمستلم ${U.fmtQ(received)}`);
    if (expected != null && P > expected + 0.005) reasons.push(`فرق سعر: سعر الفاتورة ${U.fmt(P)} وسعر العرض ${U.fmt(expected)} — الفرق ${U.fmt(P - expected)} × ${U.fmtQ(received)} = ${U.fmt((P - expected) * received)}`);
    if (manualPrice != null && P > manualPrice + 0.005) reasons.push(`فرق سعر: سعر الفاتورة ${U.fmt(P)} والسعر المعتمد يدوياً من المشتريات ${U.fmt(manualPrice)} — الفرق ${U.fmt(P - manualPrice)} × ${U.fmtQ(received)} = ${U.fmt((P - manualPrice) * received)}`);
  }
  const vatExpectedOnCn = U.r2(cnNet * line.vatRate / 100);
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
    actualNet, cnNet, cnVat, cnTotal: U.r2(cnNet + cnVat), finalNet, finalVat,
    reasons, notes, status,
  };
};

Engine.calcInvoice = (inv, quote, settings) => {
  const rows = inv.lines.map((l) => ({ line: l, c: Engine.calcLine(l, quote, settings) }));
  const s = (f) => U.r2(rows.reduce((a, r) => a + f(r), 0));
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
  t.invTotal = U.r2(t.invNet + t.invVat + t.other);
  t.cnTotal = U.r2(t.cnNet + t.cnVat);
  // ضريبة الخصم والإضافة على القيمة الفعلية المعتمدة بعد التعديلات
  t.wht = U.r2(t.finalNet * (Number(settings.whtRate) || 0) / 100);
  t.payable = U.r2(t.finalNet + t.finalVat + t.other - t.wht);
  return { rows, t };
};

/* نسبة الخصم والإضافة للمورد: من سجل الموردين (الإعدادات) وإلا النسبة العامة.
 * الظرف المعتمد يحتفظ بالنسبة التي اعتُمد بها حتى لا تتغير أرقامه لو تغيّرت النسبة لاحقاً */
Engine.supplierId = (env) => env.supplierTaxId || ((env.invoices || []).find((i) => i.issuerId) || {}).issuerId || '';
Engine.rateForSupplier = (id, settings) => {
  const sp = (settings.suppliers || []).find((x) => x.id === id);
  return sp && sp.whtRate != null ? Number(sp.whtRate) : (Number(settings.whtRate) || 0);
};
Engine.whtRateOf = (env, settings) => (env.status === 'approved' && env.whtRate != null ? Number(env.whtRate) : Engine.rateForSupplier(Engine.supplierId(env), settings));

Engine.calcEnvelope = (env, quotesById, settings) => {
  const whtRate = Engine.whtRateOf(env, settings);
  const st = whtRate === Number(settings.whtRate) ? settings : Object.assign({}, settings, { whtRate });
  const invs = env.invoices.map((inv) => ({ inv, quote: quotesById[inv.quoteId], whtRate, ...Engine.calcInvoice(inv, quotesById[inv.quoteId], st) }))
    .sort((a, b) => String(a.inv.internalID || '').localeCompare(String(b.inv.internalID || ''), 'en', { numeric: true }));
  const keys = ['invNet', 'invVat', 'other', 'invTotal', 'cnNet', 'cnVat', 'cnTotal', 'finalNet', 'finalVat', 'wht', 'payable', 'pending'];
  const t = {};
  for (const k of keys) t[k] = U.r2(invs.reduce((a, x) => a + x.t[k], 0));
  return { invs, t, whtRate };
};

/* بحث في أصناف عرض السعر: برقم البند أو بأجزاء الاسم، وبدون نص = الأقرب لاسم صنف الفاتورة */
Engine.searchItems = (quote, query, hint, n) => {
  const items = quote.items.filter((it) => it.name);
  const q = U.norm(query);
  n = n || 30;
  if (!q) return Engine.fuzzy(hint || '', items, n).map((x) => x.it);
  const toks = q.split(' ').filter(Boolean);
  const scored = [];
  for (const it of items) {
    const no = U.norm(it.no);
    const label = U.norm(`${it.name} ${it.spec || ''} ${it.unit || ''}`);
    let score = 0;
    if (no && no === q) score = 3;
    else if (no && /^\d+$/.test(q) && no.startsWith(q)) score = 2;
    else if (toks.every((t) => label.includes(t) || no === t)) score = 1 + (label.startsWith(toks[0]) ? 0.2 : 0);
    else { const sm = U.sim(query, it.name + ' ' + (it.spec || '')); if (sm >= 0.35) score = sm * 0.9; }
    if (score) scored.push({ it, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, n).map((x) => x.it);
};

/* ===== المطابقة ===== */
Engine.fuzzy = (text, items, n) => items
  .map((it) => ({ it, score: U.sim(text, Engine.itemLabel(it)) }))
  .sort((a, b) => b.score - a.score)
  .slice(0, n || 5);

/* يطابق البنود غير المربوطة. force = إعادة مطابقة كل البنود غير المؤكدة يدوياً */
Engine.matchInvoice = async (inv, quote, category, { useAI, force, onStatus } = {}) => {
  const mappings = await DB.load('mappings', {});
  const items = quote.items.filter((it) => it.name);
  const byKey = new Map(items.map((it) => [Engine.itemKey(it), it]));
  const todo = [];
  for (const l of inv.lines) {
    if (l.m && !force) continue;
    if (l.m && l.m.src === 'manual') continue;
    if (l.manualApproval) continue; // معتمد يدوياً خارج العرض: لا نعيد ربطه
    l.m = null; l.confirmed = false;
    // 1) ذاكرة الربط
    const mem = mappings[Engine.memKey(category, l.description)];
    if (mem) {
      let it = byKey.get(mem.key);
      if (!it) {
        const best = Engine.fuzzy(mem.label, items, 1)[0];
        if (best && best.score >= 0.9) it = best.it;
      }
      if (it) { l.m = { itemId: it.id, factor: mem.factor, conf: 1, src: 'memory', note: '' }; l.confirmed = true; continue; }
    }
    // 2) تطابق حرفي بعد التطبيع
    const exact = byKey.get(U.norm(l.description));
    if (exact) { l.m = { itemId: exact.id, factor: 1, conf: 1, src: 'exact', note: '' }; l.confirmed = true; continue; }
    todo.push(l);
  }
  if (!todo.length) return { ai: false, count: 0 };

  // توفير طلبات الذكاء الاصطناعي: لو كل البنود الباقية واضحة بالاسم والسعر لا نرسل طلباً
  const bests = new Map(todo.map((l) => [l, Engine.fuzzyBest(l, items)]));
  const allClear = todo.every((l) => { const b = bests.get(l); return b && b.score >= 0.75 && b.priceOk; });

  if (useAI && !allClear && await AI.ready()) {
    onStatus && onStatus(`مطابقة ${todo.length} بند بالذكاء الاصطناعي...`);
    const res = await AI.matchLines(todo, items, Settings.catName(category, await DB.load('settings')));
    const ids = new Set(items.map((i) => i.id));
    for (const r of res) {
      const l = todo.find((x) => x.n === Number(r.line));
      if (!l || !r.item_id || !ids.has(r.item_id)) continue;
      const factor = Number(r.factor) > 0 ? Number(r.factor) : 1;
      const conf = Math.max(0, Math.min(1, Number(r.confidence) || 0));
      l.m = { itemId: r.item_id, factor, conf, src: 'ai', note: (r.note || '').trim() };
      l.confirmed = conf >= 0.9 && factor === 1 && !l.m.note;
    }
    return { ai: true, count: todo.length };
  }
  // بدون ذكاء اصطناعي: أقرب اسم (مع ترجيح السعر المطابق) كاقتراح يحتاج تأكيد
  for (const l of todo) {
    const best = bests.get(l);
    if (best && best.score >= 0.45) {
      l.m = { itemId: best.it.id, factor: best.factor, conf: U.r2(best.score), src: 'fuzzy', note: best.factor !== 1 ? `معامل ${best.factor} مستنتج من نسبة السعر` : '' };
      l.confirmed = false;
    }
  }
  return { ai: false, count: todo.length };
};

/* أقرب صنف بالاسم مع ترجيح الصنف الذي يطابق سعره سعر الفاتورة */
Engine.fuzzyBest = (l, items) => Engine.fuzzy(l.description, items, 6).map((c) => {
  const factor = Engine.guessFactor(l.price, c.it.price);
  const priceOk = c.it.price > 0 && Math.abs(l.price - c.it.price * factor) / l.price < 0.01;
  return Object.assign(c, { factor, priceOk, rank: c.score + (priceOk ? 0.15 : 0) });
}).sort((a, b) => b.rank - a.rank)[0];

Engine.guessFactor = (price, itemPrice) => {
  if (!itemPrice || !price) return 1;
  const ratio = price / itemPrice;
  return [1, 2, 3, 4, 5, 6, 10, 12, 20, 24, 25, 50, 100].find((f) => Math.abs(ratio - f) / f < 0.02) || 1;
};

/* حفظ ربط بند واحد فوراً عند التأكيد، وتطبيقه على البنود المشابهة في نفس الظرف.
 * يرجع عدد البنود الأخرى التي تأكدت تلقائياً. */
Engine.remember = async (env, line, quote) => {
  if (!line.m || !quote) return 0;
  const it = quote.items.find((i) => i.id === line.m.itemId);
  if (!it) return 0;
  const mappings = await DB.load('mappings', {});
  const k = Engine.memKey(env.category, line.description);
  const prev = mappings[k];
  const factor = Number(line.m.factor) || 1;
  mappings[k] = {
    description: line.description, key: Engine.itemKey(it), label: Engine.itemLabel(it), unit: it.unit,
    factor, category: env.category, updatedAt: new Date().toISOString(),
    count: (prev ? prev.count || 0 : 0) + 1,
  };
  await DB.save('mappings', mappings);
  const quotes = await DB.load('quotes', []);
  let applied = 0;
  for (const inv of env.invoices) {
    const q = quotes.find((x) => x.id === inv.quoteId);
    if (!q) continue;
    const target = q.items.find((i) => i.id === it.id) || q.items.find((i) => Engine.itemKey(i) === mappings[k].key);
    if (!target) continue;
    for (const l of inv.lines) {
      if (l === line || l.rejected || l.confirmed) continue;
      if (Engine.memKey(env.category, l.description) !== k) continue;
      l.m = { itemId: target.id, factor, conf: 1, src: 'memory', note: '' };
      l.confirmed = true;
      applied++;
    }
  }
  return applied;
};

/* حفظ الربط المعتمد في ذاكرة التعلم + تثبيت نسبة ق.م في عرض السعر */
Engine.learn = async (env, quotesById) => {
  const mappings = await DB.load('mappings', {});
  const quotes = await DB.load('quotes', []);
  const settings = await DB.load('settings');
  for (const inv of env.invoices) {
    const quote = quotesById[inv.quoteId];
    if (!quote) continue;
    for (const l of inv.lines) {
      if (!l.m || l.rejected) continue;
      const it = quote.items.find((i) => i.id === l.m.itemId);
      if (!it) continue;
      const k = Engine.memKey(env.category, l.description);
      const prev = mappings[k];
      mappings[k] = {
        description: l.description, key: Engine.itemKey(it), label: Engine.itemLabel(it), unit: it.unit,
        factor: Number(l.m.factor) || 1, category: env.category, updatedAt: new Date().toISOString(),
        count: (prev ? prev.count || 0 : 0) + 1,
      };
      const qRef = quotes.find((q) => q.id === quote.id);
      const qi = qRef && qRef.items.find((i) => i.id === it.id);
      if (qi && qi.vat == null) qi.vat = Engine.calcLine(l, quote, settings).vatRate;
    }
  }
  await DB.save('mappings', mappings);
  await DB.save('quotes', quotes);
};
