/* مخزن البيانات على الخادم.
 * - يقرأ ويكتب ملف einvoice-data.einv بنفس صيغة المتصفح (format: einvoice-validation-backup v1)، فلا تحويل ولا فقد، ويمكن الرجوع للنسخة القديمة.
 * - مجموعات البيانات ("c:...") والصور ("img:...") مشفرة بالمفتاح الرئيسي. سجل الدخول (auditlog) غير مشفر كما كان.
 * - المفتاح الرئيسي يُفك بكلمة مرور مستخدم عند الدخول، ويبقى في ذاكرة الخادم فقط طالما فيه جلسة، ثم يُمسح.
 * - الكتابة ذرّية (ملف مؤقت ثم إعادة تسمية) + نسخة يومية بدون صور تُحفظ سنة. */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const C = require('./cryptoutil');

const FORMAT = 'einvoice-validation-backup';
const LOG_MAX = 5000;

function parseBackup(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw Object.assign(new Error('الملف ليس نسخة احتياطية صالحة'), { status: 400 }); }
  if (!obj || obj.format !== FORMAT || !obj.data || typeof obj.data !== 'object' || !Array.isArray(obj.data.users) || !obj.data.users.length) {
    throw Object.assign(new Error('الملف ليس نسخة احتياطية من هذا البرنامج'), { status: 400 });
  }
  for (const u of obj.data.users) {
    if (!u || typeof u.id !== 'string' || typeof u.username !== 'string' || !u.wrap || typeof u.wrap.salt !== 'string' || typeof u.wrap.iv !== 'string' || typeof u.wrap.ct !== 'string') {
      throw Object.assign(new Error('بيانات المستخدمين في الملف غير صالحة'), { status: 400 });
    }
  }
  return obj;
}

class Store {
  constructor({ file, dailyDir, keepDaily = 366 }) {
    this.file = file;
    this.dailyDir = dailyDir;
    this.keepDaily = keepDaily;
    this.data = { users: [], meta: null };
    this.master = null;
    this.cols = new Map();
    this.revs = new Map();
    this.mtime = null;
    this.corrupt = '';
    this.lastDaily = 0;
    this.mirrorDir = '';      // مكان ثانٍ للنسخ (فلاشة/OneDrive) — اختياري
    this.mirror = { at: 0, error: '' };
    this._mirrorDaily = '';
    this.dirty = false; // فيه تعديلات في الذاكرة لم تُكتب بعد
    this._ver = 0;
    this._seq = 0;
    this._written = 0;
    this._q = Promise.resolve();
    this._timer = null;
  }

  /* ===== القراءة ===== */
  _statMtime() { try { return fs.statSync(this.file).mtimeMs; } catch (e) { return null; } }

  loadSync() {
    this.cols.clear(); this.revs.clear(); this.corrupt = '';
    if (!fs.existsSync(this.file)) { this.data = { users: [], meta: null }; this.mtime = null; return; }
    try {
      const obj = parseBackup(fs.readFileSync(this.file, 'utf8'));
      this.data = obj.data;
    } catch (e) {
      // لا نكتب فوق ملف لا نفهمه أبداً
      this.corrupt = e.message;
      this.data = { users: [], meta: null };
    }
    this.mtime = this._statMtime();
    this.dirty = false;
  }

  /* هل تغيّر الملف من خارج هذا الكيان (النسخة القديمة من الواجهة، أو استرجاع، أو نسخ يدوي)؟ */
  externalChanged() { return this._statMtime() !== this.mtime; }
  touch() { this.dirty = true; this._ver++; }

  hasUsers() { return this.data.users.length > 0; }
  findUser(username) {
    const t = String(username || '').trim().toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === t) || null;
  }
  findUserById(id) { return this.data.users.find((u) => u.id === id) || null; }

  /* ===== المفتاح الرئيسي ===== */
  setMaster(m) {
    if (this.master && this.master.equals(m)) return;
    this.lock();
    this.master = Buffer.from(m);
  }
  lock() {
    if (this.master) this.master.fill(0);
    this.master = null;
    this.cols.clear();
  }
  _need() { if (!this.master) throw Object.assign(new Error('الجلسة مقفلة'), { status: 401, code: 'locked' }); }

  /* ===== المجموعات المشفرة ===== */
  getCol(name, def) {
    this._need();
    if (!this.cols.has(name)) {
      const box = this.data['c:' + name];
      this.cols.set(name, box ? C.decryptJSON(this.master, box) : (def !== undefined ? def : null));
    }
    return structuredClone(this.cols.get(name));
  }
  rev(name) { return this.revs.get(name) || 1; }
  setCol(name, value) {
    this._need();
    this.data['c:' + name] = C.encryptJSON(this.master, value);
    this.cols.set(name, structuredClone(value));
    this.revs.set(name, this.rev(name) + 1);
    this.touch();
    return this.save();
  }

  /* ===== الصور ===== */
  getImg(key) { this._need(); const b = this.data[key]; return b ? C.decryptJSON(this.master, b) : null; }
  setImg(key, obj) { this._need(); this.data[key] = C.encryptJSON(this.master, obj); this.touch(); return this.save(); }
  delImg(key) { delete this.data[key]; this.touch(); return this.save(); }

  /* ===== سجل الدخول (غير مشفر، يكتبه الخادم فقط) ===== */
  log() { if (!Array.isArray(this.data.auditlog)) this.data.auditlog = []; return this.data.auditlog; }
  appendLog(entry) {
    const l = this.log();
    l.push(entry);
    if (l.length > LOG_MAX) l.splice(0, l.length - LOG_MAX);
    this.touch();
    this.scheduleSave();
  }
  updateLog(id, patch) {
    const l = this.log();
    for (let i = l.length - 1; i >= 0; i--) if (l[i].id === id) { Object.assign(l[i], patch); this.touch(); this.scheduleSave(); return true; }
    return false;
  }

  /* ===== الكتابة ===== */
  scheduleSave(ms = 400) {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { this.save().catch((e) => console.error('save', e.message)); }, ms);
    if (this._timer.unref) this._timer.unref();
  }
  flush() { clearTimeout(this._timer); return this.dirty ? this.save() : this._q; }

  save() {
    if (!this.dirty) return this._q; // لا نكتب شيئاً لم يتغيّر
    const my = ++this._seq;
    const p = this._q.then(async () => {
      if (this._written >= my) return; // كُتبت بالفعل ضمن كتابة أحدث
      const upto = this._seq;
      await this._write();
      this._written = upto;
    });
    this._q = p.catch(() => {});
    return p;
  }

  async _write() {
    if (this.corrupt) throw new Error('ملف البيانات تالف ولن يُكتب فوقه');
    // حماية من فقد البيانات: لو الملف اتغيّر من خارج هذه الذاكرة (النسخة القديمة/استرجاع/نسخ يدوي) لا نكتب فوقه أبداً
    if (this._statMtime() !== this.mtime) throw Object.assign(new Error('تغيّر ملف البيانات من خارج الخادم، ولن يُكتب فوقه'), { code: 'external-change' });
    const ver = this._ver;
    const obj = { format: FORMAT, version: 1, exportedAt: new Date().toISOString(), data: this.data };
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await this._atomic(this.file, JSON.stringify(obj));
    this.mtime = this._statMtime();
    if (this._ver === ver) this.dirty = false;
    await this._daily(obj);
    await this.mirrorNow(false);
  }

  /* كتابة ذرّية: ملف مؤقت ← تثبيت على القرص (fsync) ← إعادة تسمية. بدون fsync قد يترك انقطاع الكهرباء ملفاً فارغاً.
   * durable=false للنسخة في المكان الثاني (فلاشة بطيئة): تكفي إعادة التسمية */
  async _atomic(file, text, durable = true) {
    const tmp = file + '.tmp';
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(text, 'utf8');
      if (durable) await fh.sync();
    } finally { await fh.close(); }
    await fsp.rename(tmp, file);
  }

  /* نسخة يومية بدون صور صفحات عروض الأسعار، تُحدَّث كل 30 دقيقة على الأكثر، وتُحفظ سنة */
  async _daily(obj) {
    if (Date.now() - this.lastDaily < 30 * 60000) return;
    await fsp.mkdir(this.dailyDir, { recursive: true });
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
    const data = Object.fromEntries(Object.entries(obj.data).filter(([k]) => !k.startsWith('img:')));
    await this._atomic(path.join(this.dailyDir, `einvoice-${day}.einv`), JSON.stringify({ ...obj, data }));
    this.lastDaily = Date.now();
    const names = (await fsp.readdir(this.dailyDir)).filter((n) => /^einvoice-\d{4}-\d{2}-\d{2}\.einv$/.test(n)).sort();
    for (const n of names.slice(0, Math.max(0, names.length - this.keepDaily))) await fsp.unlink(path.join(this.dailyDir, n));
  }

  /* نسخة في مكان ثانٍ: الملف الرئيسي (كل دقيقة على الأكثر) + نسخة اليوم في "نسخ يومية". لا يوقف الحفظ أبداً لو فشل */
  async mirrorNow(force) {
    if (!this.mirrorDir) return;
    if (!force && Date.now() - this.mirror.at < 60000) return;
    try {
      await fsp.mkdir(this.mirrorDir, { recursive: true });
      const text = await fsp.readFile(this.file);
      await this._atomic(path.join(this.mirrorDir, 'einvoice-data.einv'), text, false);
      const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
      const daily = path.join(this.dailyDir, `einvoice-${day}.einv`);
      if (fs.existsSync(daily)) {
        const dd = path.join(this.mirrorDir, 'نسخ يومية');
        await fsp.mkdir(dd, { recursive: true });
        await fsp.copyFile(daily, path.join(dd, `einvoice-${day}.einv`));
        const names = (await fsp.readdir(dd)).filter((n) => /^einvoice-\d{4}-\d{2}-\d{2}\.einv$/.test(n)).sort();
        for (const n of names.slice(0, Math.max(0, names.length - this.keepDaily))) await fsp.unlink(path.join(dd, n));
      }
      this.mirror = { at: Date.now(), error: '' };
    } catch (e) {
      this.mirror = { at: this.mirror.at, error: e.message };
      console.error('mirror', e.message);
    }
  }

  /* كتابة نص ملف كامل (للنسخة القديمة من الواجهة ولاسترجاع النسخ الاحتياطية)؛ نُعلّم أن الذاكرة صارت قديمة */
  async writeRaw(text) {
    const obj = parseBackup(text);
    await this._q;
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await this._atomic(this.file, text);
    await this._daily(obj);
    await this.mirrorNow(true);
    this.mtime = undefined; // يجبر القراءة من جديد في أول طلب (تغيّر الملف من خارج الذاكرة)
    this.dirty = false;
  }

  /* نسخة أمان من الملف الحالي قبل أي استبدال */
  async safetyCopy(dir) {
    if (!fs.existsSync(this.file)) return null;
    await fsp.mkdir(dir, { recursive: true });
    const name = 'قبل-الاسترجاع-' + new Date().toISOString().replace(/[:.]/g, '-') + '.einv';
    await fsp.copyFile(this.file, path.join(dir, name));
    return name;
  }
}

module.exports = { Store, parseBackup, FORMAT };
