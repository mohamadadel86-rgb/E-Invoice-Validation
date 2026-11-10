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

/* ===== الحسابات: في الملف المشترك calc.js (نفس الكود يحسب به الخادم عند الاعتماد) ===== */
Engine.calcLine = Calc.calcLine;
Engine.calcInvoice = Calc.calcInvoice;
Engine.supplierId = Calc.supplierId;
Engine.rateForSupplier = Calc.rateForSupplier;
Engine.whtRateOf = Calc.whtRateOf;
Engine.calcEnvelope = Calc.calcEnvelope;

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
      // التأكيد التلقائي لا يعتمد على ثقة النموذج وحدها (وصف البند يكتبه المورد وقد يضلل النموذج):
      // لازم الاسم قريب من صنف العرض أو سعر الفاتورة مطابق لسعره، وإلا يبقى الربط اقتراحاً يحتاج تأكيدك
      const it = items.find((i) => i.id === r.item_id);
      const nameOk = U.sim(l.description, Engine.itemLabel(it)) >= 0.45;
      const priceOk = it.price > 0 && l.price > 0 && Math.abs(l.price - it.price * factor) / l.price < 0.02;
      const sure = conf >= 0.9 && factor === 1 && !l.m.note;
      l.confirmed = sure && (nameOk || priceOk);
      if (sure && !l.confirmed) l.m.note = 'اقتراح الذكاء الاصطناعي: الاسم مختلف والسعر غير مطابق لسعر العرض — راجع الربط';
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
