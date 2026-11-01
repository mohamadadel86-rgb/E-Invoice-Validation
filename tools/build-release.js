/* يبني حزمة توزيع نظيفة من البرنامج (بدون أي بيانات شخصية) في dist/
 *   node tools/build-release.js
 * - قائمة بيضاء: ينسخ ملفات البرنامج المذكورة فقط (لا بيانات، لا نسخ احتياطية، لا اختبارات، لا APIs.txt، لا تقارير داخلية).
 * - يفحص الناتج: ممنوع أي ملف بيانات/مفاتيح، وممنوع أي مسار أو اسم شخصي داخل الأكواد. لو وُجد شيء يفشل البناء.
 * - يضغط الناتج، ثم يشغّل النسخة المبنية فعلياً من مجلد جديد ويجرّب إعداداً أولاً ودخولاً (اختبار قبول).
 * لا يغيّر أي ملف في مجلد المشروع، ولا يلمس مجلد البيانات. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;
const NAME = 'EInvoiceValidation';
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, `${NAME}-${VERSION}`, NAME);
const ZIP = path.join(DIST, `${NAME}-${VERSION}.zip`);

const fail = (m) => { console.error('✖ فشل البناء: ' + m); process.exit(1); };
const log = (m) => console.log(m);

/* ===== قائمة بيضاء: (مصدر في المشروع) → (مسار في الحزمة) ===== */
const FILES = [
  ['server.js', 'server.js'], ['version.json', 'version.json'], ['index.html', 'index.html'], ['favicon.ico', 'favicon.ico'],
  ['Start-EInvoice.vbs', 'Start-EInvoice.vbs'],
  ['tools/release/Install-Shortcut.vbs', 'Install-Shortcut.vbs'],
  ['tools/release/config.json', 'config.json'],
  ['tools/release/دليل الاستخدام.md', 'دليل الاستخدام.md'],
];
const DIRS = [['server', 'server'], ['app', 'app'], ['runtime', 'runtime']];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else if (e.isFile()) fs.copyFileSync(s, d);
  }
}
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out); else out.push(path.relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

/* ===== 1) النسخ ===== */
fs.rmSync(path.join(DIST, `${NAME}-${VERSION}`), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [s, d] of FILES) {
  const src = path.join(ROOT, s);
  if (!fs.existsSync(src)) fail('ملف ناقص: ' + s);
  fs.mkdirSync(path.dirname(path.join(OUT, d)), { recursive: true });
  fs.copyFileSync(src, path.join(OUT, d));
}
for (const [s, d] of DIRS) {
  if (!fs.existsSync(path.join(ROOT, s))) fail('مجلد ناقص: ' + s + (s === 'runtime' ? ' (نسخة node.exe المحمولة)' : ''));
  copyDir(path.join(ROOT, s), path.join(OUT, d));
}
const files = walk(OUT);
log(`✔ نُسخ ${files.length} ملف`);

/* ===== 2) فحص التسرب ===== */
const bannedName = [/\.einv$/i, /(^|\/)APIs/i, /access-token/i, /\.login-lock/i, /(^|\/)tests?\//i, /(^|\/)\.claude\//, /\.lnk$/i, /(^|\/)نسخ/, /(^|\/)بيانات البرنامج/, /تقرير الفحص/, /(^|\/)\.env/i, /\.pem$|\.key$/i, /(^|\/)dist\//];
const bad = [];
for (const f of files) if (bannedName.some((re) => re.test(f))) bad.push('اسم ممنوع: ' + f);
const TEXT = /\.(js|json|html|css|md|txt|vbs|svg)$/i;
// أنماط شخصية تُفحص داخل الأكواد (ما عدا المكتبات الجاهزة)
const personal = [/C:\\Users\\[^\\"'\s]+/i, /مورد-تجربة/, /Mgr-Admin2026|Audit-2222x/, /SECRET-KEY-123|ETA-SECRET-XYZ/];
// أنماط خاصة بصاحب الجهاز (أسماء، مسارات، أرقام ضريبية) في ملف محلي لا يُرفع للمستودع: مصفوفة نصوص regex
const LOCAL_PATTERNS = path.join(__dirname, 'personal-patterns.local.json');
if (fs.existsSync(LOCAL_PATTERNS)) for (const src of JSON.parse(fs.readFileSync(LOCAL_PATTERNS, 'utf8'))) personal.push(new RegExp(src, 'i'));
const allowedWinPaths = /C:\\Users\\Public/i;
for (const f of files) {
  if (!TEXT.test(f) || f.startsWith('app/vendor/') || f.startsWith('runtime/')) continue;
  const raw = fs.readFileSync(path.join(OUT, f));
  const text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8');
  for (const re of personal) {
    const m = text.match(re);
    if (m && !allowedWinPaths.test(m[0])) bad.push(`نص شخصي في ${f}: ${m[0]}`);
  }
}
// حجم غير متوقع (ملف بيانات متخفٍّ باسم آخر)
for (const f of files) { const sz = fs.statSync(path.join(OUT, f)).size; if (sz > 5 * 1024 * 1024 && !f.startsWith('runtime/')) bad.push(`ملف كبير غير متوقع: ${f} (${(sz / 1048576).toFixed(1)}MB)`); }
if (!fs.existsSync(path.join(OUT, 'runtime', 'node.exe'))) bad.push('runtime/node.exe ناقص');
if (bad.length) { console.error(bad.map((b) => '  - ' + b).join('\n')); fail('فحص التسرب وجد ' + bad.length + ' مشكلة (لم يُنشأ ملف zip)'); }
log('✔ فحص التسرب: لا بيانات ولا مفاتيح ولا أسماء شخصية');

/* ===== 3) الضغط =====
 * كاتب zip بسيط (deflate + أسماء UTF-8): أدوات tar على ويندوز تُفسد الأسماء العربية داخل الملف. */
function crc32(buf) { if (zlib.crc32) return zlib.crc32(buf) >>> 0; let c, crc = 0xffffffff; for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function writeZip(zipPath, rootDir, topName) {
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const rel of walk(rootDir).sort()) {
    const data = fs.readFileSync(path.join(rootDir, rel));
    const name = Buffer.from(topName + '/' + rel, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = comp.length < data.length;
    const body = useDeflate ? comp : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(useDeflate ? 8 : 0, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(useDeflate ? 8 : 0, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...parts, cd, end]));
}
fs.rmSync(ZIP, { force: true });
writeZip(ZIP, OUT, NAME);
const zipSize = fs.statSync(ZIP).size;
log(`✔ ${path.basename(ZIP)}  ${(zipSize / 1048576).toFixed(1)}MB`);

/* ===== 4) قائمة الملفات والبصمات ===== */
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = { name: NAME, version: VERSION, builtAt: new Date().toISOString(), zipSha256: sha(ZIP), files: Object.fromEntries(files.map((f) => [f, sha(path.join(OUT, f))])) };
fs.writeFileSync(path.join(DIST, `${NAME}-${VERSION}.manifest.json`), JSON.stringify(manifest, null, 1));

/* ===== 5) اختبار قبول: تشغيل النسخة المبنية فعلياً من مجلد جديد ===== */
const get = (port, p, headers) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, text: b })); }); r.on('error', reject); r.end(); });
const post = (port, p, body, headers) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, agent: false }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, text: b, headers: res.headers })); }); r.on('error', reject); r.end(JSON.stringify(body)); });
(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'einv-accept-'));
  const unz = path.join(work, 'unzipped');
  fs.mkdirSync(unz);
  // الفك بنفس طريقة المستلم على ويندوز (Windows PowerShell)
  const x = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${unz}' -Force`], { encoding: 'utf8' });
  if (x.status !== 0) fail('فك الضغط للاختبار فشل: ' + x.stderr);
  const app = path.join(unz, NAME);
  if (!fs.existsSync(path.join(app, 'دليل الاستخدام.md'))) fail('اسم الملف العربي لم يُحفظ سليماً داخل الـ zip');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dataDir = path.join(work, 'data'), tokenFile = path.join(work, 'token');
  const node = path.join(app, 'runtime', 'node.exe');
  const child = spawn(node, [path.join(app, 'server.js'), `--port=${port}`, `--data=${dataDir}`, `--token-file=${tokenFile}`], { cwd: app, stdio: 'ignore', env: { ...process.env, PATH: path.join(process.env.SystemRoot || 'C:/Windows', 'System32'), EINVOICE_NO_IPLOOKUP: '1' } });
  const stop = () => { try { child.kill(); } catch (e) { /* */ } try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* */ } };
  try {
    let up = false;
    for (let i = 0; i < 80 && !up; i++) { await new Promise((r) => setTimeout(r, 150)); try { await get(port, '/'); up = true; } catch (e) { /* */ } }
    if (!up) fail('النسخة المبنية لم تعمل (runtime/node.exe)');
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    const H = { 'X-EInvoice-App': '1', 'X-EInvoice-Token': token };
    const st = JSON.parse((await get(port, '/api/v2/status', H)).text);
    if (st.version !== VERSION || !st.needsSetup) fail('حالة غير متوقعة: ' + JSON.stringify(st));
    const su = await post(port, '/api/v2/setup', { username: 'admin', displayName: 'اختبار', password: 'Accept-Test-2026' }, H);
    if (su.status !== 200) fail('الإعداد الأول فشل: ' + su.text);
    const idx = await get(port, '/', { 'X-EInvoice-Token': token });
    if (idx.status !== 200 || !idx.text.includes('app/js/app.js')) fail('الصفحة الرئيسية لا تُقدَّم');
    for (const bannedPath of ['/server.js', '/server/api2.js', '/tests/ui-tests.js', '/version.json']) if ((await get(port, bannedPath, { 'X-EInvoice-Token': token })).status !== 404) fail('مسار يجب ألا يُقدَّم: ' + bannedPath);
    if (fs.readdirSync(app).some((n) => /einv|بيانات/.test(n))) fail('الخادم كتب بيانات داخل مجلد البرنامج');
    if (!fs.existsSync(path.join(dataDir, 'einvoice-data.einv'))) fail('لم يُكتب ملف البيانات في المجلد المحدد');
    log('✔ اختبار قبول: النسخة المبنية تعمل من مجلد جديد وبدون Node.js على الجهاز (إعداد أول + صفحة + حجب الملفات + البيانات خارج البرنامج)');
  } finally { stop(); }
  console.log(`\nالناتج: ${ZIP}\nالإصدار: ${VERSION}`);
})().catch((e) => fail(e.stack || e.message));
