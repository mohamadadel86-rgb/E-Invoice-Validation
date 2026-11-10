/* اختبارات أمان الخادم المحلي (server.js) والمكتبات
 * التشغيل:  node --test tests/
 * كل اختبار يثبت أن ثغرة معينة (من "تقرير الفحص الأمني.md") مغلقة. لا يلمس بيانات المستخدم: يستعمل مجلدات مؤقتة.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, p, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({}, headers);
    if (host) h.Host = host;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/* خادم ضرائب وهمي: يقبل (cid, good) فقط ويعدّ طلبات التوكن */
function startMockEta() {
  const state = { tokenCalls: 0 };
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/connect/token') {
      state.tokenCalls++;
      const m = String(req.headers.authorization || '').match(/^Basic (.+)$/);
      const [id, secret] = m ? Buffer.from(m[1], 'base64').toString().split(':') : [];
      req.resume();
      if (id === 'cid' && secret === 'good') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ access_token: 'T-' + state.tokenCalls, token_type: 'Bearer', expires_in: 3600 })); }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_client' }));
    }
    if (req.url.startsWith('/api/v1.0/documents/search')) {
      const ok = /^Bearer T-/.test(String(req.headers.authorization || ''));
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ok ? { result: [], metadata: { continuationToken: 'EndofResultSet' } } : { error: 'unauthorized' }));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port })));
}

async function startApp(extraEnv = {}, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'einv-test-'));
  const tokenFile = path.join(dir, 'access-token');
  const dataDir = path.join(dir, 'data');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [process.env.TEST_SERVER_JS || path.join(ROOT, 'server.js'), `--port=${port}`, `--data=${dataDir}`, `--token-file=${tokenFile}`, ...extraArgs], {
    env: Object.assign({}, process.env, extraEnv), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(100); try { await request(port, 'GET', '/'); up = true; } catch (e) { /* لسه */ } }
  assert.ok(up, 'الخادم لم يبدأ');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const api = (method, p, o = {}) => request(port, method, p, Object.assign({}, o, { headers: Object.assign({ 'X-EInvoice-App': '1', 'X-EInvoice-Token': token }, o.headers || {}) }));
  return { port, dir, dataDir, token, api, stop: () => { child.kill(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ } } };
}

const validData = JSON.stringify({ format: 'einvoice-validation-backup', version: 1, exportedAt: new Date().toISOString(), data: { users: [{ id: 'u1', username: 'a', wrap: { salt: 'AA==', iter: 310000, iv: 'AA==', ct: 'AA==' } }] } });

test('F4: بدون توكن الوصول يُرفض كل شيء (الصفحة والـ API)', async () => {
  const app = await startApp();
  try {
    assert.equal((await request(app.port, 'GET', '/')).status, 403);
    assert.equal((await request(app.port, 'GET', '/app/js/db.js')).status, 403);
    assert.equal((await request(app.port, 'GET', '/api/v2/status', { headers: { 'X-EInvoice-App': '1' } })).status, 403);
    assert.equal((await request(app.port, 'POST', '/api/v2/restore', { headers: { 'X-EInvoice-App': '1' }, body: validData })).status, 403, 'الاسترجاع بدون توكن');
    assert.equal(fs.existsSync(path.join(app.dataDir, 'einvoice-data.einv')), false);
  } finally { app.stop(); }
});

test('F4: توكن خطأ يُرفض، والتوكن الصحيح يعطي كوكي HttpOnly + SameSite=Strict ويعيد التوجيه', async () => {
  const app = await startApp();
  try {
    assert.equal((await request(app.port, 'GET', '/?t=' + 'a'.repeat(64))).status, 403);
    assert.equal((await request(app.port, 'GET', '/?t=short')).status, 403);
    const r = await request(app.port, 'GET', '/?t=' + app.token);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/');
    const cookie = String(r.headers['set-cookie']);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const c = cookie.split(';')[0];
    assert.equal((await request(app.port, 'GET', '/', { headers: { Cookie: c } })).status, 200);
    assert.equal((await request(app.port, 'GET', '/api/v2/status', { headers: { Cookie: c, 'X-EInvoice-App': '1' } })).status, 200);
  } finally { app.stop(); }
});

test('F4: طبقات الحماية الإضافية (Host / Origin / Sec-Fetch-Site / ترويسة التطبيق)', async () => {
  const app = await startApp();
  try {
    assert.equal((await app.api('GET', '/api/v2/status')).status, 200);
    assert.equal((await app.api('GET', '/api/v2/status', { host: 'evil.example.com' })).status, 403, 'DNS-rebinding');
    assert.equal((await app.api('GET', '/api/v2/status', { headers: { Origin: 'http://evil.example.com' } })).status, 403);
    assert.equal((await app.api('GET', '/api/v2/status', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await app.api('GET', '/api/v2/status', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    assert.equal((await request(app.port, 'GET', '/api/v2/status', { headers: { 'X-EInvoice-Token': app.token } })).status, 403, 'بدون ترويسة التطبيق');
  } finally { app.stop(); }
});

test('F7: ترويسة CSP ورؤوس الأمان موجودة وصارمة', async () => {
  const app = await startApp();
  try {
    const r = await request(app.port, 'GET', '/', { headers: { 'X-EInvoice-Token': app.token } });
    assert.equal(r.status, 200);
    const csp = r.headers['content-security-policy'];
    assert.ok(csp, 'لا توجد CSP');
    const scriptSrc = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith('script-src'));
    assert.equal(scriptSrc, "script-src 'self'", 'السكربتات من نفس الموقع فقط (لا eval ولا inline ولا CDN)');
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.match(csp, /connect-src 'self'(;|$)/, 'الواجهة لا تتصل إلا بالخادم المحلي');
    assert.doesNotMatch(csp, /ipify|openai|anthropic|googleapis\.com https|generativelanguage/, 'لا عناوين خارجية في connect-src');
    assert.doesNotMatch(csp, /unsafe-eval/);
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    const js = await request(app.port, 'GET', '/app/js/db.js', { headers: { 'X-EInvoice-Token': app.token } });
    assert.ok(js.headers['content-security-policy'], 'ملفات JS أيضاً');
  } finally { app.stop(); }
});

test('F10: حدود حجم الطلبات (413) ولا يُكتب شيء، والنقاط القديمة اختفت', async () => {
  const app = await startApp();
  try {
    const big = JSON.stringify({ value: { whtRate: 1, junk: 'x'.repeat(2 * 1024 * 1024) } });
    // بدون جلسة يُرفض قبل أي معالجة؛ حد الحجم نفسه مختبر مع جلسة في server-v2.test.js
    let status = null;
    try { status = (await app.api('PUT', '/api/v2/col/settings', { body: big, headers: { 'Content-Type': 'application/json' } })).status; } catch (e) { status = 'closed'; }
    assert.ok([401, 413, 'closed'].includes(status), 'يجب الرفض، وجدنا: ' + status);
    assert.equal(fs.existsSync(path.join(app.dataDir, 'einvoice-data.einv')), false, 'لا يُكتب ملف');
    // النقاط القديمة بلا جلسة أو صلاحيات: حُذفت تماماً حتى بتوكن صحيح
    for (const [m, p] of [['GET', '/api/data'], ['PUT', '/api/data'], ['POST', '/api/safety-copy'], ['POST', '/api/open-folder'], ['POST', '/api/eta'], ['POST', '/api/eta/token'], ['GET', '/api/health'], ['GET', '/api/ping']]) {
      assert.equal((await app.api(m, p, { body: m === 'GET' ? undefined : validData })).status, 404, m + ' ' + p);
    }
  } finally { app.stop(); }
});

test('تصفّح الملفات: لا يخرج الخادم عن index.html ومجلد app', async () => {
  const app = await startApp();
  try {
    const get = (p) => request(app.port, 'GET', p, { headers: { 'X-EInvoice-Token': app.token } });
    // المهم: الملف لا يُقدَّم أبداً (المتصفح/URL قد يحوّل بعض الأشكال إلى مسار آخر فتصبح النتيجة 404 بدل 403)
    for (const p of ['/app/..%2fserver.js', '/app/%2e%2e/server.js', '/app/..%5cserver.js', '/app/../server.js', '/app/js/..%2f..%2fserver.js']) {
      const r = await get(p);
      assert.ok(r.status === 403 || r.status === 404, p + ' → ' + r.status);
      assert.doesNotMatch(r.text, /http\.createServer|crypto\.timingSafeEqual/, 'تسرّب كود الخادم عبر ' + p);
    }
    assert.equal((await get('/server.js')).status, 404);
    assert.equal((await get('/config.json')).status, 404);
    assert.equal((await get('/tests/server.test.js')).status, 404);
    assert.equal((await get('/app/js/db.js')).status, 200);
  } finally { app.stop(); }
});

test('F1/F8: المكتبات محلية وبصمة SRI تطابق الملفات، وpdf.js مقفول التنفيذ', () => {
  const quotes = fs.readFileSync(path.join(ROOT, 'app/js/quotes.js'), 'utf8');
  assert.match(quotes, /isEvalSupported:\s*false/, 'CVE-2024-4367: لازم isEvalSupported:false');
  assert.match(quotes, /enableXfa:\s*false/);
  assert.doesNotMatch(quotes, /https?:\/\/(cdn|unpkg|cdnjs|code\.jquery)/i, 'لا مكتبات من الإنترنت');
  const entries = [...quotes.matchAll(/src:\s*'([^']+)',\s*integrity:\s*'sha384-([^']+)'/g)];
  assert.equal(entries.length, 3, 'ثلاث مكتبات بصمتها مكتوبة');
  for (const [, src, integrity] of entries) {
    const file = path.join(ROOT, src);
    assert.ok(fs.existsSync(file), 'الملف غير موجود: ' + src);
    const actual = crypto.createHash('sha384').update(fs.readFileSync(file)).digest('base64');
    assert.equal(actual, integrity, 'بصمة ' + src + ' لا تطابق — الملف تغيّر');
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script[^>]+src="https?:/i, 'index.html بلا سكربتات خارجية');
});

test('الملفات المحلية للمكتبات هي نفس الأصل المنشور (pdf.js 3.11.174 من jsDelivr)', () => {
  // بصمات SHA-256 الرسمية المنشورة من jsDelivr وقت التنزيل (22/10/2026)
  const official = {
    'app/vendor/pdfjs/pdf.min.js': 'W1eZ5vjGgGYyB6xbQu4U7tKkBvp69I9QwVTwwLFWaUY=',
    'app/vendor/pdfjs/pdf.worker.min.js': '/qvfMJdw7SS7oxpUZ4Ns3Iz2OccFryfVK1hbBBu4Uns=',
  };
  for (const [f, h] of Object.entries(official)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('base64'), h, f);
});
