/* سجل النشاط: كل إجراء يقوم به المستخدم داخل النظام (منفصل عن سجل الدخول)
 * الخادم هو الذي يكتبه ويختم عليه هوية المستخدم والوقت من الجلسة (لا يمكن تزوير الاسم من المتصفح)، ومحفوظ مشفراً مع باقي البيانات.
 */
'use strict';

const Activity = { MAX: 10000 };

Activity.SECTIONS = {
  envelopes: 'أظرف الموردين',
  quotes: 'عروض الأسعار',
  users: 'المستخدمين',
  settings: 'الإعدادات',
};

/* section: مفتاح من SECTIONS · action: نص الإجراء · target: {type,id,label} · details: نص التفاصيل */
Activity.add = async (section, action, target, details) => {
  if (!DB.user) return;
  try {
    await DB.call('POST', '/api/v2/activity', { section, action, target: target || undefined, details: details || '' });
  } catch (e) { console.error('activity log', e); }
};

Activity.envTarget = (env, s) => ({ type: 'envelope', id: env.id, label: `${env.supplier || 'ظرف'} — ${Settings.catName(env.category, s)} ${U.monthName(env.month)}` });
Activity.quoteTarget = (q, s) => ({ type: 'quote', id: q.id, label: `عرض سعر ${Settings.catName(q.category, s)} ${U.monthName(q.month)} (${U.fmtDay(q.from)} – ${U.fmtDay(q.to)})` });
Activity.lineText = (inv, l) => `فاتورة ${inv.internalID || '—'} · بند ${l.n} «${l.description}»`;
Activity.v = (x) => (x == null || x === '' ? 'فارغ' : String(x));

Activity.link = (e) => {
  if (e.targetType === 'envelope') return h('a', { href: '#/envelope/' + e.targetId }, e.targetLabel);
  if (e.targetType === 'quote') return h('a', { href: '#/quote/' + e.targetId }, e.targetLabel);
  return e.targetLabel || '';
};

/* جدول السجل (يُستخدم في شاشة الإعدادات وفي نافذة سجل الظرف/العرض) */
Activity.table = (list, compact) => h('div', { class: 'table-wrap' }, h('table', { class: 't', style: compact ? '' : 'min-width:1000px' },
  h('thead', null, h('tr', null, (compact ? ['الوقت', 'المستخدم', 'الإجراء', 'التفاصيل'] : ['الوقت', 'المستخدم', 'القسم', 'الإجراء', 'على', 'التفاصيل']).map((x) => h('th', null, x)))),
  h('tbody', null, list.length ? list.map((e) => h('tr', null,
    h('td', { class: 'num small', style: 'white-space:nowrap' }, Settings.fmtDT(e.at)),
    h('td', null, h('strong', null, e.displayName || e.username), h('div', { class: 'sub' }, e.username)),
    compact ? null : h('td', { class: 'small' }, Activity.SECTIONS[e.section] || e.section),
    h('td', null, h('span', { class: 'chip ' + Activity.chip(e.action) }, e.action),
      e.src === 'server' ? h('div', { class: 'sub', title: 'حدث سجّله الخادم نفسه من الفعل الحقيقي، وليس وصفاً أرسلته الشاشة' }, '✓ من الخادم') : null),
    compact ? null : h('td', { class: 'small' }, Activity.link(e)),
    h('td', { class: 'small', style: 'white-space:pre-line;max-width:520px' }, e.details))) :
    h('tr', null, h('td', { colspan: compact ? 4 : 6, class: 'muted', style: 'text-align:center;padding:20px' }, 'لا يوجد نشاط مسجل')))));

Activity.chip = (action) => (/حذف|رفض|استرجاع/.test(action) ? 'bad' : /اعتماد|إنشاء|إضافة|رفع/.test(action) ? 'ok' : /تعديل|تغيير|إعادة/.test(action) ? 'warn' : 'gray');

/* نافذة سجل عنصر واحد (ظرف أو عرض سعر) */
Activity.showFor = async (targetId, title) => {
  let list;
  try { list = (await DB.call('GET', '/api/v2/activity?target=' + encodeURIComponent(targetId))).value.sort((a, b) => b.at - a.at); }
  catch (e) { return U.toast(e.message, 'err'); }
  await U.modal({ title, wide: true, body: Activity.table(list, true) });
};

/* شاشة سجل النشاط في الإعدادات */
Activity.view = async () => {
  const users = await DB.users();
  const wrap = h('div', { class: 'card' });
  let fUser = '', fSection = '', fFrom = '', fTo = '', term = '';
  const body = h('div');
  const counts = h('div', { class: 'muted small' });
  const first = await DB.call('GET', '/api/v2/activity');
  let all = first.value;
  // الأحداث الأقدم من آخر 10,000 محفوظة في الأرشيف وتُحمَّل عند الطلب
  const archBtn = first.archived ? h('button', { type: 'button', class: 'btn sm', onClick: async () => {
    try { all = all.concat((await DB.call('GET', '/api/v2/activity?archive=1')).value); } catch (e) { return U.toast(e.message, 'err'); }
    archBtn.remove();
    draw();
  } }, `عرض الأرشيف (${first.archived} حركة أقدم)`) : null;
  const filtered = async () => {
    const t = U.norm(term);
    return all.filter((e) => {
      if (fUser && e.username !== fUser) return false;
      if (fSection && e.section !== fSection) return false;
      const day = new Date(e.at).toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
      if (fFrom && day < fFrom) return false;
      if (fTo && day > fTo) return false;
      if (t && !U.norm(`${e.action} ${e.targetLabel} ${e.details}`).includes(t)) return false;
      return true;
    }).sort((a, b) => b.at - a.at);
  };
  const draw = async () => {
    const list = await filtered();
    counts.textContent = `${list.length} حركة${list.length > 1000 ? ' (يُعرض آخر 1000 — استخدم الفلاتر أو التصدير)' : ''}`;
    U.fill(body, Activity.table(list.slice(0, 1000)));
  };
  const userOpts = [{ value: '', label: 'كل المستخدمين' }].concat(users.map((u) => ({ value: u.username, label: u.username })));
  const secOpts = [{ value: '', label: 'كل الأقسام' }].concat(Object.entries(Activity.SECTIONS).map(([v, label]) => ({ value: v, label })));
  U.fill(wrap,
    h('div', { class: 'card-head' },
      h('div', null, h('h2', null, 'سجل النشاط'), counts),
      h('div', { class: 'row' },
        U.select(userOpts, '', (v) => { fUser = v; draw(); }, { 'aria-label': 'المستخدم', style: 'width:150px' }),
        U.select(secOpts, '', (v) => { fSection = v; draw(); }, { 'aria-label': 'القسم', style: 'width:150px' }),
        h('label', { class: 'row small' }, 'من', h('input', { class: 'input', type: 'date', style: 'width:150px', onChange: (e) => { fFrom = e.target.value; draw(); } })),
        h('label', { class: 'row small' }, 'إلى', h('input', { class: 'input', type: 'date', style: 'width:150px', onChange: (e) => { fTo = e.target.value; draw(); } })),
        h('input', { class: 'input', placeholder: 'بحث (رقم فاتورة، صنف، مورد...)', style: 'width:220px', onInput: (e) => { term = e.target.value; clearTimeout(Activity._t); Activity._t = setTimeout(draw, 250); } }),
        archBtn,
        h('button', { type: 'button', class: 'btn sm', onClick: async () => Activity.exportExcel(await filtered()) }, 'تصدير Excel'))),
    body,
    h('div', { class: 'card-body small muted' }, 'السجل يكتبه الخادم بهوية الجلسة الفعلية، ومحفوظ مشفراً ولا يمكن تعديله من داخل البرنامج. علامة "✓ من الخادم" تعني أن الخادم سجّل الحدث بنفسه. الأقدم من آخر 10,000 حركة يُنقل للأرشيف ولا يُحذف.'));
  await draw();
  return wrap;
};

Activity.exportExcel = async (list) => {
  await Quotes.ensureXLSX();
  const data = [['الوقت', 'المستخدم', 'اسم الدخول', 'القسم', 'الإجراء', 'على', 'التفاصيل']]
    .concat(list.map((e) => [Settings.fmtDT(e.at), e.displayName || '', e.username, Activity.SECTIONS[e.section] || e.section, e.action, e.targetLabel || '', e.details]));
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 12 }, { wch: 14 }, { wch: 20 }, { wch: 40 }, { wch: 70 }];
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.utils.book_append_sheet(wb, ws, 'سجل النشاط');
  XLSX.writeFile(wb, `سجل النشاط ${new Date().toISOString().slice(0, 10)}.xlsx`);
};
