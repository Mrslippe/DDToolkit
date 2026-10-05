/**
 * 扩展**纯逻辑**的判据（E4，2026-10-06）。跑法：`node --test extension/test/`（`scripts/gate.py` 里跑）。
 *
 * 为什么判据落在这里：MV3 popup 没法在 CI 里自动化驱动（要真浏览器 + 真 cookie），
 * 而"cookie 怎么拼、缺哪些键、探哪个端口、回执怎么说"这些**能算**的东西一旦错了，
 * 症状全是"同步成功但抓不到"这种静默形态。所以能算的全放 `src/logic.js` 并在这里钉死。
 *
 * ⚠️ 最后一条是**清单对账**：扩展侧的必需键必须与后端一致（本仓最怕"两边各写一份，迟早漂"）。
 *    对账读的是后端源码的字面量（不是"跑一次后端"）—— 这样 `node --test` 不需要 Python 环境。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  APP_IDENTIFIER, PAIR_HEADER, PORT_CANDIDATES, PLATFORMS, platformOf,
  cookieHeaderFrom, cookieKeys, missingKeys, usedKeys, importBody,
  receiptLine, statusHint, discoverPort, postImport,
} from '../src/logic.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

test('cookie 拼接：保序、不按 name 去重、只去掉完全重复的那条', () => {
  const header = cookieHeaderFrom([
    { name: 'SESSDATA', value: 'a', path: '/' },
    { name: 'bili_jct', value: 'b', path: '/' },
    // 同名不同 path ⇒ **两条都要**（浏览器就是按顺序把两条都发出去）
    { name: 'SESSDATA', value: 'a2', path: '/x' },
    // 完全重复（多个 URL 取并集时会撞）⇒ 只留一条
    { name: 'bili_jct', value: 'b', path: '/' },
    { name: '', value: 'ignored' },
    null,
  ]);
  assert.equal(header, 'SESSDATA=a; bili_jct=b; SESSDATA=a2');
});

test('cookie 键名：空段/尾分号/无等号的段都跳过', () => {
  assert.deepEqual(cookieKeys(' a=1; b=2 ;; c ; d=3; '), ['a', 'b', 'd']);
  assert.deepEqual(cookieKeys(''), []);
});

test('缺键判定：B 站要 SESSDATA+bili_jct', () => {
  assert.deepEqual(missingKeys('bilibili', 'SESSDATA=1'), ['bili_jct']);
  assert.deepEqual(missingKeys('bilibili', 'SESSDATA=1; bili_jct=2'), []);
});

test('缺键判定：小红书要 a1+web_session（缺 a1 时签名器直接报错）', () => {
  assert.deepEqual(missingKeys('xiaohongshu', 'web_session=w'), ['a1']);
  assert.deepEqual(missingKeys('xiaohongshu', 'a1=a; web_session=w'), []);
});

test('缺键判定：抖音的 uifid 认两种写法（UIFID_TEMP 也算）', () => {
  const base = 's_v_web_id=v; ttwid=t';
  assert.deepEqual(missingKeys('douyin', base), ['uifid 或 UIFID_TEMP']);
  assert.deepEqual(missingKeys('douyin', `${base}; uifid=u`), []);
  assert.deepEqual(missingKeys('douyin', `${base}; UIFID_TEMP=u`), []);
  assert.deepEqual(missingKeys('douyin', 's_v_web_id=v'), ['ttwid', 'uifid 或 UIFID_TEMP']);
});

test('不认识的平台 ⇒ 判空（调用方必须自己处理，不许静默当成某个平台）', () => {
  assert.equal(platformOf('tiktok'), undefined);
  assert.deepEqual(missingKeys('tiktok', 'a=1'), []);
  assert.deepEqual(usedKeys('tiktok', 'a=1'), []);
});

test('请求体：UA 只在需要它的平台上带（别的平台多送一份指纹没意义）', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0.0.0';
  assert.deepEqual(importBody('douyin', 'a=1', ua), { platform: 'douyin', cookie: 'a=1', ua });
  assert.deepEqual(importBody('weibo', 'SUB=x', ua), { platform: 'weibo', cookie: 'SUB=x' });
  // 抖音没给 UA 时也不许编一个（UA 必须来自**这个**浏览器）
  assert.deepEqual(importBody('douyin', 'a=1', ''), { platform: 'douyin', cookie: 'a=1' });
});

test('回执文案：成功（已验/未验）与失败各一句人话', () => {
  assert.match(receiptLine({
    ok: true, platform: 'bilibili', label: 'B 站', keys: ['SESSDATA', 'bili_jct'],
    cookie_keys: 5, verified: true,
  }), /^B 站：已同步 SESSDATA、bili_jct（整条 5 个键，已验证登录态）$/);
  assert.match(receiptLine({
    ok: true, platform: 'douyin', label: '抖音', keys: ['ttwid'], cookie_keys: 3, verified: false,
  }), /未在线验证/);
  assert.match(receiptLine({
    ok: false, platform: 'xiaohongshu', label: '小红书', missing: ['a1'],
    note: 'cookie 缺少 a1 —— 从浏览器复制整条 Cookie 头',
  }), /小红书：没同步 —— cookie 缺少 a1/);
  assert.match(receiptLine(null), /没有回执/);
});

test('状态码 → 人话（每种都有，没有"未知错误"）', () => {
  assert.match(statusHint(401), /配对 token 不对/);
  assert.match(statusHint(403), /本机/);
  assert.match(statusHint(429), /等一分钟/);
  assert.match(statusHint(502), /HTTP 502/);
  assert.equal(statusHint(200), '');
});

test('端口探测：认领靠 /healthz 的 app 标识，别的服务不算', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url.includes(':8766')) return { ok: true, json: async () => ({ app: 'ddtoolkit' }) };
    if (url.includes(':8765')) return { ok: true, json: async () => ({ app: 'something-else' }) };
    throw new Error('ECONNREFUSED');
  };
  assert.equal(await discoverPort(fake, { candidates: [8765, 8766, 8767] }), 8766);
  const ports = calls.map((u) => Number(new URL(u).port));
  assert.deepEqual(ports, [8765, 8766], '应当按候选顺序探、命中即停');
});

test('端口探测：一个都没命中 ⇒ null（不抛；界面据此说"没找到应用"）', async () => {
  const fake = async () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await discoverPort(fake, { candidates: [9001, 9002] }), null);
});

test('端口探测：连得上但不是 JSON（别的服务）⇒ 换下一个', async () => {
  const fake = async (url) => (url.includes('9001')
    ? { ok: true, json: async () => { throw new Error('not json'); } }
    : { ok: true, json: async () => ({ app: 'ddtoolkit' }) });
  assert.equal(await discoverPort(fake, { candidates: [9001, 9002] }), 9002);
});

test('POST：带配对 token 头、超时后抛（由调用方转成人话）', async () => {
  let seen = null;
  const fake = async (url, init) => {
    seen = { url, init };
    return { status: 200, json: async () => ({ ok: true, platform: 'weibo', label: '微博' }) };
  };
  const r = await postImport(fake, 8765, 'tok', 'weibo', 'SUB=x');
  assert.equal(r.status, 200);
  assert.equal(r.receipt.ok, true);
  assert.equal(seen.url, 'http://127.0.0.1:8765/auth/import');
  assert.equal(seen.init.headers[PAIR_HEADER], 'tok');
  assert.equal(seen.init.method, 'POST');
  assert.deepEqual(JSON.parse(seen.init.body), { platform: 'weibo', cookie: 'SUB=x' });
});

/** 清单对账（见文件头）：扩展侧的必需键 / 目标 URL / 应用标识必须与后端一致 */
test('清单对账：与后端源码逐项一致（改了后端没改扩展 ⇒ 这条红）', () => {
  const logic = readFileSync(join(ROOT, 'extension', 'src', 'logic.js'), 'utf8');
  const backend = readFileSync(join(ROOT, 'app', 'services', 'cookie_import.py'), 'utf8');
  const mainPy = readFileSync(join(ROOT, 'app', 'main.py'), 'utf8');
  const shell = readFileSync(join(ROOT, 'frontend', 'src-tauri', 'src', 'lib.rs'), 'utf8');

  // ① 应用标识与头名：两边**同一行字面量**
  assert.ok(backend.includes(`PAIR_HEADER = "${PAIR_HEADER}"`),
    `扩展用的头名 ${PAIR_HEADER} 与后端不一致`);
  assert.ok(mainPy.includes(`APP_IDENTIFIER = "${APP_IDENTIFIER}"`),
    `扩展认的标识 ${APP_IDENTIFIER} 与后端不一致`);

  // ② 端口候选：与壳的 PREFERRED_PORTS 逐个相同（并同一顺序）
  const shellList = shell.match(/const PREFERRED_PORTS: \[u16; \d+\] = \[([^\]]+)\]/);
  assert.ok(shellList, '壳里找不到 PREFERRED_PORTS（这条判据的锚点改了？）');
  const shellPorts = shellList[1].split(',').map((s) => Number(s.trim())).filter(Boolean);
  assert.deepEqual(PORT_CANDIDATES, shellPorts, '扩展的端口候选与壳不一致');

  // ③ 四个平台的 key 与后端 PLATFORM_LABELS 的 key 集合一致
  const labels = backend.match(/PLATFORM_LABELS = \{([\s\S]*?)\}/);
  assert.ok(labels, '后端找不到 PLATFORM_LABELS');
  const backendKeys = [...labels[1].matchAll(/"([a-z]+)":/g)].map((m) => m[1]);
  assert.deepEqual([...PLATFORMS].map((p) => p.key).sort(), backendKeys.sort(),
    '扩展的平台清单与后端不一致（后端加了平台而扩展没跟上？）');

  // ④ B 站/微博的必需键与后端 REQUIRED_KEYS 一致
  const req = backend.match(/REQUIRED_KEYS[^=]*= \{([\s\S]*?)\n\}/);
  assert.ok(req, '后端找不到 REQUIRED_KEYS');
  const bili = req[1].match(/"bilibili": \(([^)]*)\)/);
  const weibo = req[1].match(/"weibo": \(([^)]*)\)/);
  const parseKeys = (s) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(platformOf('bilibili').required, parseKeys(bili[1]));
  assert.deepEqual(platformOf('weibo').required, parseKeys(weibo[1]));

  // ⑤ 小红书/抖音的必需键由各自模块说了算 ⇒ 认它的 `missing_keys` 里那几件
  const xhs = readFileSync(join(ROOT, 'app', 'services', 'xhs_auth.py'), 'utf8');
  const dy = readFileSync(join(ROOT, 'app', 'services', 'douyin_auth.py'), 'utf8');
  for (const key of platformOf('xiaohongshu').required) {
    assert.ok(xhs.includes(`"${key}"`), `小红书必需键 ${key} 在后端源码里找不到`);
  }
  for (const key of platformOf('douyin').required) {
    assert.ok(dy.includes(`"${key}"`), `抖音必需键 ${key} 在后端源码里找不到`);
  }
  // 抖音的"两写法"那一组也要在后端存在
  assert.ok(dy.includes('UIFID_TEMP'), '抖音后端的 uifid 备用名（UIFID_TEMP）不见了');

  // ⑥ 微博那张 URL 必须是 PC 域（m 站不认 SUB，实测）
  assert.ok(platformOf('weibo').url.startsWith('https://weibo.com'),
    '微博的目标 URL 必须是 PC 域 weibo.com');

  // ⑦ 扩展侧不许偷偷 import chrome.*（这个文件是纯逻辑，要能在 node 里跑）
  //    ⚠️ 只看**代码行**：注释里提到 `chrome.cookies`（解释"为什么必须是扩展"）不算违规。
  const codeLines = logic
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    })
    .join('\n');
  assert.ok(!/chrome\./.test(codeLines), 'logic.js 的代码里出现了 chrome.*（纯逻辑层不许依赖浏览器 API）');
});
