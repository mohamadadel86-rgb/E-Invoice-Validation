/* أدوات مشتركة لاختبارات الخادم الجديد (المرحلة A) */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURE = path.join(__dirname, 'fixtures', 'v1-browser.einv');
const ADMIN_PW = 'Mgr-Admin2026';   // ملف التجربة: admin
const AUD_PW = 'Audit-2222x';       // ملف التجربة: aud (صلاحية الأظرف فقط)

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

/* يبدأ الخادم الفعلي. opts: fixture (انسخ ملف التجربة)، dataDir/dir لإعادة تشغيل بنفس البيانات، env إضافية */
async function startApp(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'einv-v2-'));
  const dataDir = path.join(dir, 'data');
  const tokenFile = path.join(dir, 'access-token');
  if (opts.fixture && !fs.existsSync(path.join(dataDir, 'einvoice-data.einv'))) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(FIXTURE, path.join(dataDir, 'einvoice-data.einv'));
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [process.env.TEST_SERVER_JS || path.join(ROOT, 'server.js'), `--port=${port}`, `--data=${dataDir}`, `--token-file=${tokenFile}`], {
    env: Object.assign({}, process.env, { EINVOICE_NO_IPLOOKUP: '1', EINVOICE_TEST_SWEEP_MS: '100' }, opts.env || {}), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { await sleep(100); try { await request(port, 'GET', '/'); up = true; } catch (e) { /* لسه */ } }
  if (!up) throw new Error('الخادم لم يبدأ');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const app = {
    port, dir, dataDir, token, mainFile: path.join(dataDir, 'einvoice-data.einv'),
    stop: () => { child.kill(); },
    cleanup: () => { try { child.kill(); } catch (e) { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ } },
    raw: (method, p, o = {}) => request(port, method, p, Object.assign({}, o, { headers: Object.assign({ 'X-EInvoice-App': '1', 'X-EInvoice-Token': token }, o.headers || {}) })),
  };
  return app;
}

/* عميل بجلسة (كوكي einv_s) */
class Client {
  constructor(app) { this.app = app; this.sid = null; this.seen = []; }
  async call(method, p, body, headers) {
    const h = { 'X-EInvoice-App': '1', 'X-EInvoice-Token': this.app.token, ...(headers || {}) };
    if (this.sid) h.Cookie = 'einv_s=' + this.sid;
    let payload;
    if (body !== undefined) { payload = typeof body === 'string' ? body : JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const r = await request(this.app.port, method, p, { headers: h, body: payload });
    const sc = [].concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('einv_s='));
    if (sc) { this.sid = sc.split(';')[0].slice(7) || null; r.setCookie = sc; }
    try { r.json = JSON.parse(r.text); } catch (e) { r.json = null; }
    this.seen.push(r.text);
    return r;
  }
  get(p, h) { return this.call('GET', p, undefined, h); }
  post(p, b, h) { return this.call('POST', p, b === undefined ? {} : b, h); }
  put(p, b, h) { return this.call('PUT', p, b, h); }
  del(p) { return this.call('DELETE', p); }
  async login(username, password) { return this.post('/api/v2/login', { username, password }); }
}

async function loggedIn(app, username, password) {
  const c = new Client(app);
  const r = await c.login(username, password);
  if (r.status !== 200) throw new Error(`فشل دخول ${username}: ${r.status} ${r.text}`);
  return c;
}

/* ينشئ مستخدماً بصلاحيات محددة (من مدير) ويرجع كلمة مروره */
let pwCounter = 0;
async function makeUser(admin, username, perms = {}, role = 'auditor') {
  const password = `Test-Pass-${++pwCounter}x${username}`;
  const r = await admin.post('/api/v2/users', { username, displayName: username, password, role, perms });
  if (r.status !== 200) throw new Error(`فشل إنشاء ${username}: ${r.status} ${r.text}`);
  return { id: r.json.id, username, password };
}

/* خادم ضرائب وهمي */
function startMockEta() {
  // docs: حالة كل مستند على المنظومة الوهمية {uuid: {status, receiverId}} · detailCalls: من سأل عن تفاصيل أي مستند
  const state = { tokenCalls: [], searchAuth: [], docs: {}, detailCalls: [] };
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/connect/token') {
      const m = String(req.headers.authorization || '').match(/^Basic (.+)$/);
      const [id, secret] = m ? Buffer.from(m[1], 'base64').toString().split(':') : [];
      state.tokenCalls.push({ id, secret });
      req.resume();
      if (id === 'cid' && secret === 'good') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ access_token: 'T-' + state.tokenCalls.length, token_type: 'Bearer', expires_in: 3600 })); }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'invalid_client' }));
    }
    if (req.url.startsWith('/api/v1.0/documents/search')) {
      state.searchAuth.push(req.headers.authorization);
      const ok = /^Bearer T-/.test(String(req.headers.authorization || ''));
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      if (!ok) return res.end(JSON.stringify({ error: 'unauthorized' }));
      const q = new URL(req.url, 'http://x').searchParams;
      // بحث بدون مورد = سحب كل الفواتير المستلمة: موردان وفاتورتان وإشعار دائن (بتواريخ داخل الفترة المطلوبة)
      if (!q.get('issuerId')) {
        const day = (q.get('issueDateTo') || '2026-09-01T00:00:00').slice(0, 10) + 'T08:00:00Z';
        const doc = (uuid, no, issuerId, issuerName, net, total) => ({ uuid, internalId: no, issuerId, issuerName, receiverId: '111111111', dateTimeIssued: day, netAmount: net, total, status: 'Valid' });
        const result = q.get('documentType') === 'c' ? [doc('C-1', 'CN-1', '222222222', 'مورد البقالة', 100, 114)]
          : q.get('documentType') === 'd' ? [] : [doc('E-1', '501', '222222222', 'مورد البقالة', 1000, 1140), doc('E-2', '502', '222222222', 'مورد البقالة', 500, 570), doc('E-3', '77', '333333333', 'مورد السمك', 2000, 2000)];
        return res.end(JSON.stringify({ result, metadata: { continuationToken: 'EndofResultSet' } }));
      }
      return res.end(JSON.stringify({ result: [{ uuid: 'U1' }], metadata: { continuationToken: 'EndofResultSet' } }));
    }
    const dm = req.url.match(/^\/api\/v1\.0\/documents\/([A-Za-z0-9]+)\/details/);
    if (dm) {
      state.detailCalls.push(dm[1]);
      const ok = /^Bearer T-/.test(String(req.headers.authorization || ''));
      const d = state.docs[dm[1]];
      res.writeHead(!ok ? 401 : d ? 200 : 404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(ok && d ? Object.assign({ uuid: dm[1] }, d) : { error: ok ? 'not found' : 'unauthorized' }));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port, close: () => srv.close() })));
}

/* خادم ذكاء اصطناعي وهمي (Gemini / Claude / OpenAI) يسجّل المفاتيح التي وصلته */
function startMockAi() {
  const state = { calls: [] };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const rec = { url: req.url, gKey: req.headers['x-goog-api-key'], cKey: req.headers['x-api-key'], oAuth: req.headers.authorization, body };
      state.calls.push(rec);
      let status = 200, out;
      if (/FORCE-429/.test(body)) { status = 429; out = { error: { message: 'quota exceeded for this model' } }; }
      else if (req.url.startsWith('/v1beta/models/')) out = { candidates: [{ content: { parts: [{ text: '{"ok":true,"from":"gemini"}' }] } }] };
      else if (req.url === '/v1/messages') out = { content: [{ type: 'text', text: '{"ok":true,"from":"claude"}' }] };
      else if (req.url === '/v1/chat/completions') out = { choices: [{ message: { content: '{"ok":true,"from":"openai"}' } }] };
      else { status = 404; out = { error: { message: 'not found' } }; }
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port, close: () => srv.close() })));
}

module.exports = { ROOT, sleep, FIXTURE, ADMIN_PW, AUD_PW, request, startApp, Client, loggedIn, makeUser, startMockEta, startMockAi };
