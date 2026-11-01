/* أدوات عامة: بناء العناصر، التنسيق، تطبيع النصوص العربية، النوافذ والتنبيهات */
'use strict';

const U = {};

/* خانات كلمة المرور والمفاتيح: نعرضها كنص مُقنَّع بدل type=password، فلا يعرض المتصفح أبداً "حفظ كلمة المرور" ولا يملؤها تلقائياً */
U.MASK = typeof CSS !== 'undefined' && CSS.supports && CSS.supports('-webkit-text-security', 'disc');
U.h = function (tag, props, ...kids) {
  if (tag === 'input' && props && props.type === 'password' && U.MASK) {
    props = Object.assign({}, props, {
      type: 'text', class: ((props.class || '') + ' secret').trim(), autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off',
      'data-lpignore': 'true', 'data-1p-ignore': 'true', 'data-form-type': 'other',
      onCopy: (e) => e.preventDefault(), onCut: (e) => e.preventDefault(),
    });
  }
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (k === 'selected') el.selected = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
};
const h = U.h;

/* استبدال محتوى عنصر مع تجاهل القيم الفارغة */
U.fill = (el, ...kids) => {
  el.replaceChildren(...kids.flat(Infinity).filter((x) => x != null && x !== false));
  return el;
};

U.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
U.r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
U.fmt = (n) => (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
U.fmtQ = (n) => (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 3 });
U.num = (n) => h('span', { class: 'num' }, U.fmt(n));

U.MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
U.monthName = (ym) => {
  if (!ym) return '';
  const [y, m] = ym.split('-').map(Number);
  return U.MONTHS[m - 1] + ' ' + y;
};
U.monthFirst = (ym) => ym + '-01';
U.monthLast = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return ym + '-' + String(d).padStart(2, '0');
};
U.fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  // تواريخ الضرائب بتوقيت UTC: نعرضها بتوقيت القاهرة
  return d.toLocaleDateString('en-GB', { timeZone: 'Africa/Cairo' });
};
U.fmtDay = (ymd) => {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  return `${Number(d)}/${Number(m)}/${y}`;
};

/* تطبيع النص العربي للمقارنة */
U.norm = (s) => {
  if (s == null) return '';
  return String(s)
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/(\d)\s*([*x×])\s*(\d)/g, '$1x$3')
    .replace(/(\d)([^\d\s.,x])/g, '$1 $2')
    .replace(/([^\d\s.,x])(\d)/g, '$1 $2')
    .replace(/[^\p{L}\p{N}.x]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};
U.tokens = (s) => U.norm(s).split(' ').filter((t) => t && t !== 'ال' && t.length > 0).map((t) => (t.length > 3 && t.startsWith('ال') ? t.slice(2) : t));
U.bigrams = (s) => {
  const t = U.norm(s).replace(/ /g, '');
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
};
/* تشابه تقريبي بين اسمين (0..1) */
U.sim = (a, b) => {
  const ta = new Set(U.tokens(a)), tb = new Set(U.tokens(b));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const tok = (2 * common) / (ta.size + tb.size);
  const ga = U.bigrams(a), gb = U.bigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of ga.values()) na += v;
  for (const v of gb.values()) nb += v;
  for (const [g, v] of ga) if (gb.has(g)) inter += Math.min(v, gb.get(g));
  const big = na + nb ? (2 * inter) / (na + nb) : 0;
  // الأرقام (المقاسات) لازم تتطابق: لو مختلفة نخفض التشابه
  const na2 = (U.norm(a).match(/\d+(\.\d+)?/g) || []);
  const nb2 = (U.norm(b).match(/\d+(\.\d+)?/g) || []);
  let numPenalty = 1;
  if (na2.length && nb2.length) {
    const shared = na2.filter((n) => nb2.includes(n)).length;
    if (!shared) numPenalty = 0.6;
  }
  return Math.min(1, (0.55 * tok + 0.45 * big) * numPenalty);
};

/* ===== نوافذ وتنبيهات ===== */
U.toast = (msg, type) => {
  let box = document.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast ' + (type || '') }, msg);
  box.append(t);
  setTimeout(() => t.remove(), type === 'err' || type === 'warn' ? 9000 : 3500);
};

U.busy = (msg) => {
  const el = h('div', { class: 'busy', role: 'alert', 'aria-live': 'assertive' },
    h('div', { class: 'box' }, h('div', { class: 'spin', 'aria-hidden': 'true' }), h('div', { class: 'msg' }, msg || 'جاري التنفيذ...')));
  document.body.append(el);
  const set = (m) => { el.querySelector('.msg').textContent = m; };
  // رسائل إعادة المحاولة من الذكاء الاصطناعي تظهر في نفس النافذة
  if (window.AI) AI.onStatus = set;
  return {
    set,
    done: () => { el.remove(); if (window.AI && AI.onStatus === set) AI.onStatus = null; },
  };
};

/* نافذة عامة: ترجع Promise بقيمة الزر المضغوط */
/* نافذة عامة
 * minimizable: زر تصغير — النافذة تتحول لشريط صغير أسفل الشاشة ويمكن العمل في البرنامج ثم استعادتها
 * confirmClose: true أو دالة ترجع true/false — يطلب تأكيداً قبل الإغلاق بـ X أو Esc أو إلغاء */
U.modal = ({ title, body, actions, wide, onOpen, minimizable, confirmClose, closeMsg }) => new Promise((resolve) => {
  let chip = null;
  const close = (val) => { bg.remove(); if (chip) chip.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
  const needConfirm = () => (typeof confirmClose === 'function' ? !!confirmClose() : !!confirmClose);
  const tryClose = async (val) => {
    if (needConfirm()) {
      const ok = await U.confirm(closeMsg || 'هل تريد إغلاق النافذة؟ أي بيانات أو نتائج لم تُحفظ فيها ستُفقد.', 'إغلاق النافذة', true);
      if (!ok) return;
    }
    close(val);
  };
  const isTop = () => !bg.classList.contains('minimized') && [...document.querySelectorAll('.modal-bg:not(.minimized)')].pop() === bg;
  const onKey = (e) => { if (e.key === 'Escape' && isTop()) { e.stopPropagation(); tryClose(null); } };
  const minimize = () => {
    bg.classList.add('minimized');
    chip = h('button', { type: 'button', class: 'modal-chip', 'aria-label': 'استعادة نافذة ' + title, onClick: restore },
      U.icon('<path d="M4 14h16v6H4z"></path><path d="M8 10l4-4 4 4"></path>', 18), h('span', null, title), h('span', { class: 'small', style: 'opacity:.8' }, '— اضغط للعودة'));
    let dock = document.querySelector('.modal-dock');
    if (!dock) { dock = h('div', { class: 'modal-dock' }); document.body.append(dock); }
    dock.append(chip);
  };
  const restore = () => { bg.classList.remove('minimized'); if (chip) { chip.remove(); chip = null; } };
  const foot = h('div', { class: 'modal-foot' });
  for (const a of (actions || [{ label: 'إغلاق', value: null }])) {
    const isCancel = a.value === null || a.value === false;
    foot.append(h('button', {
      type: 'button', class: 'btn ' + (a.cls || ''),
      onClick: async () => {
        if (isCancel) return tryClose(a.value);
        if (a.validate) { const ok = await a.validate(); if (!ok) return; }
        close(a.value !== undefined ? a.value : a.label);
      },
    }, a.label));
  }
  const bg = h('div', { class: 'modal-bg' },
    h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'modal-head' }, h('h2', null, title),
        h('div', { class: 'row', style: 'gap:2px' },
          minimizable ? h('button', { type: 'button', class: 'x', title: 'تصغير', 'aria-label': 'تصغير النافذة', onClick: minimize }, '—') : null,
          h('button', { type: 'button', class: 'x', title: 'إغلاق', 'aria-label': 'إغلاق', onClick: () => tryClose(null) }, '×'))),
      h('div', { class: 'modal-body' }, body),
      foot));
  document.body.append(bg);
  document.addEventListener('keydown', onKey);
  if (onOpen) onOpen(close);
  const first = bg.querySelector('.modal-body input, .modal-body select, .modal-body textarea');
  if (first) setTimeout(() => first.focus(), 30);
});

U.confirm = async (msg, okLabel, danger) => {
  const r = await U.modal({
    title: 'تأكيد',
    body: h('p', { style: 'margin:0;line-height:1.8;white-space:pre-line' }, msg),
    actions: [{ label: okLabel || 'تأكيد', value: true, cls: danger ? 'danger' : 'primary' }, { label: 'إلغاء', value: false }],
  });
  return r === true;
};

U.alert = (title, msg) => U.modal({ title, body: h('p', { style: 'margin:0;line-height:1.8;white-space:pre-line' }, msg), actions: [{ label: 'حسناً', value: true, cls: 'primary' }] });

U.download = (filename, blob) => {
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};

U.readText = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file, 'utf-8'); });
U.readBuffer = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file); });
U.readDataURL = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });

U.b64 = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
U.unb64 = (str) => {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/* أيقونة SVG من نص ثابت داخل الكود */
U.icon = (paths, size, color) => {
  const span = h('span', { 'aria-hidden': 'true', style: 'display:inline-flex' });
  span.innerHTML = `<svg width="${size || 24}" height="${size || 24}" viewBox="0 0 24 24" fill="none" stroke="${color || 'currentColor'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return span;
};

/* قائمة منسدلة ديناميكية بالبحث
 * search(query) ترجع [{value, label, sub, right}] · onPick(value)
 * القائمة position: fixed حتى لا تُقص داخل الجداول القابلة للتمرير */
U.combo = ({ search, onPick, placeholder, ariaLabel, width }) => {
  const input = h('input', { class: 'input cell', placeholder: placeholder || 'ابحث...', 'aria-label': ariaLabel || placeholder, autocomplete: 'off', role: 'combobox', 'aria-expanded': 'false', style: `width:${width || 230}px` });
  const list = h('div', { class: 'combo-list', role: 'listbox' });
  let results = [], active = 0, open = false;
  const close = () => { if (!open) return; open = false; list.remove(); input.setAttribute('aria-expanded', 'false'); window.removeEventListener('scroll', onScroll, true); };
  const onScroll = (e) => { if (!list.contains(e.target)) close(); };
  const place = () => {
    const r = input.getBoundingClientRect();
    const w = Math.max(r.width, 380);
    list.style.top = Math.min(r.bottom + 4, window.innerHeight - 120) + 'px';
    list.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
    list.style.width = w + 'px';
    list.style.maxHeight = Math.max(160, window.innerHeight - r.bottom - 16) + 'px';
  };
  const pick = (v) => { close(); input.value = ''; onPick(v); };
  const render = () => {
    U.fill(list, results.length ? results.map((r, i) => h('button', {
      type: 'button', role: 'option', class: i === active ? 'active' : '', 'aria-selected': i === active ? 'true' : 'false',
      onMousedown: (e) => { e.preventDefault(); pick(r.value); },
    }, h('span', null, h('strong', null, r.label), r.sub ? h('span', { class: 'sub' }, '  ' + r.sub) : null), r.right ? h('span', { class: 'num' }, r.right) : null))
      : h('div', { class: 'muted small', style: 'padding:10px 12px' }, 'لا نتائج'));
    const a = list.querySelector('.active');
    if (a) a.scrollIntoView({ block: 'nearest' });
  };
  const refresh = () => {
    results = search(input.value) || [];
    active = 0;
    if (!open) { open = true; document.body.append(list); input.setAttribute('aria-expanded', 'true'); window.addEventListener('scroll', onScroll, true); }
    place(); render();
  };
  input.addEventListener('focus', refresh);
  input.addEventListener('input', refresh);
  input.addEventListener('blur', () => setTimeout(close, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) refresh(); active = Math.min(results.length - 1, active + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) pick(results[active].value); }
    else if (e.key === 'Escape') { close(); }
  });
  return input;
};

/* قائمة اختيار بسيطة */
U.select = (options, value, onChange, attrs) => {
  const sel = h('select', Object.assign({ class: 'input' }, attrs || {}, { onChange: (e) => onChange && onChange(e.target.value) }));
  for (const o of options) sel.append(h('option', { value: o.value, selected: String(o.value) === String(value) }, o.label));
  return sel;
};
