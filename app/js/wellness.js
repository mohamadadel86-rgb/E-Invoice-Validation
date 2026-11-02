/* تذكيرات الراحة: مواقيت الصلاة (قبل الأذان، الأذان، الإقامة) + مياه + حركة + راحة العين.
 * الإعدادات شخصية لكل مستخدم ومحفوظة عند الخادم (/api/v2/me/wellness)، ومقفولة افتراضياً.
 * الجدولة تعمل والبرنامج مفتوح فقط. ما ظهر من تنبيهات يُحفظ في المتصفح حتى لا يتكرر بعد إعادة التحميل. */
'use strict';

const Wellness = { prefs: null, userId: null, queue: [], showing: null, snoozed: [] };

Wellness.ICONS = {
  mosque: '<path d="M4 21h16"></path><path d="M6 21v-7a6 6 0 0 1 12 0v7"></path><path d="M12 3v3"></path><path d="M10 21v-3a2 2 0 0 1 4 0v3"></path>',
  bell: '<path d="M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6"></path><path d="M9 17v1a3 3 0 0 0 6 0v-1"></path>',
  people: '<circle cx="9" cy="7" r="4"></circle><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path><path d="M21 21v-2a4 4 0 0 0-3-3.85"></path>',
  drop: '<path d="M12 3l5 7a6 6 0 1 1-10 0z"></path>',
  walk: '<circle cx="13" cy="4" r="1.5"></circle><path d="M7 21l3-4"></path><path d="M16 21l-2-4l-3-3l1-6"></path><path d="M6 12l2-3l4-1l3 3l3 1"></path>',
  eye: '<path d="M2 12s4-7 10-7s10 7 10 7s-4 7-10 7s-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle>',
};

/* "دقيقة / دقيقتين / 3 دقايق" بالعامية */
Wellness.mins = (n) => (n === 1 ? 'دقيقة' : n === 2 ? 'دقيقتين' : n <= 10 ? n + ' دقايق' : n + ' دقيقة');

/* ===== الإعدادات ===== */
Wellness.load = async () => {
  if (!DB.user) return null;
  if (Wellness.prefs && Wellness.userId === DB.user.id) return Wellness.prefs;
  const r = await DB.call('GET', '/api/v2/me/wellness');
  Wellness.prefs = r.value; Wellness.userId = DB.user.id;
  return Wellness.prefs;
};
Wellness.save = async (value) => {
  const r = await DB.call('PUT', '/api/v2/me/wellness', { value });
  Wellness.prefs = r.value; Wellness.userId = DB.user.id;
  // مدد التذكيرات تبدأ من لحظة الحفظ
  const st = Wellness.state();
  for (const k of ['water', 'move', 'eye']) st.last[k] = Date.now();
  Wellness.saveState(st);
  Wellness.tick();
  return r.value;
};

/* حالة محلية لكل مستخدم: ما ظهر، آخر تذكير، والإيقاف المؤقت (راحة شخصية — لو اتمسحت لا ضرر) */
Wellness.stateKey = () => 'einv-wellness:' + (DB.user ? DB.user.id : '-');
Wellness.state = () => {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(Wellness.stateKey()) || 'null'); } catch (e) { /* تخزين غير متاح */ }
  if (!s || typeof s !== 'object') s = {};
  s.fired = s.fired && typeof s.fired === 'object' ? s.fired : {};
  s.last = s.last && typeof s.last === 'object' ? s.last : {};
  s.pausedUntil = Number(s.pausedUntil) || 0;
  return s;
};
Wellness.saveState = (s) => {
  const cut = Date.now() - 2 * 86400000;
  for (const [k, t] of Object.entries(s.fired)) if (t < cut) delete s.fired[k];
  try { localStorage.setItem(Wellness.stateKey(), JSON.stringify(s)); } catch (e) { /* */ }
};
Wellness.pause = (ms) => { const s = Wellness.state(); s.pausedUntil = ms ? Date.now() + ms : 0; Wellness.saveState(s); };

/* ===== الصوت: نغمة خفيفة تُصنع داخل المتصفح (بدون ملفات) ===== */
Wellness.audio = null;
Wellness.chime = (kind) => {
  const pr = Wellness.prefs;
  if (!pr || pr.sound === 'none') return;
  try {
    Wellness.audio = Wellness.audio || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = Wellness.audio;
    if (ctx.state === 'suspended') ctx.resume();
    // الأذان: ثلاث نغمات صاعدة؛ غيره: نغمتان هادئتان
    const notes = kind === 'adhan' ? [523.25, 659.25, 783.99] : [659.25, 880];
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.22;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.95);
    });
  } catch (e) { /* المتصفح يمنع الصوت قبل أول ضغطة: التنبيه يظهر بدون صوت */ }
};
// المتصفح يسمح بالصوت بعد أول تفاعل: نجهّز الصوت مع أول ضغطة
window.addEventListener('pointerdown', () => {
  try { if (!Wellness.audio) Wellness.audio = new (window.AudioContext || window.webkitAudioContext)(); if (Wellness.audio.state === 'suspended') Wellness.audio.resume(); } catch (e) { /* */ }
}, { once: true, passive: true });

/* ===== التنبيه الزجاجي (فوق على اليمين، واحد في المرة) ===== */
Wellness.push = (n) => { Wellness.queue.push(n); if (!Wellness.showing) Wellness.showNext(); };
Wellness.showNext = () => {
  const n = Wellness.queue.shift();
  Wellness.showing = n || null;
  let box = document.querySelector('.well-box');
  if (!n) { if (box) box.remove(); return; }
  if (!box) { box = h('div', { class: 'well-box', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  let timer = null;
  const done = () => { clearTimeout(timer); Wellness.showNext(); };
  const snooze = (min) => () => { Wellness.snoozed.push({ at: Date.now() + min * 60000, n }); done(); };
  const card = h('div', { class: 'well' },
    h('div', { class: 'ic ' + (n.tone || '') }, U.icon(Wellness.ICONS[n.icon], 20)),
    h('div', { style: 'flex:1;min-width:0' },
      h('div', { class: 'tt' }, n.title),
      h('div', { class: 'ss' }, n.sub),
      (n.ok || n.snooze) ? h('div', { class: 'acts' },
        n.ok ? h('button', { type: 'button', class: 'btn primary sm', onClick: done }, n.ok) : null,
        n.snooze ? h('button', { type: 'button', class: 'btn sm', onClick: snooze(n.snooze) }, 'بعد ' + Wellness.mins(n.snooze)) : null) : null),
    h('button', { type: 'button', class: 'x', 'aria-label': 'إغلاق التنبيه', onClick: done }, '×'));
  U.fill(box, card);
  Wellness.chime(n.kind);
  timer = setTimeout(done, (n.stay || 60) * 1000);
};

/* ===== الجدولة ===== */
Wellness.prayerEvents = (pr, now) => {
  const out = [];
  for (const off of [0, 1]) {
    const r = Prayer.forDay(pr, now, off);
    if (!r) return out;
    const day = Prayer.dayKey(r.day);
    for (const k of Prayer.KEYS) {
      const s = pr.stages[k], at = r.times[k], name = Prayer.NAMES[k];
      const time = Prayer.fmtTime(at, r.place.tz);
      if (s.pre) out.push({ id: `${day}:${k}:pre`, at: at - s.preMin * 60000, kind: 'pre', icon: 'bell', tone: 'warm', stay: 30, title: `فاضل ${Wellness.mins(s.preMin)} على ${name}`, sub: 'احفظ اللي في إيدك واستعد' });
      if (s.adhan) out.push({ id: `${day}:${k}:adhan`, at, kind: 'adhan', icon: 'mosque', stay: 120, ok: 'حاضر', snooze: 5, title: 'قوم صلي يا بطل', sub: `أذان ${name} دلوقتي · ${time}` });
      if (s.iqama) {
        const lead = s.iqamaMin > 3 ? 2 : 0; // ننبّه قبل الإقامة بدقيقتين لو فيه وقت
        out.push({ id: `${day}:${k}:iqama`, at: at + (s.iqamaMin - lead) * 60000, kind: 'iqama', icon: 'people', stay: 60, title: lead ? `إقامة ${name} كمان دقيقتين` : `إقامة ${name} دلوقتي`, sub: 'إلحق الجماعة يا بطل' });
      }
    }
  }
  return out;
};

Wellness.BREAKS = {
  water: { icon: 'drop', title: 'إشرب كوباية مياه', sub: (m) => `بقالك ${Wellness.mins(m)} ما شربتش`, ok: 'شربت', snooze: 10 },
  move: { icon: 'walk', tone: 'warm', title: 'قوم فك رجليك شوية', sub: (m) => `قاعد بقالك ${Wellness.mins(m)}`, ok: 'قمت', snooze: 10 },
  eye: { icon: 'eye', tone: 'gray', title: 'ريّح عينك شوية', sub: () => 'بص لحاجة بعيدة 20 ثانية', ok: 'تمام' },
};

Wellness.tick = async () => {
  if (!DB.user) { Wellness.prefs = null; Wellness.userId = null; return; }
  let pr;
  try { pr = await Wellness.load(); } catch (e) { return; }
  if (!pr) return;
  const now = Date.now();
  const st = Wellness.state();
  let changed = false;
  const paused = st.pausedUntil > now;
  // المؤجل ("بعد 10 دقايق")
  for (const s of Wellness.snoozed.splice(0)) {
    if (s.at > now) Wellness.snoozed.push(s);
    else if (!paused) Wellness.push(s.n);
  }
  if (pr.prayer.on) {
    for (const ev of Wellness.prayerEvents(pr.prayer, now)) {
      if (st.fired[ev.id]) continue;
      // نافذة 3 دقائق: لو البرنامج اتفتح متأخر ما نطلعش تنبيه قديم
      if (now >= ev.at && now - ev.at < 3 * 60000) {
        st.fired[ev.id] = now; changed = true;
        if (!paused) Wellness.push(ev);
      } else if (now - ev.at >= 3 * 60000 && now - ev.at < 86400000) { st.fired[ev.id] = now; changed = true; }
    }
  }
  // المستخدم بعيد عن الجهاز أكثر من 5 دقائق: اعتبره قام واستراح، والعدّاد يبدأ من جديد
  const away = now - (App.lastActivity || now) > 5 * 60000;
  for (const [k, def] of Object.entries(Wellness.BREAKS)) {
    const c = pr[k];
    if (!c.on) continue;
    if (!st.last[k] || away) { st.last[k] = now; changed = true; continue; }
    if (now - st.last[k] >= c.min * 60000) {
      st.last[k] = now; changed = true;
      if (!paused) Wellness.push({ kind: k, icon: def.icon, tone: def.tone, title: def.title, sub: def.sub(c.min), ok: def.ok, snooze: def.snooze, stay: 90 });
    }
  }
  if (changed) Wellness.saveState(st);
};
setInterval(() => { Wellness.tick(); }, 15000);

/* ===== بطاقة الصلاة القادمة في القائمة الجانبية ===== */
Wellness.sideCard = () => {
  const box = h('div', { class: 'well-next', 'aria-live': 'off' });
  box.style.display = 'none';
  const paint = async () => {
    let pr;
    try { pr = await Wellness.load(); } catch (e) { return; }
    if (!pr || !pr.prayer.on) { box.style.display = 'none'; return; }
    const nx = Prayer.next(pr.prayer, Date.now());
    if (!nx) { box.style.display = 'none'; return; }
    const left = Math.max(0, Math.round((nx.at - Date.now()) / 60000));
    const leftTxt = left >= 60 ? `فاضل ${Math.floor(left / 60)} ساعة و${left % 60} دقيقة` : `فاضل ${Wellness.mins(left)}`;
    box.style.display = '';
    U.fill(box,
      h('div', { class: 'small', style: 'display:flex;gap:6px;align-items:center' }, U.icon(Wellness.ICONS.mosque, 14), 'الصلاة الجاية · ' + nx.place.label),
      h('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;margin-top:2px' }, h('b', null, Prayer.NAMES[nx.key]), h('b', null, Prayer.fmtTime(nx.at, nx.place.tz))),
      h('div', { class: 'small' }, leftTxt));
  };
  paint();
  clearInterval(Wellness._sideTimer);
  Wellness._sideTimer = setInterval(paint, 30000);
  return box;
};

/* ===== الإعدادات: الإعدادات ← حسابي ← تذكيرات الراحة ===== */
Wellness.settingsCard = async () => {
  const saved = await Wellness.load();
  const v = structuredClone(saved);
  const body = h('div', { class: 'card-body' });
  const sw = (checked, onChange, label) => {
    const inp = h('input', { type: 'checkbox', checked: !!checked, 'aria-label': label, onChange: (e) => onChange(e.target.checked) });
    return h('label', { class: 'sw' }, inp, h('span'));
  };
  const minIn = (val, lo, hi, onChange, label) => h('input', {
    class: 'input cell short', type: 'number', min: lo, max: hi, step: 1, value: val, 'aria-label': label,
    onChange: (e) => { const n = Math.round(Number(e.target.value)); onChange(Math.min(hi, Math.max(lo, n || lo))); draw(); },
  });
  const draw = () => {
    const p = v.prayer;
    const c = Prayer.COUNTRIES[p.country];
    const countrySel = U.select(Object.entries(Prayer.COUNTRIES).map(([id, x]) => ({ value: id, label: x.name })), p.country, (id) => {
      const nc = Prayer.COUNTRIES[id];
      Object.assign(p, { country: id, city: nc.cities[0][0], method: nc.method, lat: null, lng: null, tz: null });
      draw();
    }, { 'aria-label': 'الدولة', style: 'width:auto' });
    const citySel = U.select([...c.cities.map((x) => ({ value: x[0], label: x[1] })), { value: 'custom', label: 'مدينتي مش موجودة (إحداثيات)' }], p.city, (id) => {
      p.city = id;
      if (id === 'custom') { const pl = Prayer.place(Object.assign({}, p, { city: c.cities[0][0] })); Object.assign(p, { lat: pl.lat, lng: pl.lng, tz: pl.tz }); }
      else Object.assign(p, { lat: null, lng: null, tz: null });
      draw();
    }, { 'aria-label': 'المدينة', style: 'width:auto' });
    const methodSel = U.select(Object.entries(Prayer.METHODS).map(([id, x]) => ({ value: id, label: x.label })), p.method, (id) => { p.method = id; draw(); }, { 'aria-label': 'طريقة الحساب', style: 'width:auto' });
    const asrSel = U.select([{ value: 'std', label: 'شافعي (الجمهور)' }, { value: 'hanafi', label: 'حنفي' }], p.asr, (id) => { p.asr = id; draw(); }, { 'aria-label': 'حساب العصر', style: 'width:auto' });
    let custom = null;
    if (p.city === 'custom') {
      const zones = Prayer.zonesOf(p.country);
      const coord = (key, label) => h('input', { class: 'input cell', type: 'number', step: 'any', value: p[key], style: 'width:120px;direction:ltr', 'aria-label': label, onChange: (e) => { p[key] = Number(e.target.value); draw(); } });
      custom = h('div', { class: 'row', style: 'margin-top:8px' },
        h('span', { class: 'small muted' }, 'خط العرض'), coord('lat', 'خط العرض'),
        h('span', { class: 'small muted' }, 'خط الطول'), coord('lng', 'خط الطول'),
        zones.length > 1 ? U.select(zones.map((z) => ({ value: z, label: z })), p.tz, (z) => { p.tz = z; draw(); }, { 'aria-label': 'التوقيت', style: 'width:auto;direction:ltr' }) : null,
        h('span', { class: 'small muted' }, 'تلاقيها في خرائط جوجل: اضغط بالزرار اليمين على مكانك'));
    }
    // مواقيت النهارده للمكان المختار (معاينة قبل الحفظ)
    let today = null;
    try { today = Prayer.forDay(p, Date.now(), 0); } catch (e) { /* إحداثيات ناقصة */ }
    const validPlace = today && Prayer.KEYS.every((k) => isFinite(today.times[k]));
    const rows = Prayer.KEYS.map((k) => {
      const s = p.stages[k];
      return h('tr', null,
        h('td', null, h('b', null, Prayer.NAMES[k])),
        h('td', { style: 'white-space:nowrap' }, validPlace ? Prayer.fmtTime(today.times[k], today.place.tz) : '—'),
        h('td', null, h('div', { class: 'row' }, sw(s.pre, (x) => { s.pre = x; draw(); }, 'تنبيه قبل أذان ' + Prayer.NAMES[k]), minIn(s.preMin, 1, 60, (n) => { s.preMin = n; }, 'دقائق قبل أذان ' + Prayer.NAMES[k]), h('span', { class: 'small muted' }, 'د'))),
        h('td', null, sw(s.adhan, (x) => { s.adhan = x; draw(); }, 'تنبيه أذان ' + Prayer.NAMES[k])),
        h('td', null, h('div', { class: 'row' }, sw(s.iqama, (x) => { s.iqama = x; draw(); }, 'تنبيه إقامة ' + Prayer.NAMES[k]), minIn(s.iqamaMin, 1, 60, (n) => { s.iqamaMin = n; }, 'دقائق الإقامة بعد أذان ' + Prayer.NAMES[k]), h('span', { class: 'small muted' }, 'د'))));
    });
    const brk = (k, label, lo, hi) => h('div', { class: 'row', style: 'gap:8px' },
      sw(v[k].on, (x) => { v[k].on = x; draw(); }, label), h('span', null, label + ' كل'), minIn(v[k].min, lo, hi, (n) => { v[k].min = n; }, label + ' كل كام دقيقة'), h('span', { class: 'small muted' }, 'دقيقة'));
    const st = Wellness.state();
    const paused = st.pausedUntil > Date.now();
    U.fill(body,
      h('div', { class: 'row', style: 'justify-content:space-between' },
        h('div', null, h('div', { style: 'font-weight:700' }, 'مواقيت الصلاة'),
          h('div', { class: 'small muted' }, 'بتتحسب على جهازك من غير إنترنت، وبتظهر بتوقيت البلد اللي اخترتها. التنبيهات بتشتغل والبرنامج مفتوح بس.')),
        sw(p.on, (x) => { p.on = x; draw(); }, 'تشغيل مواقيت الصلاة')),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('span', { class: 'small muted' }, 'الدولة'), countrySel, h('span', { class: 'small muted' }, 'المدينة'), citySel,
        h('span', { class: 'small muted' }, 'طريقة الحساب'), methodSel, h('span', { class: 'small muted' }, 'العصر'), asrSel),
      custom,
      h('div', { class: 'table-wrap', style: 'margin-top:10px' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, h('th', null, 'الصلاة'), h('th', null, 'النهارده'), h('th', null, 'تنبيه قبل الأذان'), h('th', null, 'الأذان'), h('th', null, 'الإقامة بعد الأذان'))),
        h('tbody', null, rows))),
      h('div', { class: 'well-row', style: 'margin-top:12px' }, brk('water', 'إشرب مياه', 15, 240), brk('move', 'اتحرك', 15, 240), brk('eye', 'ريّح عينك', 10, 120)),
      h('div', { class: 'well-row', style: 'justify-content:space-between' },
        h('div', { class: 'row' },
          h('span', { class: 'small muted' }, 'الصوت'),
          U.select([{ value: 'chime', label: 'تنبيه خفيف' }, { value: 'none', label: 'من غير صوت' }], v.sound, (x) => { v.sound = x; }, { 'aria-label': 'الصوت', style: 'width:auto' }),
          h('button', { type: 'button', class: 'btn sm', onClick: () => { const old = Wellness.prefs; Wellness.prefs = Object.assign({}, old, { sound: 'chime' }); Wellness.chime('adhan'); Wellness.prefs = old; } }, 'جرّب الصوت'),
          h('button', { type: 'button', class: 'btn sm', onClick: () => Wellness.push({ kind: 'test', icon: 'mosque', title: 'قوم صلي يا بطل', sub: 'ده شكل التنبيه · تجربة', ok: 'حاضر', stay: 15 }) }, 'جرّب التنبيه')),
        h('div', { class: 'row' },
          paused ? h('span', { class: 'small muted' }, 'التنبيهات واقفة لحد ' + new Date(st.pausedUntil).toLocaleTimeString('ar-EG-u-nu-latn', { hour: 'numeric', minute: '2-digit' })) : null,
          h('button', { type: 'button', class: 'btn sm', onClick: () => { Wellness.pause(paused ? 0 : 3600000); draw(); U.toast(paused ? 'رجّعنا التنبيهات' : 'وقفنا كل التنبيهات ساعة', 'ok'); } }, paused ? 'رجّع التنبيهات' : 'إيقاف كل التنبيهات ساعة'))),
      h('div', { style: 'margin-top:12px' }, h('button', {
        type: 'button', class: 'btn primary', onClick: async () => {
          try { Object.assign(v, structuredClone(await Wellness.save(v))); } catch (e) { return U.toast(e.message, 'err'); }
          draw();
          U.toast('اتحفظت إعدادات التذكيرات', 'ok');
        },
      }, 'حفظ التذكيرات')));
  };
  draw();
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, 'تذكيرات الراحة'), h('span', { class: 'small muted' }, 'إعداداتك إنت بس، ومقفولة لحد ما تشغّلها')),
    body);
};
