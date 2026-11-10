/* خادم محلي لبرنامج مطابقة فواتير الموردين (نسخة سطح المكتب)
 * - يعرض واجهة البرنامج على http://127.0.0.1:47231 (للجهاز نفسه فقط)
 * - كل الطلبات تتطلب "توكن وصول" سري محفوظ في ملف داخل ملف المستخدم على Windows (يقرؤه ملف التشغيل ويفتح به النافذة)
 * - /api/v2/*  : الواجهة الجديدة — الدخول والجلسات والصلاحيات والأسرار على الخادم (server/api2.js)
 * لا يحتاج أي مكتبات خارجية: Node.js فقط.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Store } = require('./server/store');
const { createApi2 } = require('./server/api2');

const ROOT = __dirname;
let VERSION = '0.0.0';
try { VERSION = String(JSON.parse(fs.readFileSync(path.join(__dirname, 'version.json'), 'utf8')).version || VERSION); } catch (e) { /* بدون ملف إصدار */ }
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (e) { /* افتراضي */ }
// خيارات سطر الأوامر (للاختبار): --port=  --data=  --token-file=  --max-upload-mb=
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3) || null;
const PORT = Number(arg('port') || config.port) || 47231;
const DATA_DIR = path.resolve(ROOT, arg('data') || config.dataDir || 'بيانات البرنامج');
const MAIN_FILE = path.join(DATA_DIR, 'einvoice-data.einv');
const DAILY_DIR = path.join(DATA_DIR, 'نسخ يومية');
const KEEP_DAILY = 366; // سنة كاملة
const IDLE_EXIT_MS = 15 * 60000; // يُغلق الخادم نفسه بعد 15 دقيقة بدون نافذة مفتوحة

/* ===== توكن الوصول =====
 * يُحفظ في %LOCALAPPDATA%\EInvoiceValidation\access-token (صلاحياته لمستخدم Windows نفسه) ويمكن تغيير مساره للاختبار. */
const TOKEN_FILE = path.resolve(arg('token-file') || process.env.EINVOICE_TOKEN_FILE || path.join(process.env.LOCALAPPDATA || os.homedir(), 'EInvoiceValidation', 'access-token'));
function loadToken() {
  try { const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); if (/^[0-9a-f]{64}$/.test(t)) return t; } catch (e) { /* ننشئ جديداً */ }
  const t = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t, { encoding: 'utf8', mode: 0o600 });
  return t;
}
const TOKEN = loadToken();
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
function parseCookies(h) {
  const o = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return o;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

/* ===== رؤوس الأمان (CSP وغيرها) =====
 * script-src 'self' فقط: لا كود من الإنترنت ولا eval ولا سكربتات داخل الصفحة.
 * connect-src 'self': الواجهة لا تتصل إلا بهذا الخادم (الذكاء الاصطناعي والمنظومة يتصل بهما الخادم نفسه). */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com data:',
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');
const SEC_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

let lastSeen = Date.now();

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, SEC_HEADERS, extra || {}));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
const json = (res, status, body, extra, type) => send(res, status, body, type, extra);

function tooBig() { return Object.assign(new Error('الطلب أكبر من المسموح'), { status: 413 }); }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > limit) { failed = true; chunks.length = 0; req.resume(); reject(tooBig()); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/* ===== المخزن والواجهة الجديدة ===== */
const store = new Store({ file: MAIN_FILE, dailyDir: DAILY_DIR, keepDaily: KEEP_DAILY });
store.loadSync();
if (store.corrupt) console.error('تحذير: ملف البيانات لا يمكن قراءته ولن يُكتب فوقه: ' + store.corrupt);
const api2 = createApi2({
  store, dataDir: DATA_DIR, json, readBody, version: VERSION,
  openFolder: (dir) => { if (process.platform === 'win32' && !process.env.EINVOICE_NO_OPEN) execFile('explorer.exe', [dir]); },
});

const DENIED_PAGE = '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>غير مصرح</title>'
  + '<body style="font-family:Tahoma,sans-serif;padding:40px;line-height:2"><h2>غير مصرح بالدخول</h2>'
  + '<p>افتح البرنامج من أيقونة "مطابقة فواتير الموردين" على سطح المكتب.</p></body></html>';

/* ===== الخادم ===== */
const server = http.createServer(async (req, res) => {
  // حماية: لا يُقبل إلا من الجهاز نفسه وبعنوان البرنامج فقط (يمنع DNS-rebinding)
  const host = (req.headers.host || '').toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(res, 403, { error: 'forbidden host' });
  const url = new URL(req.url, `http://${host}`);
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { return send(res, 400, { error: 'bad request' }); }

  // دخول أول مرة بالتوكن (من ملف التشغيل): نحفظه في كوكي HttpOnly ثم نعيد التوجيه للصفحة بدونه
  if (p === '/' && url.searchParams.has('t')) {
    if (!safeEq(url.searchParams.get('t'), TOKEN)) return send(res, 403, DENIED_PAGE, 'text/html; charset=utf-8');
    return send(res, 302, '', 'text/plain', { Location: '/', 'Set-Cookie': `einv=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
  }
  // كل ما عدا ذلك يحتاج التوكن (كوكي، أو ترويسة لملف التشغيل)
  const authed = safeEq(parseCookies(req.headers.cookie).einv, TOKEN) || safeEq(req.headers['x-einvoice-token'], TOKEN);
  if (!authed) return send(res, 403, p.startsWith('/api/') ? { error: 'forbidden' } : DENIED_PAGE, p.startsWith('/api/') ? undefined : 'text/html; charset=utf-8');
  lastSeen = Date.now();

  if (p.startsWith('/api/')) {
    // طبقات إضافية: ترويسة التطبيق (تمنع طلبات المواقع الأخرى بسبب CORS)، وOrigin، وSec-Fetch-Site
    if (req.headers['x-einvoice-app'] !== '1') return send(res, 403, { error: 'forbidden' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return send(res, 403, { error: 'forbidden origin' });
    const sfs = req.headers['sec-fetch-site'];
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') return send(res, 403, { error: 'forbidden site' });

    if (p.startsWith('/api/v2/')) return api2.handle(req, res, p);

    return send(res, 404, { error: 'not found' });
  }

  // الملفات الثابتة (الواجهة فقط)
  let rel = p === '/' ? '/index.html' : p;
  // صفحة اختبارات الواجهة تُقدَّم فقط لو شُغّل الخادم لاختبار (متغير بيئة)، وبأسمائها فقط
  const testUi = process.env.EINVOICE_TEST_UI === '1' && (rel === '/tests/ui-tests.html' || rel === '/tests/ui-tests.js');
  if (!testUi && !/^\/(index\.html|app\/.+|favicon\.ico)$/.test(rel)) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  const file = path.normalize(path.join(ROOT, rel));
  const appDir = path.join(ROOT, 'app') + path.sep;
  if (rel.includes('..') || (!testUi && !file.startsWith(appDir) && file !== path.join(ROOT, 'index.html') && file !== path.join(ROOT, 'favicon.ico'))) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' }, SEC_HEADERS));
    res.end(data);
  } catch (e) { send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
});

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    // نسخة أخرى من البرنامج تعمل بالفعل: لا داعي لتشغيل خادم ثانٍ
    console.log('البرنامج يعمل بالفعل على المنفذ ' + PORT);
    process.exit(0);
  }
  console.error(e);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`مطابقة فواتير الموردين يعمل على http://127.0.0.1:${PORT}`);
  console.log('مجلد البيانات: ' + DATA_DIR);
});

const quit = () => { store.flush().catch(() => {}).finally(() => process.exit(0)); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
// إغلاق تلقائي عند عدم وجود نافذة مفتوحة (النافذة ترسل نبضة كل دقيقة)
setInterval(() => { if (Date.now() - lastSeen > IDLE_EXIT_MS) quit(); }, 60000);
