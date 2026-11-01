/* فواتير المنظومة: سحب كل الفواتير المستلمة من منظومة الضرائب لفترة (كل الموردين مرة واحدة)،
 * تخزينها في البرنامج، وعرضها مجمّعة في قائمة لكل مورد، مع نسبة خصم وإضافة لكل مورد تُستخدم في الأظرف ونموذج 41. */
'use strict';

const EtaDocs = {};

EtaDocs.TYPE = { i: 'فاتورة', c: 'إشعار دائن', d: 'إشعار مدين' };
EtaDocs.today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });

/* تحويل نتيجة بحث المنظومة إلى سجل مختصر نخزنه */
EtaDocs.norm = (d, type) => {
  const total = Number(d.total) || 0;
  const net = d.netAmount != null ? Number(d.netAmount) : (Number(d.totalSales) || 0) - (Number(d.totalDiscount) || 0);
  return {
    uuid: String(d.uuid), internalId: String(d.internalId || ''), type,
    issuerId: String(d.issuerId || ''), issuerName: String(d.issuerName || ''), receiverId: String(d.receiverId || ''),
    date: d.dateTimeIssued ? ETA.cairoDay(d.dateTimeIssued) : '', net: U.r2(net), vat: U.r2(total - net), total: U.r2(total),
    status: String(d.status || ''),
  };
};

/* اسم المورد ونسبته: من سجل الموردين (الإعدادات) وإلا من المستند/النسبة العامة */
EtaDocs.supplier = (s, id, fallbackName) => {
  const sp = (s.suppliers || []).find((x) => x.id === id);
  return { id, name: (sp && sp.name) || fallbackName || id || 'بدون رقم', rate: sp && sp.whtRate != null ? Number(sp.whtRate) : null };
};
EtaDocs.rateOf = (s, id) => Engine.rateForSupplier(id, s);

/* حقل نسبة الخصم والإضافة لمورد (فارغ = النسبة العامة) — يحفظ في سجل الموردين */
EtaDocs.rateInput = (s, id, name, onDone) => {
  const sp = (s.suppliers || []).find((x) => x.id === id);
  const can = DB.can('settingsGeneral') && id;
  const input = h('input', {
    class: 'input cell short', type: 'number', min: '0', max: '100', step: 'any', value: sp && sp.whtRate != null ? sp.whtRate : '',
    placeholder: `${Number(s.whtRate) || 0}`, disabled: !can, 'aria-label': `نسبة الخصم والإضافة للمورد ${name}`, title: can ? 'فارغ = النسبة العامة' : 'تعديل النسبة يحتاج صلاحية الإعدادات العامة',
    onClick: (e) => e.stopPropagation(),
    onChange: async (e) => {
      const v = e.target.value.trim();
      const rate = v === '' ? null : Number(v);
      if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 100)) { e.target.value = sp && sp.whtRate != null ? sp.whtRate : ''; return U.toast('النسبة بين 0 و 100', 'err'); }
      const old = sp && sp.whtRate != null ? sp.whtRate + '%' : `العامة (${s.whtRate}%)`;
      const list = (s.suppliers || []).filter((x) => x.id !== id);
      if (rate !== null || (sp && sp.name)) list.push({ id, name: (sp && sp.name) || name || '', whtRate: rate });
      s.suppliers = list;
      try {
        await DB.saveSettings(s);
        await Activity.add('settings', 'نسبة خصم وإضافة لمورد', { type: 'settings', id: 'supplier-' + id, label: name || id }, `${name || ''} (${id}): من ${old} إلى ${rate === null ? `العامة (${s.whtRate}%)` : rate + '%'}`);
        U.toast('تم حفظ نسبة المورد', 'ok');
        if (onDone) onDone();
      } catch (err) { U.toast(err.message, 'err'); }
    },
  });
  return h('span', { class: 'row', style: 'gap:4px;flex-wrap:nowrap' }, input, h('span', { class: 'small muted' }, '%'));
};

/* السحب من المنظومة لفترة: كل الموردين، فواتير (+ إشعارات دائنة/مدينة اختيارياً) */
EtaDocs.pull = async (docs, done) => {
  if (!await ETA.ready()) return U.alert('الربط غير مُعد', 'أدخل Client ID و Client Secret من الإعدادات ← ربط الضرائب.');
  const today = EtaDocs.today();
  const first = today.slice(0, 8) + '01';
  const from = h('input', { class: 'input', type: 'date', value: first });
  const to = h('input', { class: 'input', type: 'date', value: today });
  const cn = h('input', { type: 'checkbox', checked: true });
  const onlyValid = h('input', { type: 'checkbox', checked: true });
  const ok = await U.modal({
    title: 'سحب الفواتير من منظومة الضرائب',
    body: h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
      h('div', { class: 'notice info' }, 'يسحب كل الفواتير المستلمة لشركتك من كل الموردين في الفترة، ويحفظها في البرنامج مجمّعة لكل مورد. الفواتير المسحوبة قبل كده تتحدث حالتها بدل ما تتكرر. المنظومة تسمح بطلب بحث كل ثانيتين، فالفترات الطويلة تاخد وقت.'),
      h('div', { class: 'grid' }, h('label', { class: 'field' }, 'تاريخ الإصدار من', from), h('label', { class: 'field' }, 'إلى', to)),
      h('label', { class: 'row' }, cn, 'سحب الإشعارات الدائنة والمدينة كمان (تُخصم من أساس نموذج 41)'),
      h('label', { class: 'row' }, onlyValid, 'المستندات الصالحة فقط')),
    actions: [{ label: 'سحب', value: true, cls: 'primary', validate: () => { if (!from.value || !to.value || from.value > to.value) { U.toast('حدد فترة صحيحة', 'err'); return false; } return true; } }, { label: 'إلغاء', value: false }],
  });
  if (!ok) return;
  const types = cn.checked ? ['i', 'c', 'd'] : ['i'];
  const byId = new Map(docs.map((d) => [d.uuid, d]));
  let added = 0, updated = 0;
  const b = U.busy('السحب من منظومة الضرائب...');
  try {
    for (const type of types) {
      const found = await ETA.searchReceived({ issuerId: '', from: from.value, to: to.value, onlyValid: onlyValid.checked, docType: type, onProgress: (m) => b.set(`${EtaDocs.TYPE[type]}: ${m}`) });
      for (const raw of found) {
        const d = EtaDocs.norm(raw, type);
        const old = byId.get(d.uuid);
        if (old) { if (old.status !== d.status || old.total !== d.total) updated++; Object.assign(old, d); } else { d.fetchedAt = new Date().toISOString(); d.fetchedBy = DB.user.username; byId.set(d.uuid, d); added++; }
      }
    }
    const all = [...byId.values()];
    await DB.save('etadocs', all);
    await Activity.add('envelopes', 'سحب فواتير من المنظومة', { type: 'eta', id: 'etadocs', label: 'فواتير المنظومة' }, `الفترة ${U.fmtDay(from.value)} – ${U.fmtDay(to.value)} · جديد ${added} · تحدّث ${updated} · الإجمالي المخزن ${all.length}`);
    b.done();
    U.alert('تم السحب', `مستندات جديدة: ${added}\nتحدّثت حالتها أو قيمتها: ${updated}\nالإجمالي المخزن في البرنامج: ${all.length}`);
    done();
  } catch (e) { b.done(); U.alert('تعذر السحب', e.message + (added ? `\n\nلم يتم حفظ ${added} مستند تم سحبه قبل الخطأ — أعد المحاولة.` : '')); }
};

EtaDocs.view = async () => {
  const s = await DB.load('settings');
  const docs = await DB.load('etadocs', []);
  const canEnv = DB.can('envelopes');
  // ربط المستند بالظرف الذي راجعه (بالـ UUID)
  const inEnv = new Map();
  try {
    const { quotesById } = await Envelopes.ctx();
    for (const env of await DB.load('envelopes', [])) {
      const calc = Engine.calcEnvelope(env, quotesById, s);
      for (const x of calc.invs) if (x.inv.uuid) inEnv.set(x.inv.uuid, { env, x });
    }
  } catch (e) { /* بدون صلاحية الأظرف */ }
  const months = [...new Set(docs.map((d) => d.date.slice(0, 7)).filter(Boolean))].sort();
  const f = { from: months[0] || EtaDocs.today().slice(0, 7), to: months[months.length - 1] || EtaDocs.today().slice(0, 7), term: '', type: 'all', review: 'all' };
  const opened = new Set();
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:12px' });
  const draw = () => {
    const t = U.norm(f.term);
    const list = docs.filter((d) => (!d.date || (d.date.slice(0, 7) >= f.from && d.date.slice(0, 7) <= f.to))
      && (f.type === 'all' || d.type === f.type)
      && (f.review === 'all' || (f.review === 'in' ? inEnv.has(d.uuid) : !inEnv.has(d.uuid)))
      && (!t || U.norm(`${d.issuerName} ${d.issuerId} ${d.internalId}`).includes(t)));
    const groups = new Map();
    for (const d of list) {
      const g = groups.get(d.issuerId) || { id: d.issuerId, docs: [], net: 0, total: 0, name: d.issuerName };
      const sign = d.type === 'c' ? -1 : 1;
      g.docs.push(d); g.net = U.r2(g.net + sign * d.net); g.total = U.r2(g.total + sign * d.total);
      groups.set(d.issuerId, g);
    }
    const gl = [...groups.values()].map((g) => ({ ...g, ...EtaDocs.supplier(s, g.id, g.name) })).sort((a, b) => b.net - a.net);
    const totNet = U.r2(gl.reduce((a, g) => a + g.net, 0));
    const totWht = U.r2(gl.reduce((a, g) => a + g.net * EtaDocs.rateOf(s, g.id) / 100, 0));
    const reviewed = list.filter((d) => inEnv.has(d.uuid)).length;
    U.fill(body,
      h('div', { class: 'grid' },
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'مستندات'), h('div', { class: 'value' }, list.length), h('div', { class: 'sub' }, `${reviewed} منها في أظرف`)),
        h('div', { class: 'stat' }, h('div', { class: 'label' }, 'موردون'), h('div', { class: 'value' }, gl.length)),
        Envelopes.stat('صافي المشتريات (بعد الإشعارات)', totNet),
        Envelopes.stat('خصم وإضافة تقديري', totWht, 'good')),
      gl.length ? null : h('div', { class: 'card card-body muted' }, docs.length ? 'لا توجد مستندات في هذا الاختيار.' : 'لم يتم سحب أي فواتير بعد — اضغط "سحب من المنظومة".'),
      ...gl.map((g) => {
        const open = opened.has(g.id);
        const rate = EtaDocs.rateOf(s, g.id);
        const bar = h('div', { class: 'inv-bar', style: 'padding:0;border:0;background:none;box-shadow:none' },
          h('button', { type: 'button', class: 'bar-toggle', 'aria-expanded': open ? 'true' : 'false', 'aria-label': (open ? 'طي ' : 'فتح ') + g.name, onClick: () => { if (open) opened.delete(g.id); else opened.add(g.id); draw(); } }, open ? '−' : '+'),
          h('strong', null, g.name), h('span', { class: 'small muted num' }, g.id),
          h('span', { class: 'small' }, `${g.docs.length} مستند`),
          h('span', { class: 'small' }, 'الصافي ', h('strong', null, U.num(g.net))),
          h('span', { class: 'spacer' }),
          h('span', { class: 'small muted' }, 'نسبة الخصم والإضافة'), EtaDocs.rateInput(s, g.id, g.name, draw),
          h('span', { class: 'small' }, 'الخصم ', h('strong', null, U.num(U.r2(g.net * rate / 100)))));
        return h('section', { class: 'card', style: 'padding:8px 14px' }, bar,
          open ? h('div', { class: 'table-wrap', style: 'margin-top:8px' }, h('table', { class: 't' },
            h('thead', null, h('tr', null, ['رقم المستند', 'النوع', 'التاريخ', 'الصافي', 'الضرائب', 'الإجمالي', 'الحالة', 'المراجعة'].map((x) => h('th', null, x)))),
            h('tbody', null, g.docs.slice().sort((a, b) => String(a.internalId).localeCompare(String(b.internalId), 'en', { numeric: true })).map((d) => {
              const r = inEnv.get(d.uuid);
              return h('tr', { class: d.type === 'c' ? 'short' : '' },
                h('td', null, h('strong', null, d.internalId || '—'), h('div', { class: 'sub num' }, d.uuid)),
                h('td', null, EtaDocs.TYPE[d.type] || d.type), h('td', null, U.fmtDay(d.date)),
                h('td', null, U.num(d.net)), h('td', null, U.num(d.vat)), h('td', null, U.num(d.total)),
                h('td', null, Envelopes.validStatus(d.status) ? h('span', { class: 'chip ok' }, 'صالح') : h('span', { class: 'chip bad' }, d.status)),
                h('td', null, r ? h('a', { href: '#/envelope/' + r.env.id }, r.env.status === 'approved' ? 'في ظرف معتمد' : 'في ظرف قيد المراجعة') : h('span', { class: 'chip warn' }, 'لم تُراجع')));
            })))) : null);
      }));
  };
  const exp = () => {
    const list = docs.filter((d) => !d.date || (d.date.slice(0, 7) >= f.from && d.date.slice(0, 7) <= f.to));
    Reports.xlsx(`فواتير المنظومة ${f.from} إلى ${f.to}.xlsx`, [['المستندات',
      [['المورد', 'الرقم الضريبي', 'رقم المستند', 'النوع', 'التاريخ', 'الصافي', 'الضرائب', 'الإجمالي', 'الحالة', 'نسبة الخصم والإضافة', 'الخصم', 'في ظرف', 'UUID']]
        .concat(list.map((d) => { const sp = EtaDocs.supplier(s, d.issuerId, d.issuerName); const rate = EtaDocs.rateOf(s, d.issuerId); const r = inEnv.get(d.uuid); return [sp.name, d.issuerId, d.internalId, EtaDocs.TYPE[d.type] || d.type, d.date, d.net, d.vat, d.total, d.status, rate / 100, U.r2((d.type === 'c' ? -1 : 1) * d.net * rate / 100), r ? (r.env.status === 'approved' ? 'معتمد' : 'قيد المراجعة') : '', d.uuid]; })),
      [28, 12, 14, 10, 11, 12, 11, 12, 9, 10, 10, 12, 38]]]);
  };
  draw();
  const mOpts = (months.length ? months : [f.from]).map((m) => ({ value: m, label: U.monthName(m) }));
  return h('div', { style: 'display:flex;flex-direction:column;gap:16px' },
    Reports.head('فواتير المنظومة', 'كل الفواتير المستلمة من منظومة الضرائب مخزنة في البرنامج ومجمّعة لكل مورد، ومعها نسبة الخصم والإضافة لكل مورد (فارغة = النسبة العامة).',
      canEnv ? h('button', { type: 'button', class: 'btn primary', onClick: () => EtaDocs.pull(docs, () => { DB.invalidate(); App.route(); }) }, 'سحب من المنظومة') : null,
      h('button', { type: 'button', class: 'btn', onClick: exp }, 'تصدير Excel')),
    h('div', { class: 'row no-print', role: 'group', 'aria-label': 'فلاتر' },
      h('label', { class: 'row small' }, 'من', U.select(mOpts, f.from, (v) => { f.from = v; draw(); }, { style: 'width:140px' })),
      h('label', { class: 'row small' }, 'إلى', U.select(mOpts, f.to, (v) => { f.to = v; draw(); }, { style: 'width:140px' })),
      U.select([{ value: 'all', label: 'كل الأنواع' }, { value: 'i', label: 'فواتير' }, { value: 'c', label: 'إشعارات دائنة' }, { value: 'd', label: 'إشعارات مدينة' }], 'all', (v) => { f.type = v; draw(); }, { style: 'width:140px', 'aria-label': 'النوع' }),
      U.select([{ value: 'all', label: 'الكل' }, { value: 'out', label: 'لم تُراجع في أظرف' }, { value: 'in', label: 'في أظرف' }], 'all', (v) => { f.review = v; draw(); }, { style: 'width:170px', 'aria-label': 'المراجعة' }),
      h('input', { class: 'input', placeholder: 'بحث بالمورد أو الرقم الضريبي أو رقم الفاتورة', style: 'width:260px;max-width:100%', onInput: (e) => { f.term = e.target.value; draw(); } }),
      h('button', { type: 'button', class: 'btn sm', onClick: () => { const l = docs.map((d) => d.issuerId); const all = new Set(l); const allOpen = [...all].every((id) => opened.has(id)); opened.clear(); if (!allOpen) for (const id of all) opened.add(id); draw(); } }, 'فتح/طي الكل')),
    body);
};
