/* وسيط منظومة الفاتورة الإلكترونية (مصلحة الضرائب) — قراءة المستندات فقط */
'use strict';

const crypto = require('crypto');

const ETA_ENV = {
  prod: { id: 'https://id.eta.gov.eg', api: 'https://api.invoicing.eta.gov.eg' },
  preprod: { id: 'https://id.preprod.eta.gov.eg', api: 'https://api.preprod.invoicing.eta.gov.eg' },
};
// بيئة اختبار محلية (تظهر فقط لو ضُبط متغير بيئة صراحةً؛ لا تتاح للمستخدم العادي)
if (process.env.EINVOICE_TEST_ETA_BASE) ETA_ENV.test = { id: process.env.EINVOICE_TEST_ETA_BASE, api: process.env.EINVOICE_TEST_ETA_BASE };

// المسارات المسموح بها فقط (قراءة المستندات) — الخادم ليس وسيطاً مفتوحاً
const ETA_PATHS = [
  /^\/api\/v1(\.0)?\/documents\/search$/,
  /^\/api\/v1(\.0|\.1)?\/documents\/recent$/,
  /^\/api\/v1(\.0)?\/documents\/[A-Za-z0-9]{6,64}\/(details|raw)$/,
];

const hasEnv = (env) => typeof env === 'string' && Object.prototype.hasOwnProperty.call(ETA_ENV, env);
const tokens = new Map(); // env|بصمة(clientId+secret) -> {token, exp}

async function etaToken(env, clientId, clientSecret, force) {
  if (!hasEnv(env)) throw Object.assign(new Error('بيئة غير معروفة'), { status: 400 });
  // المفتاح يشمل بصمة السر أيضاً: Client ID وحده لا يكفي لاستلام توكن محفوظ
  const key = env + '|' + crypto.createHash('sha256').update(String(clientId) + '\u0000' + String(clientSecret)).digest('hex');
  const c = tokens.get(key);
  if (!force && c && c.exp > Date.now() + 60000) return c.token;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch(ETA_ENV[env].id + '/connect/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) {
    const e = new Error(data.error === 'invalid_client' ? 'invalid_client' : (data.error_description || data.error || ('HTTP ' + r.status)));
    e.status = r.status === 400 ? 401 : r.status;
    throw e;
  }
  tokens.set(key, { token: data.access_token, exp: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
  return data.access_token;
}

async function etaRequest({ env, clientId, clientSecret, path: p, query }) {
  if (!hasEnv(env)) throw Object.assign(new Error('بيئة غير معروفة'), { status: 400 });
  if (!clientId || !clientSecret) throw Object.assign(new Error('بيانات الربط ناقصة'), { status: 400 });
  if (typeof p !== 'string' || !ETA_PATHS.some((re) => re.test(p))) throw Object.assign(new Error('مسار غير مسموح'), { status: 400 });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query && typeof query === 'object' ? query : {})) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  const url = ETA_ENV[env].api + p + (qs.toString() ? '?' + qs : '');
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await etaToken(env, clientId, clientSecret, attempt > 0);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Accept-Language': 'ar' }, signal: AbortSignal.timeout(60000) });
    if (r.status === 401 && attempt === 0) continue; // انتهى التوكن: نجدده مرة
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = { raw: text.slice(0, 2000) }; }
    return { status: r.status, retryAfter: Number(r.headers.get('retry-after')) || null, body };
  }
  return { status: 401, body: { error: 'unauthorized' } };
}

module.exports = { hasEnv, etaToken, etaRequest };
