/* سياسة كلمة المرور واسم المستخدم والصلاحيات — نفس قواعد الواجهة (db.js) لكن تُفرض على الخادم.
 * اختبار tests/server-v2.test.js يتأكد من تطابقها مع قواعد الواجهة. */
'use strict';

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const COMMON = new Set(['12345678', '123456789', '1234567890', '12341234', '87654321', 'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'qwerty123', 'qwertyuiop1', 'qwerty1234', 'abcd1234', 'abc12345', 'abc123456', 'a1234567', 'aa123456', 'admin123', 'admin1234', 'admin12345', 'letmein123', 'welcome123', 'iloveyou1', 'pass1234', 'test1234', 'user1234', 'default123', 'changeme1']);

function passwordIssue(p) {
  if (typeof p !== 'string') return 'كلمة المرور غير صالحة';
  if (p.length < PASSWORD_MIN) return `كلمة المرور ${PASSWORD_MIN} خانات على الأقل، وفيها حرف ورقم`;
  if (p.length > PASSWORD_MAX) return `كلمة المرور أطول من ${PASSWORD_MAX} خانة`;
  if (!/\p{L}/u.test(p) || !/\p{N}/u.test(p)) return 'كلمة المرور لازم تحتوي على حرف ورقم على الأقل';
  if (COMMON.has(p.toLowerCase())) return 'كلمة المرور شائعة وسهلة التخمين، اختر غيرها';
  return '';
}

function usernameIssue(u) {
  if (typeof u !== 'string') return 'اسم الدخول غير صالح';
  const t = u.trim();
  if (!t) return 'أدخل اسم الدخول';
  if (t.length > 50) return 'اسم الدخول أطول من 50 خانة';
  if (!/^[\p{L}\p{N}._@\- ]+$/u.test(t)) return 'اسم الدخول يقبل حروفاً وأرقاماً ونقطة وشرطة فقط';
  return '';
}

/* صلاحية منفصلة لكل بند في البرنامج */
const PERM_KEYS = [
  'envelopes',       // مراجعة الأظرف: فتح ظرف، إضافة فواتير، المطابقة، المستلم، توزيع المطاعم
  'approve',         // اعتماد الأظرف وإعادة فتحها
  'envDelete',       // حذف الأظرف قيد المراجعة
  'cn',              // متابعة الإشعارات الدائنة والسداد
  'reports',         // التقارير ولوحة استهلاك المطاعم
  'quotes',          // رفع وتعديل واعتماد عروض الأسعار
  'mappings',        // ذاكرة ربط الأصناف
  'settingsAi',      // إعدادات الذكاء الاصطناعي
  'settingsEta',     // ربط منظومة الضرائب
  'settingsGeneral', // أنواع التوريد والمطاعم والإعدادات العامة
  'users',           // إدارة المستخدمين
  'logs',            // سجل الدخول وسجل النشاط
  'backup',          // النسخ الاحتياطي ومجلد البيانات
];
/* الحسابات القديمة (5 صلاحيات): كل صلاحية قديمة تمنح البنود التي كانت تشملها، إلى أن يحفظ المدير الحساب بالصلاحيات الجديدة */
const LEGACY = {
  envDelete: 'envelopes', cn: 'envelopes', reports: 'envelopes',
  mappings: 'settings', settingsAi: 'settings', settingsEta: 'settings', settingsGeneral: 'settings',
  logs: 'users', backup: 'users',
};
const ROLES = ['admin', 'auditor'];
const cleanPerms = (p) => {
  const ok = (k) => !!(p && typeof p === 'object' && p[k] === true);
  return Object.fromEntries(PERM_KEYS.map((k) => [k, ok(k) || (!!p && typeof p === 'object' && p[k] === undefined && !!LEGACY[k] && ok(LEGACY[k]))]));
};
const allPerms = () => Object.fromEntries(PERM_KEYS.map((k) => [k, true]));

module.exports = { PASSWORD_MIN, PASSWORD_MAX, COMMON, passwordIssue, usernameIssue, PERM_KEYS, ROLES, cleanPerms, allPerms };
