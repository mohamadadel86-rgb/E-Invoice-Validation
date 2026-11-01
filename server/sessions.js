/* جلسات المستخدمين على الخادم.
 * - معرّف الجلسة 256 بت عشوائي في كوكي HttpOnly + SameSite=Strict (لا يراه كود الصفحة).
 * - معرّف جديد عند كل دخول (يمنع Session Fixation)، ويُلغى القديم.
 * - انتهاء الجلسة بعد مدة خمول (تُفرض على الخادم، لا على المتصفح).
 * - الصلاحيات تُقرأ من الخادم عند كل طلب (لا يحملها المتصفح). */
'use strict';

const crypto = require('crypto');

class Sessions {
  constructor({ idleMs, onEnd, onEmpty }) {
    this.map = new Map();
    this.idleMs = idleMs;   // دالة ترجع مدة الخمول بالملي ثانية
    this.onEnd = onEnd || (() => {});
    this.onEmpty = onEmpty || (() => {});
  }

  create(user, meta = {}) {
    const id = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.map.set(id, { id, userId: user.id, username: user.username, createdAt: now, lastSeen: now, ...meta });
    return this.map.get(id);
  }

  get(id) {
    if (typeof id !== 'string') return null;
    const s = this.map.get(id);
    if (!s) return null;
    if (Date.now() - s.lastSeen > this.idleMs()) { this.destroy(id, 'خروج تلقائي لعدم النشاط'); return null; }
    s.lastSeen = Date.now();
    return s;
  }

  destroy(id, reason) {
    const s = this.map.get(id);
    if (!s) return;
    this.map.delete(id);
    this.onEnd(s, reason || 'تسجيل خروج');
    if (!this.map.size) this.onEmpty();
  }

  destroyUser(userId, exceptId, reason) {
    for (const [id, s] of [...this.map]) if (s.userId === userId && id !== exceptId) this.destroy(id, reason || 'تغيير بيانات الحساب');
  }

  destroyAll(reason) {
    for (const id of [...this.map.keys()]) this.destroy(id, reason);
  }

  sweep() {
    const idle = this.idleMs();
    const now = Date.now();
    for (const [id, s] of [...this.map]) if (now - s.lastSeen > idle) this.destroy(id, 'خروج تلقائي لعدم النشاط');
  }

  get size() { return this.map.size; }
}

module.exports = { Sessions };
