/**
 * popup 的接线（E4）：读 cookie → 探测/配对 → 推给本机后端 → 显示回执。
 *
 * ⚠️ 这里**只做别人做不了的事**（`chrome.*` 与 DOM）；所有能算的东西都在 `logic.js`
 * （那个文件能被 `node --test` 跑，这个不能）。
 *
 * 三条安全口径：
 * 1. cookie **只在内存里过一手**（`chrome.storage.local` 只存端口与 token，绝不存 cookie）；
 * 2. 配对 token 存 `chrome.storage.local`（本机扩展私有），**不发往 127.0.0.1 以外的任何地方**；
 * 3. 同步前先把"要写哪些键"显示出来（`usedKeys`）—— 用户看得见自己在做什么。
 */
import {
  PLATFORMS, PAIR_HEADER, cookieHeaderFrom, missingKeys, usedKeys, discoverPort,
  postImport, receiptLine, statusHint, PORT_CANDIDATES, mergeCookies, describeCookie,
} from './logic.js';

const $ = (sel) => document.querySelector(sel);
const logEl = () => $('#log');

function say(text) {
  const el = logEl();
  el.textContent = text ? `${new Date().toLocaleTimeString()}  ${text}` : '';
}

/** 每个平台的连接态与上次同步态（只活在内存里） */
const state = Object.fromEntries(PLATFORMS.map((p) => [p.key, { cookie: '', note: '', tone: '', seen: [] }]));

async function loadSettings() {
  const got = await chrome.storage.local.get(['port', 'token']);
  $('#port').value = got.port || '';
  $('#token').value = got.token || '';
  return { port: Number(got.port) || null, token: got.token || '' };
}

async function saveSettings() {
  const port = Number($('#port').value) || '';
  const token = $('#token').value.trim();
  await chrome.storage.local.set({ port, token });
  say('已保存设置');
  return { port: Number(port) || null, token };
}

/** 找到应用：先用手填/记住的端口，再依次探候选 */
async function ensurePort({ port, token }, { force = false } = {}) {
  const conn = $('#conn');
  conn.dataset.conn = 'unknown';
  if (port && !force) {
    conn.textContent = `用的端口：${port}`;
    conn.dataset.conn = 'ok';
    return port;
  }
  conn.textContent = '正在找本机的 DDToolkit…';
  const found = await discoverPort(fetch, { candidates: PORT_CANDIDATES });
  if (!found) {
    conn.textContent = `没找到应用（试过 ${PORT_CANDIDATES.join('/')}）—— 应用没开？或在下面手填端口`;
    conn.dataset.conn = 'bad';
    return null;
  }
  await chrome.storage.local.set({ port: found });
  $('#port').value = found;
  conn.textContent = token
    ? `已找到应用（端口 ${found}）`
    : `已找到应用（端口 ${found}）—— 还差配对 token（见下面「设置」）`;
  conn.dataset.conn = 'ok';
  return found;
}

/**
 * 读一个平台在那个浏览器里的 cookie（含 HttpOnly —— 这正是本方案必须是扩展的原因）。
 *
 * **三趟读，取并集**（2026-10-06 用户实测：只读一个 URL 时小红书的 `a1`、抖音的
 * `s_v_web_id` 读不到 ⇒ 那一行永远是灰的）：
 *   ① 该平台列的那组 URL（主站 + API 网关）—— 最接近"浏览器真正会发的那条头"；
 *   ② **域扫描** `getAll({domain})`（覆盖子域与别的 path）；
 *   ③ 还缺必需键时，再带 `partitionKey` 读一趟 —— Chrome 默认**不返回分区 cookie**（CHIPS），
 *      而抖音那种第三方嵌入的指纹 cookie 正好可能是分区的。读不到就跳过（老版本没有这个字段）。
 *
 * ⚠️ 全程**只记名字/域/路径**（`describeCookie`），值只进内存里那一条串。
 */
async function readCookie(platform) {
  const lists = [];
  for (const url of platform.urls) {
    try { lists.push(await chrome.cookies.getAll({ url })); } catch { /* 权限/URL 不合法：跳过 */ }
  }
  if (platform.domain) {
    try { lists.push(await chrome.cookies.getAll({ domain: platform.domain })); } catch { /* 同上 */ }
  }
  let merged = mergeCookies(...lists);
  if (missingKeys(platform.key, cookieHeaderFrom(merged)).length) {
    // `partitionKey.topLevelSite` 要的是**站点**（scheme + 可注册域）：API 主机（api.xxx.com）
    // 的 origin 不是站点 ⇒ 两种写法都试一遍，谁成算谁。
    const sites = platform.domain
      ? [...new Set(platform.urls.map((u) => new URL(u).origin)), `https://${platform.domain}`]
      : [];
    for (const url of platform.urls) {
      for (const site of sites) {
        try {
          lists.push(await chrome.cookies.getAll({ url, partitionKey: { topLevelSite: site } }));
        } catch { /* 这个 Chrome 版本不认识 partitionKey（或该 site 不合法）：跳过 */ }
      }
    }
    merged = mergeCookies(...lists);
  }
  state[platform.key].seen = merged.map(describeCookie);
  return cookieHeaderFrom(merged);
}

/** 画一行（键数/长度/回执） */
function render() {
  const ul = $('#rows');
  ul.textContent = '';
  for (const p of PLATFORMS) {
    const st = state[p.key];
    const keys = usedKeys(p.key, st.cookie);
    const total = (st.cookie.match(/=/g) || []).length;
    const miss = missingKeys(p.key, st.cookie);
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.platform = p.key;

    const top = document.createElement('div');
    top.className = 'row-top';
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = `${p.label} · ${keys.length ? `${keys.length} 个可用键` : '没读到 cookie'}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.sync = p.key;
    btn.textContent = '同步';
    const busy = !!state[p.key].busy;
    btn.disabled = busy || !st.cookie || miss.length > 0;
    btn.title = !st.cookie ? '这个浏览器里还没登录（或没访问过该站点）'
      : miss.length ? `缺 ${miss.join('、')} —— 先去浏览器里登录`
        : `把 ${keys.join('、')} 写入 DDToolkit`;
    btn.addEventListener('click', () => void syncOne(p));
    top.append(name, btn);

    const meta = document.createElement('div');
    meta.className = 'row-meta';
    meta.textContent = st.cookie
      ? `整条 ${total} 个键${miss.length ? ` · 缺 ${miss.join('、')}（看下面「设置 → 诊断」）` : ''}`
      : '（浏览器里没登录这个平台）';

    li.append(top, meta);
    if (st.note) {
      const note = document.createElement('div');
      note.className = 'row-note';
      note.dataset.tone = st.tone;
      note.textContent = st.note;
      li.append(note);
    }
    ul.append(li);
  }
  renderDiag();
}

/** 诊断清单：每个平台读到了哪些键（**只有键名与出处**）—— 缺键时用户自己就能看出在哪一步 */
function renderDiag() {
  const el = $('#diag');
  el.textContent = PLATFORMS.map((p) => {
    const seen = state[p.key].seen || [];
    const miss = missingKeys(p.key, state[p.key].cookie);
    const head = `${p.label}：读到 ${seen.length} 条`
      + (miss.length ? `，缺 ${miss.join('、')}` : '（必需键齐了）');
    return [head, ...seen.map((s) => `    ${s}`)].join('\n');
  }).join('\n');
}

/** 同步一个平台 */
async function syncOne(platform, ctx) {
  const st = state[platform.key];
  st.busy = true;
  st.note = '正在同步…';
  st.tone = 'warn';
  render();
  try {
    const settings = ctx || (await loadSettings());
    if (!settings.token) {
      st.note = '还没有配对 token —— 到应用「设置 → 登录 → 浏览器扩展」复制一条，填到下面「设置」里';
      st.tone = 'bad';
      return;
    }
    const port = settings.port || (await ensurePort(settings));
    if (!port) {
      st.note = '没找到应用（先把 DDToolkit 开起来，或手填端口）';
      st.tone = 'bad';
      return;
    }
    const ua = platform.needsUa ? navigator.userAgent : '';
    const { status, receipt } = await postImport(fetch, port, settings.token,
      platform.key, st.cookie, ua);
    if (receipt) {
      st.note = receiptLine(receipt);
      st.tone = receipt.ok ? (receipt.verified ? 'ok' : 'warn') : 'bad';
    } else {
      st.note = statusHint(status) || `应用回了 HTTP ${status}`;
      st.tone = status === 200 ? 'ok' : 'bad';
    }
  } catch (e) {
    // ⚠️ 被浏览器拦（CORS/CSP）与"应用没开"在这一层长得像 —— 都把原文带出来，
    //    别只说"失败了"（`extension/README.md` 的已知缺口里写着这一条要真机确认）
    st.note = `发不出去：${(e && e.message) || e}`
      + '（若一直如此：本扩展需要访问 http://127.0.0.1/*，检查是否被策略拦了）';
    st.tone = 'bad';
  } finally {
    st.busy = false;
    render();
  }
}

/** 一键四个平台（逐平台回执：一个失败不影响其余三个） */
async function syncAll() {
  const settings = await loadSettings();
  if (!settings.token) {
    say('还没有配对 token —— 见下面「设置」');
    return;
  }
  const port = settings.port || (await ensurePort(settings));
  if (!port) { say('没找到应用'); return; }
  const ctx = { port, token: settings.token };
  const btn = $('#sync-all');
  btn.disabled = true;
  try {
    for (const p of PLATFORMS) {
      if (!state[p.key].cookie) {
        state[p.key].note = '这个浏览器里还没登录，跳过';
        state[p.key].tone = 'warn';
        render();
        continue;
      }
      await syncOne(p, ctx);
    }
    say('四个平台走完了（逐条结果见上）');
  } finally {
    btn.disabled = false;
  }
}

/** 进来先读 cookie（不改任何东西），并把端口/token 读出来 */
async function boot() {
  const settings = await loadSettings();
  await rereadCookies();
  await ensurePort(settings);
}

/** 重新读一遍四个平台的 cookie（用户在别处刚登录完、或想复看诊断时点它） */
async function rereadCookies() {
  for (const p of PLATFORMS) {
    state[p.key].note = '';
    state[p.key].tone = '';
    try {
      state[p.key].cookie = await readCookie(p);
    } catch (e) {
      state[p.key].cookie = '';
      state[p.key].note = `读 cookie 失败：${(e && e.message) || e}`;
      state[p.key].tone = 'bad';
    }
  }
  render();
}

$('#sync-all').addEventListener('click', () => void syncAll());
$('#save').addEventListener('click', () => void saveSettings());
$('#reread').addEventListener('click', () => void rereadCookies());
$('#rediscover').addEventListener('click', async () => {
  const s = await saveSettings();
  await ensurePort(s, { force: true });
});
void boot();

// 供排查用：`chrome-extension://<id>/popup.html` 的控制台里 `__ddtoolkitExt()` 看当前状态
// （`seen` 是"读到了哪些 cookie"的清单：只有键名/域/路径，**没有值**）
globalThis.__ddtoolkitExt = () => ({
  pairHeader: PAIR_HEADER,
  state: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, {
    keys: usedKeys(k, v.cookie), note: v.note, seen: v.seen,
  }])),
});
