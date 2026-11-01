/* يشغّل خادماً مؤقتاً لاختبارات الواجهة (tests/ui-tests.html) ببيانات فارغة ومزودين وهميين (ذكاء اصطناعي + ضرائب).
 * لا يلمس بيانات المستخدم. الاستخدام:  node tests/start-ui-test-server.js
 * يطبع سطر JSON فيه الرابط ثم يبقى يعمل حتى يُغلق (Ctrl+C) وعندها يمسح المجلد المؤقت. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./helpers');

(async () => {
  const ai = await H.startMockAi();
  const eta = await H.startMockEta();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'einv-ui-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const tokenFile = path.join(dir, 'access-token');
  const child = spawn(process.execPath, [path.join(H.ROOT, 'server.js'), `--port=${port}`, `--data=${path.join(dir, 'data')}`, `--token-file=${tokenFile}`], {
    env: Object.assign({}, process.env, {
      EINVOICE_NO_IPLOOKUP: '1', EINVOICE_NO_OPEN: '1', EINVOICE_TEST_UI: '1', EINVOICE_TEST_SWEEP_MS: '200', EINVOICE_TEST_IDLE_MS: process.env.UI_TEST_IDLE_MS || '6000',
      EINVOICE_TEST_AI_BASE: `http://127.0.0.1:${ai.port}`, EINVOICE_TEST_ETA_BASE: `http://127.0.0.1:${eta.port}`,
    }), stdio: 'inherit',
  });
  for (let i = 0; i < 80; i++) { await H.sleep(100); if (fs.existsSync(tokenFile)) break; }
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/?t=${token}`, test: `http://127.0.0.1:${port}/tests/ui-tests.html`, port, token }));
  const stop = () => { try { child.kill(); } catch (e) { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* */ } process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  child.on('exit', stop);
})();
