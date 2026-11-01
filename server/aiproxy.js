/* وسيط الذكاء الاصطناعي: الخادم هو الذي يتصل بـ Gemini / Claude / ChatGPT بمفتاح محفوظ عنده.
 * المفتاح لا يصل للمتصفح أبداً. العناوين ثابتة (لا SSRF)، واسم النموذج يُفحص بقائمة محدودة. */
'use strict';

const BASES = { gemini: 'https://generativelanguage.googleapis.com', claude: 'https://api.anthropic.com', openai: 'https://api.openai.com' };
const PROVIDERS = Object.keys(BASES);
const MODEL_RE = /^[A-Za-z0-9._:-]{1,100}$/;
const MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const LIMITS = { images: 12, imageB64: 8 * 1024 * 1024, text: 200 * 1024 };

// عنوان اختبار محلي (متغير بيئة صريح فقط)
const base = (p) => process.env.EINVOICE_TEST_AI_BASE || BASES[p];

function checkInput({ provider, model, system, prompt, images }) {
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (!PROVIDERS.includes(provider)) throw bad('مزود غير معروف');
  if (model !== undefined && model !== null && model !== '' && !MODEL_RE.test(String(model))) throw bad('اسم النموذج غير صالح');
  if (typeof system !== 'string' || typeof prompt !== 'string' || system.length > LIMITS.text || prompt.length > LIMITS.text) throw bad('نص الطلب غير صالح أو طويل');
  const imgs = images === undefined ? [] : images;
  if (!Array.isArray(imgs) || imgs.length > LIMITS.images) throw bad('عدد الصور أكبر من المسموح');
  for (const im of imgs) {
    if (!im || !MIMES.includes(im.mime) || typeof im.data !== 'string' || im.data.length > LIMITS.imageB64 || !/^[A-Za-z0-9+/=]+$/.test(im.data)) throw bad('صورة غير صالحة');
  }
  return imgs;
}

/* يرجع {ok:true,text} أو {ok:false,status,message} (حالة المزود الحقيقية، ليستعملها المتصفح في إعادة المحاولة والتحويل) */
async function callProvider({ provider, key, model, system, prompt, images }) {
  const imgs = images || [];
  let res, data;
  try {
    if (provider === 'gemini') {
      const parts = imgs.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } }));
      parts.push({ text: prompt });
      res = await fetch(`${base('gemini')}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
        signal: AbortSignal.timeout(180000),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, status: res.status, message: (data.error && data.error.message) || res.statusText };
      const cand = data.candidates && data.candidates[0];
      return { ok: true, text: ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || '').join('') };
    }
    if (provider === 'claude') {
      const content = imgs.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime, data: im.data } }));
      content.push({ type: 'text', text: prompt });
      res = await fetch(`${base('claude')}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 16000, system, messages: [{ role: 'user', content }] }),
        signal: AbortSignal.timeout(180000),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, status: res.status, message: (data.error && data.error.message) || res.statusText };
      return { ok: true, text: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('') };
    }
    // openai
    const content = [{ type: 'text', text: prompt }];
    for (const im of imgs) content.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}`, detail: 'high' } });
    res = await fetch(`${base('openai')}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content }] }),
      signal: AbortSignal.timeout(180000),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, status: res.status, message: (data.error && data.error.message) || res.statusText };
    return { ok: true, text: data.choices[0].message.content };
  } catch (e) {
    return { ok: false, status: 0, message: 'network' };
  }
}

module.exports = { PROVIDERS, MODEL_RE, checkInput, callProvider };
