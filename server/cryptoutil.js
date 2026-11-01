/* تشفير متوافق 100% مع صيغة ملف البيانات التي يكتبها المتصفح (WebCrypto):
 * - المفتاح الرئيسي 32 بايت عشوائي، يُغلَّف بكلمة مرور كل مستخدم: PBKDF2-SHA256 (310,000 دورة) ثم AES-256-GCM
 * - كل مجموعة بيانات: AES-256-GCM بالمفتاح الرئيسي، IV عشوائي 12 بايت، والناتج = ciphertext + وسم 16 بايت (Base64)
 * تم التحقق من التوافق في الاتجاهين (انظر tests/server-v2.test.js). */
'use strict';

const crypto = require('crypto');

const ITER = 310000;
const MIN_ITER = 100000;
const MAX_ITER = 5000000; // حد أقصى حتى لا يستنزف ملف مخرّب الجهاز

const b64 = (s) => Buffer.from(String(s), 'base64');

function pbkdf2(password, salt, iter) {
  return new Promise((resolve, reject) => crypto.pbkdf2(Buffer.from(password, 'utf8'), salt, iter, 32, 'sha256', (e, k) => (e ? reject(e) : resolve(k))));
}

function gcmEncrypt(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}

function gcmDecrypt(key, box) {
  const ct = b64(box.ct);
  if (ct.length < 16) throw new Error('صندوق تشفير غير صالح');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b64(box.iv));
  d.setAuthTag(ct.subarray(ct.length - 16));
  return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
}

/* يغلّف المفتاح الرئيسي بكلمة مرور */
async function wrapMaster(password, master) {
  const salt = crypto.randomBytes(16);
  const kek = await pbkdf2(password, salt, ITER);
  const box = gcmEncrypt(kek, master);
  return { salt: salt.toString('base64'), iter: ITER, iv: box.iv, ct: box.ct };
}

/* يفك المفتاح الرئيسي بكلمة المرور؛ يرجع null لو الكلمة خطأ */
async function unwrapMaster(password, wrap) {
  try {
    const iter = Number(wrap.iter);
    if (!Number.isInteger(iter) || iter < MIN_ITER || iter > MAX_ITER) return null;
    const kek = await pbkdf2(password, b64(wrap.salt), iter);
    const m = gcmDecrypt(kek, wrap);
    return m.length === 32 ? m : null;
  } catch (e) { return null; }
}

/* حساب وهمي يستهلك نفس الوقت (لاسم مستخدم غير موجود) فلا يمكن اكتشاف الأسماء الموجودة من زمن الرد */
const DUMMY_SALT = crypto.randomBytes(16);
const dummyWork = (password) => pbkdf2(String(password || ''), DUMMY_SALT, ITER).then(() => null);

const encryptJSON = (master, obj) => gcmEncrypt(master, Buffer.from(JSON.stringify(obj), 'utf8'));
const decryptJSON = (master, box) => JSON.parse(gcmDecrypt(master, box).toString('utf8'));

module.exports = { ITER, wrapMaster, unwrapMaster, dummyWork, encryptJSON, decryptJSON };
