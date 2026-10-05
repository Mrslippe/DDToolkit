/**
 * DDToolkit 凭据同步扩展的**纯逻辑**（E4，2026-10-06）。
 *
 * ⚠️ **这个文件不许 import 任何 `chrome.*`**：它是唯一能被 `node --test` 直接跑的部分
 * （扩展本体没法在 CI 里自动化驱动 —— 见 `extension/README.md` 的"已知缺口"）。
 * 凡是"能算出来"的东西都放这里：cookie 拼接、缺键判定、端口候选与探测、回执文案。
 *
 * ## 与后端的两条对齐（错了就是"同步成功但抓不到"）
 *
 * 1. **目标 URL 表**：`chrome.cookies.getAll({url})` 返回的顺序**就是**浏览器发送顺序
 *    （同名前缀更长的在后）⇒ 我们要的就是"浏览器发给那个平台的那条 Cookie 头"。
 *    微博那张必须是 **PC 域** `https://weibo.com/`（实测 m 站不认扫码/粘贴产出的 SUB cookie）。
 * 2. **必需键**：与后端 `services/cookie_import.py` 的 `REQUIRED_KEYS` /
 *    `xhs_auth.missing_keys` / `douyin_auth.missing_keys` 一一对应。
 *    后端加了必需键而这里没跟上 ⇒ 用户看到"同步成功"、抓取却全失败（本仓最怕的静默形态）。
 *    `extension/test/logic.test.mjs` 里有一条**日期无关的清单对账**（字面量写在这里，改一处两边都要动）。
 */

/** 后端在 `/healthz` 里回的应用标识（`app/main.py::APP_IDENTIFIER`，改一处两边都要动） */
export const APP_IDENTIFIER = 'ddtoolkit';

/** 配对凭证的头名（`services/cookie_import.py::PAIR_HEADER`） */
export const PAIR_HEADER = 'X-DDToolkit-Pair';

/**
 * 端口候选：与桌面壳的 `PREFERRED_PORTS`（`src-tauri/src/lib.rs`）**逐字一致**。
 * 壳优先绑这五个，扩展依次探；全被占时壳会退回随机端口 ⇒ 那时只能手填（兜底留在这里）。
 */
export const PORT_CANDIDATES = [8765, 8766, 8767, 8768, 8769];

/**
 * 四个平台：读哪些 URL（+ 域扫描）/ 必需键 / 回执里显示哪些键 / 是否需要 UA。
 *
 * ⚠️ **一个 URL 不够**（2026-10-06 用户实测踩到）：只读 `www.` 那一侧时，小红书的 `a1`、
 * 抖音的 `s_v_web_id` **读不到** ⇒ 那一行的同步按钮只能是灰的（用户看到的正是这个）。
 * ⇒ 每个平台列**一组** URL（主站 + API 网关 + 首页），再额外做一次**域扫描**
 * （`getAll({domain})` 覆盖子域），最后 `mergeCookies()` 取并集。
 */
export const PLATFORMS = [
  {
    key: 'bilibili',
    label: 'B 站',
    urls: [
      'https://api.bilibili.com/x/web-interface/nav',
      'https://www.bilibili.com/',
    ],
    domain: 'bilibili.com',
    required: ['SESSDATA', 'bili_jct'],
    used: ['SESSDATA', 'bili_jct', 'DedeUserID', 'buvid3', 'buvid4'],
    needsUa: false,
  },
  {
    key: 'weibo',
    label: '微博',
    // ⚠️ PC 域：`WEIBO_COOKIE` 只在 weibo.com 有效（`services/platforms/weibo.py` 实测）
    urls: ['https://weibo.com/', 'https://weibo.com/newlogin'],
    domain: 'weibo.com',
    required: ['SUB'],
    used: ['SUB', 'SUBP', 'SSOLoginState', 'ALF'],
    needsUa: false,
  },
  {
    key: 'xiaohongshu',
    label: '小红书',
    // `edith.xiaohongshu.com` 是**主力业务 API 网关**（`docs/design/xhs-douyin-research.md` §2.1）：
    // `a1` 是签名强制输入，实测它常常只在这一侧可见 ⇒ 两个 host 都要读
    urls: [
      'https://www.xiaohongshu.com/explore',
      'https://edith.xiaohongshu.com/',
      'https://www.xiaohongshu.com/',
    ],
    domain: 'xiaohongshu.com',
    required: ['a1', 'web_session'],
    used: ['a1', 'web_session', 'webId'],
    needsUa: false,
  },
  {
    key: 'douyin',
    label: '抖音',
    // `s_v_web_id` 要同时充当 `verifyFp`/`fp`，实测它不在 `www.douyin.com/` 这一条上
    urls: [
      'https://www.douyin.com/',
      'https://www.douyin.com/discover',
      'https://www.douyin.com/user/self',
    ],
    domain: 'douyin.com',
    // `uifid` 与 `UIFID_TEMP` 是同一个位置的两写法（后端 `missing_keys` 也认两种）
    required: ['s_v_web_id', 'ttwid'],
    requiredAny: [['uifid', 'UIFID_TEMP']],
    used: ['uifid', 'UIFID_TEMP', 's_v_web_id', 'ttwid'],
    // ⚠️ UA 是凭据的一部分：`a_bogus` 把它算进签名，给错的样子是**静默空数据**
    needsUa: true,
  },
];

/**
 * 把多趟读回来的 cookie **并成一份**（按 `name + path` 去重，**先到的赢**）。
 *
 * 为什么要多趟：`getAll({url})` 只给"会发给那个 URL 的那些"，而同一家的指纹 cookie
 * 可能挂在别的 host/path 上（2026-10-06 用户实测：只读 `www.` 时小红书的 `a1`、
 * 抖音的 `s_v_web_id` 都读不到，那一行的同步按钮只能是灰的）。
 */
export function mergeCookies(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const c of list || []) {
      if (!c || !c.name) continue;
      const id = `${c.name}\u0000${c.path || '/'}\u0000${c.domain || ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(c);
    }
  }
  return out;
}

/**
 * **全量读**回来的那一大堆里，哪些属于这个平台（**纯函数：这是"读全量"唯一的安全阀**）。
 *
 * 为什么要读全量（2026-10-06 用户实测）：`getAll({url})` 只给"会发给那条 URL 的"，
 * `getAll({domain})` 只给"那个域筛得出来的"，而平台把指纹 cookie 挂在哪个 host / 哪条 path /
 * 哪一格分区（CHIPS）**是它自己说了算** —— 结果就是：用户对着 DevTools 明明看得见
 * `a1` / `s_v_web_id`，扩展却读不到，那两行同步永远是灰的。
 * `getAll({})` 不看 URL、不看 path，一次把整个 cookie 库拿出来，绕开所有这些语义坑。
 *
 * ⚠️ **读全量 = 别人家的 cookie 也躺在同一只手里** ⇒ 这条过滤是硬安全阀：
 * ① 只留 `domain == 平台域` 或 `*.平台域`，**后缀必须是完整的标签** —— `evildouyin.com`、
 *    `douyin.com.evil.com`、`notxiaohongshu.com` 一律不算（有用例盯着这条）；
 * ② 返回**新数组**，调用方立刻并进那个平台那一份，别处不许留引用。
 */
export function cookiesForDomain(allCookies, domain) {
  const want = String(domain || '').toLowerCase().replace(/^\./, '');
  if (!want) return [];
  return (allCookies || []).filter((c) => {
    const got = String((c && c.domain) || '').toLowerCase().replace(/^\./, '');
    return got === want || got.endsWith(`.${want}`);
  });
}

/**
 * 给诊断用：`name @ domain path len=N` + 几个关键标志（**只有键名/出处/长度，没有值**）。
 *
 * ⚠️ **长度是有用信息、且不是秘密**（应用自己的文档就是这么描述 cookie 的，
 * 例如"`a1` 长度 52 字符"）—— 2026-10-06 那次排查里，正是靠"某个新名字长度对不对得上"
 * 才能判断平台是不是把指纹 cookie 改了名。**值一个字都不进这里。**
 */
export function describeCookie(c) {
  const flags = [
    c.httpOnly ? 'HttpOnly' : '',
    c.session ? '会话' : '',
    c.partitionKey ? '分区' : '',
  ].filter(Boolean).join('/');
  const len = (c.value ?? '').length;
  return `${c.name} @ ${c.domain || '?'}${c.path || '/'} len=${len}${flags ? ` [${flags}]` : ''}`;
}

/** 平台 key → 定义（找不到返回 undefined：调用方必须处理，别静默用错平台） */
export function platformOf(key) {
  return PLATFORMS.find((p) => p.key === key);
}

/**
 * `chrome.cookies.getAll()` 的结果 → 一条 Cookie 头。
 *
 * ⚠️ **保序、不按 name 去重**：同名不同 path 的 cookie 由浏览器自己按顺序发，
 * 我们要的就是那一条头（按 name 去重会把"更具体路径的那一份"丢掉）。
 * 只按 `name + path` 去掉**完全重复**的项（多个 URL 取并集时会撞）。
 */
export function cookieHeaderFrom(cookies) {
  const seen = new Set();
  const parts = [];
  for (const c of cookies || []) {
    if (!c || !c.name) continue;
    const id = `${c.name}\u0000${c.path || '/'}`;
    if (seen.has(id)) continue;
    seen.add(id);
    parts.push(`${c.name}=${c.value ?? ''}`);
  }
  return parts.join('; ');
}

/** 这条 cookie 串里有哪些键（保序，**原样大小写** —— 显示用） */
export function cookieKeys(cookie) {
  return (cookie || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.includes('='))
    .map((s) => s.slice(0, s.indexOf('=')).trim())
    .filter(Boolean);
}

/**
 * 判定用的键集合：**一律小写**。
 *
 * ⚠️ 与后端**同一把尺子**：`douyin_auth.cookie_keys()` 就是 `lower()` 之后比的
 * （`REQUIRED_ANY` 里列的是 `uifid_temp`/`uifidtemp`）。扩展若按原样大小写比，
 * 会出现"扩展说缺、后端其实认"的假灰按钮 —— 那是两边判据分叉，正是本仓最忌讳的形态。
 */
function lowerSet(cookie) {
  return new Set(cookieKeys(cookie).map((k) => k.toLowerCase()));
}

/**
 * 缺哪些必需键（与后端的判定一致 —— 缺了就**不要**发请求，界面直接说缺哪个）。
 *
 * ⚠️ 顺序：先普通必需键，再 `requiredAny` 的每一组（组内任一即可）；比较**不区分大小写**。
 */
export function missingKeys(platformKey, cookie) {
  const p = platformOf(platformKey);
  if (!p) return [];
  const have = lowerSet(cookie);
  const miss = (p.required || []).filter((k) => !have.has(k.toLowerCase()));
  for (const group of p.requiredAny || []) {
    if (!group.some((k) => have.has(k.toLowerCase()))) miss.push(group.join(' 或 '));
  }
  return miss;
}

/** 回执里显示"这次用到了哪些键"（只给键名，**绝不带值**；显示用扩展侧那份规范拼写） */
export function usedKeys(platformKey, cookie) {
  const p = platformOf(platformKey);
  if (!p) return [];
  const have = lowerSet(cookie);
  return (p.used || []).filter((k) => have.has(k.toLowerCase()));
}

/** `POST /auth/import` 的请求体（字段名与后端 `routers/auth.py::import_cookie` 对齐） */
export function importBody(platformKey, cookie, ua = '') {
  const p = platformOf(platformKey);
  const body = { platform: platformKey, cookie };
  // UA 只在需要它的平台上带（别的平台带了也没用，还会把"那个浏览器的指纹"多送一份）
  if (p && p.needsUa && ua) body.ua = ua;
  return body;
}

/** 一行回执文案（成功/缺键/未验证三种都给人话；界面只用它，不自己拼字符串） */
export function receiptLine(receipt) {
  if (!receipt) return '没有回执（后端没响应？）';
  const label = receipt.label || receipt.platform || '这个平台';
  if (!receipt.ok) {
    const miss = (receipt.missing || []).join('、');
    return `${label}：没同步 —— ${receipt.note || (miss ? `缺 ${miss}` : '校验没过')}`;
  }
  const keys = (receipt.keys || []).join('、');
  const tail = receipt.verified ? '已验证登录态' : '未在线验证';
  // 浏览器里读不到、由"应用已有那份"补上的键 —— **如实说出来**（用户要知道哪个键不是这次的）
  const borrowed = (receipt.from_stored || []).length
    ? `；${receipt.from_stored.join('、')} 来自应用里已有那份`
    : '';
  return `${label}：已同步 ${keys || '（没有可用键）'}（整条 ${receipt.cookie_keys ?? '?'} 个键，`
    + `${tail}）${borrowed}`;
}
/**
 * 依次探候选端口，找"这是 DDToolkit"的那一个。
 *
 * 认领靠**两个信号**：`/healthz` 的 `app === APP_IDENTIFIER`（是它），
 * 以及后续带配对 token 的导入能不能过（**端口不是身份、token 才是** ——
 * 区间里坐着的可能是另一个实例，那两个信号缺一不可）。
 *
 * `fetchImpl` 注入（node 里能测）：返回第一个命中的端口，都没命中返回 `null`。
 */
export async function discoverPort(fetchImpl, opts = {}) {
  const candidates = opts.candidates || PORT_CANDIDATES;
  const timeoutMs = opts.timeoutMs ?? 400;
  for (const port of candidates) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      const r = await fetchImpl(`http://127.0.0.1:${port}/healthz`, ctl ? { signal: ctl.signal } : {});
      if (!r || !r.ok) continue;
      const body = await r.json();
      if (body && body.app === APP_IDENTIFIER) return port;
    } catch {
      // 超时 / 连不上 / 不是 JSON：换下一个候选（**不抛** —— 探测本来就是"试着找"）
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return null;
}

/** 带超时的 POST（扩展侧唯一的网络写操作；被拦/超时都要给出人话） */
export async function postImport(fetchImpl, port, token, platformKey, cookie, ua = '', timeoutMs = 8000) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/auth/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [PAIR_HEADER]: token },
      body: JSON.stringify(importBody(platformKey, cookie, ua)),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    let body = null;
    try { body = await r.json(); } catch { /* 非 JSON：下面按状态码给话 */ }
    if (body && typeof body === 'object') return { status: r.status, receipt: body };
    return { status: r.status, receipt: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** HTTP 状态码 → 人话（界面用它把"为什么没成功"说清楚，而不是只显示数字） */
export function statusHint(status) {
  switch (status) {
    case 200: return '';
    case 400: return '';                       // 400 一定带回执，用回执里那句更准
    case 401: return '配对 token 不对 —— 到应用「设置 → 登录 → 浏览器扩展」复制当前那一条';
    case 403: return '只接受来自本机（127.0.0.1）的导入 —— 你连的不是本机的应用？';
    case 429: return '配对失败次数过多，等一分钟再试';
    default: return `应用回了 HTTP ${status}`;
  }
}
