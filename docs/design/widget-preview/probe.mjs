/* ⚠️ 小窗已整体退役（2026-10-01），整条线 2026-10-03 彻底放弃：这个文件是**设计记录**的一部分
   （样例页 `direction.html` 的几何回归探针），不是产品代码；实现在分支 `f2-widget-archive`，
   结论见 `devlog/274`。

   用法: node docs/design/widget-preview/probe.mjs [fileUrl]

   用 CDP **真实派发鼠标事件**驱动页面，只量**渲染出来的矩形**，
   不去复算页面里的代数 —— 所以"算得对但画错了"这类问题它也抓得到。

   断言的都是用户实际报过的回归（对应 `direction.html` 里的注释）：
     · 展开/收起时"贴着胶囊的那条边"位移 = 0（顶边 / 底边 / 左边缘）
     · 拖动死区 = 0（折叠态贴左、贴右、展开态贴左）
     · 贴边留白 = EDGE_M(8px)；窗口不出屏；面板高 == 窗口高
     · 贴底 ⇒ 方向向上；正中 ⇒ 方向向下

   ⚠️ 两条纪律（各自踩过一次，都写在代码里）：
     ① **必须关过渡**：无头下 transition 会把 rect 冻在中间帧，读数全是假的；
     ② **必须先断言"那件事真的发生了"再量**：否则"点击没落上"会呈现成
        "位移 = 0"的**假绿**（底边场景就栽过：胶囊在 1400 视口外，点击落空）。

   依赖本机 Edge（路径见 `EDGE`）。用法上是"跑一次、看 JSON、全部为 0 即通过"。 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const FILE = process.argv[2] ||
  'file:///E:/work/Project/DDToolkit/docs/design/widget-preview/direction.html';
const PORT = 9715;
/* 视口必须**装得下整块模拟屏 + 控制条**（屏约 1161×653 顶在 338，按钮在其下 ~1120）
   —— 否则底部场景点不到。屏尺寸由宽度定（`aspect-ratio:16/9`），加高视口不影响它。 */
const VIEW = { w: 1280, h: 1400 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = mkdtempSync(join(tmpdir(), 'ddtk-probe-'));
const child = spawn(EDGE, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDataDir}`,
  `--window-size=${VIEW.w},${VIEW.h}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method && this.handlers.has(m.method)) {
        this.handlers.get(m.method).forEach((f) => f(m.params));
        this.handlers.delete(m.method);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  once(method, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout ' + method)), timeout);
      const arr = this.handlers.get(method) || [];
      arr.push((p) => { clearTimeout(t); resolve(p); });
      this.handlers.set(method, arr);
    });
  }
}

async function targetWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p.webSocketDebuggerUrl;
    } catch { /* 等 */ }
    await sleep(200);
  }
  throw new Error('DevTools 目标没起来');
}

const MEASURE = `(function(){
  var q=function(s){var e=document.querySelector(s);if(!e)return null;
    var r=e.getBoundingClientRect(),cs=getComputedStyle(e);
    return {x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1),
            display:cs.display,vis:cs.visibility};};
  var sr=document.getElementById('screen').getBoundingClientRect();
  return JSON.stringify({
    screen:{x:+sr.x.toFixed(1),y:+sr.y.toFixed(1),w:+sr.width.toFixed(1),h:+sr.height.toFixed(1)},
    vh:window.innerHeight,
    puck:q('#puck'),cap:q('.cap-box'),panel:q('.panel'),island:q('#island'),
    open:document.getElementById('island').classList.contains('is-open'),
    up:document.getElementById('island').classList.contains('is-up')});})()`;

const main = async () => {
  const ws = new WebSocket(await targetWs());
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW.w, height: VIEW.h, deviceScaleFactor: 1, mobile: false });
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url: FILE });
  await loaded;
  await sleep(400);
  await cdp.send('Runtime.evaluate', { expression:
    `(function(){var s=document.createElement('style');s.textContent='*{transition:none !important;animation:none !important}';document.head.appendChild(s);return true;})()` });

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
    return r.result.value;
  };
  const measure = async () => JSON.parse(await ev(MEASURE));
  const mouse = async (type, x, y) => {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1, pointerType: 'mouse' });
    await sleep(25);
  };
  const centerOf = async (sel) => JSON.parse(await ev(
    `(function(){var e=document.querySelector('${sel}');var r=e.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`));
  const clickSel = async (sel, at) => {
    const pt = at || await centerOf(sel);
    if (pt.y > VIEW.h - 2) throw new Error(`PROBE INVALID: 点击点 y=${pt.y} 在视口外(${VIEW.h})`);
    await mouse('mousePressed', pt.x, pt.y); await mouse('mouseReleased', pt.x, pt.y); await sleep(180);
  };
  const preset = async (pos) => clickSel(`[data-pos="${pos}"]`);
  /* ⚠️ 内容场景用**直接的按钮**选，不靠"点几次 #cycle"——
     循环的当前位置是隐式状态，数错一次就量到另一屏（本仓栽过"读数与实物不同步"）。 */
  const scenario = async (k) => clickSel(`[data-scn="${k}"]`);
  const r1 = (n) => +n.toFixed(1);

  /* 前置判据：展开/收起 **真的发生了**才继续量；否则抛错（不给假绿） */
  const assertOpen = (m, tag) => {
    if (!m.open || m.puck.h < 50) throw new Error(`PROBE INVALID[${tag}]: 没展开 open=${m.open} puckH=${m.puck.h}`);
    if (Math.abs(m.panel.h - m.puck.h) > 0.6) throw new Error(`PROBE INVALID[${tag}]: 面板高≠窗口高 panel=${m.panel.h} puck=${m.puck.h}`);
  };
  const assertClosed = (m, tag) => {
    if (m.open || m.puck.h > 45) throw new Error(`PROBE INVALID[${tag}]: 没收起 open=${m.open} puckH=${m.puck.h}`);
  };
  const expand = async (tag) => {
    let m = await measure();
    if (!m.open) { await clickSel('#puck'); m = await measure(); }
    assertOpen(m, tag); return m;
  };
  const collapse = async (tag) => {
    let m = await measure();
    if (m.open) {
      await clickSel('#puck', { x: m.puck.x + 30, y: m.puck.y + 12 });   // 点窗口角上，避开内容
      m = await measure();
    }
    assertClosed(m, tag); return m;
  };

  const deadZone = async (sel, press, dirSign, limit = 220) => {
    await mouse('mousePressed', press.x, press.y);
    const base = (await measure())[sel].x;
    let hit = null, delta = 0;
    for (let d = 2; d <= limit; d += 2) {
      await mouse('mouseMoved', press.x + dirSign * d, press.y);
      const now = (await measure())[sel].x;
      if (hit === null && Math.abs(now - base) > 0.5) { hit = d; delta = r1(Math.abs(now - base)); }
    }
    await mouse('mouseReleased', press.x + dirSign * limit, press.y);
    return { 死区: hit === null ? `>${limit}` : hit - 2, 首步位移: delta };
  };

  const out = { url: FILE.split('/').pop() };

  /* 视口/屏自检：屏必须完整落在视口内，否则底部场景是无效测量 */
  {
    const m = await measure();
    out.自检 = { 视口: m.vh, 屏: `${m.screen.w}×${m.screen.h}`, 屏底: r1(m.screen.y + m.screen.h),
      屏在视口内: m.screen.y + m.screen.h < m.vh };
  }

  /* S1 贴顶：展开前后窗口顶边位移（用户报的"拉开一个胶囊高"） */
  await preset('0.50,0.50'); await collapse('S1前置');
  await preset('0.50,0.04');
  const a1 = await measure(); const b1 = await expand('S1');
  out.S1_顶边展开 = {
    折叠: { puckY: a1.puck.y, puckH: a1.puck.h, 离屏顶: r1(a1.puck.y - a1.screen.y) },
    展开: { puckY: b1.puck.y, puckH: b1.puck.h, 离屏顶: r1(b1.puck.y - b1.screen.y), up: b1.up, 胶囊行: b1.cap.display },
    顶边位移Δy: r1(b1.puck.y - a1.puck.y),
  };

  /* S2/S3 折叠态贴左右边：按下后要挪多少胶囊才动 */
  await collapse('S2前置');
  await preset('0.50,0.50'); await collapse('S2前置2');
  await preset('0.05,0.50');
  const s2 = await measure();
  out.S2_左中折叠拖动 = { 胶囊离屏左: r1(s2.cap.x - s2.screen.x),
    ...(await deadZone('cap', { x: s2.cap.x + s2.cap.w / 2, y: s2.cap.y + s2.cap.h / 2 }, +1)) };

  await preset('0.95,0.50');
  const s3 = await measure();
  out.S3_右中折叠拖动 = { 胶囊离屏右: r1(s3.screen.x + s3.screen.w - (s3.cap.x + s3.cap.w)),
    ...(await deadZone('cap', { x: s3.cap.x + s3.cap.w / 2, y: s3.cap.y + s3.cap.h / 2 }, -1)) };

  /* S4/S5 左边展开：窗口位移 + 展开态拖动死区 + 收起后胶囊落点 */
  await preset('0.50,0.50'); await collapse('S4前置');
  await preset('0.05,0.50');
  const c4 = await measure(); const d4 = await expand('S4');
  out.S5_左边展开 = {
    折叠窗口: { x: c4.puck.x, y: c4.puck.y }, 展开窗口: { x: d4.puck.x, y: d4.puck.y, h: d4.puck.h },
    Δx: r1(d4.puck.x - c4.puck.x), Δy: r1(d4.puck.y - c4.puck.y),
    展开后窗口离屏左: r1(d4.puck.x - d4.screen.x), 胶囊行: d4.cap.display,
  };
  out.S4_展开态贴左拖动 = await deadZone('puck', { x: d4.panel.x + 60, y: d4.panel.y + 20 }, +1);
  const e4 = await collapse('S5b');
  out.S5b_收起后胶囊落点 = { capX: e4.cap.x, 离屏左: r1(e4.cap.x - e4.screen.x), 与展开前差: r1(e4.cap.x - c4.cap.x) };

  /* S6 贴底：应向上展开，且窗口底边不动 */
  await preset('0.50,0.50'); await collapse('S6前置');
  await preset('0.50,0.96');
  const a6 = await measure(); const b6 = await expand('S6');
  out.S6_底边展开 = {
    折叠: { puckY: a6.puck.y, puckH: a6.puck.h, 离屏底: r1(a6.screen.y + a6.screen.h - (a6.puck.y + a6.puck.h)) },
    展开: { puckY: b6.puck.y, puckH: b6.puck.h, up: b6.up,
            离屏底: r1(b6.screen.y + b6.screen.h - (b6.puck.y + b6.puck.h)),
            离屏顶: r1(b6.puck.y - b6.screen.y) },
    底边位移Δ: r1((b6.puck.y + b6.puck.h) - (a6.puck.y + a6.puck.h)),
  };

  /* S7 正中 + 多条目：**这是"两个方向都装不下"的那条兜底路径**
     （面板 368px，上方可用 337.9 / 下方可用 337.9，都小于它）。
     ⚠️ 所以这里**不能**断言"近边位移 = 0" —— 按定稿口径，两个方向都装不下时
        允许夹取位移，只要求"窗口完整在屏内 + 胶囊落在窗口内"。
        装得下时则必须近边位移 = 0。判据按实际情形二选一，不然就成了假绿。 */
  await collapse('S7前置0'); await scenario('mixed');
  await preset('0.50,0.50'); await collapse('S7前置');
  const a7 = await measure(); const b7 = await expand('S7');
  {
    const capTop = a7.puck.y - a7.screen.y;
    const roomBelow = a7.screen.h - 8 - capTop;
    const roomAbove = (capTop + a7.cap.h) - 8;
    const ph = b7.panel.h;
    const onScreen = (b7.puck.y - b7.screen.y) >= 7.5
      && (b7.screen.y + b7.screen.h - (b7.puck.y + b7.puck.h)) >= 7.5;
    const capInside = a7.cap.y >= b7.puck.y - 0.6
      && (a7.cap.y + a7.cap.h) <= (b7.puck.y + b7.puck.h) + 0.6;
    const dy = r1(b7.puck.y - a7.puck.y);
    const fits = roomBelow >= ph || roomAbove >= ph;
    if (fits && Math.abs(dy) > 0.6) {
      throw new Error(`S7 断言失败: 某方向装得下(下${r1(roomBelow)}/上${r1(roomAbove)} vs 面板${ph})，近边却位移了 ${dy}px`);
    }
    if (!fits && (!onScreen || !capInside)) {
      throw new Error(`S7 断言失败: 两个方向都装不下时应夹进屏内且盖住胶囊（在屏内=${onScreen} 含胶囊=${capInside}）`);
    }
    out.S7_正中最高面板 = {
      面板高: ph, 下方可用: r1(roomBelow), 上方可用: r1(roomAbove),
      两个方向都装不下: !fits, up: b7.up, 窗口高: b7.puck.h,
      窗口离屏顶: r1(b7.puck.y - b7.screen.y),
      窗口离屏底: r1(b7.screen.y + b7.screen.h - (b7.puck.y + b7.puck.h)),
      近边位移Δy: dy, 窗口完整在屏内: onScreen, 胶囊落在窗口内: capInside,
    };
  }

  /* S8 展开态**拖到贴左**再收起：胶囊应落回左边（而不是缩回屏幕中间） */
  await preset('0.50,0.50'); await collapse('S8前置0');
  await scenario('task');                       // 换回最短的一屏，别让高面板影响拖动
  await preset('0.50,0.50'); await collapse('S8前置');
  const f8 = await expand('S8');
  {
    const press = { x: f8.panel.x + 300, y: f8.panel.y + 20 };
    await mouse('mousePressed', press.x, press.y);
    for (let d = 20; d <= 460; d += 20) await mouse('mouseMoved', press.x - d, press.y);
    await mouse('mouseReleased', press.x - 460, press.y);
    await sleep(150);
  }
  const g8 = await measure();
  const h8 = await collapse('S8b');
  out.S8_拖到贴左再收起 = {
    拖动后窗口离屏左: r1(g8.puck.x - g8.screen.x),
    收起后胶囊离屏左: r1(h8.cap.x - h8.screen.x),
  };

  /* S9 左下 + 多条目（面板最高，装不下且**不贴底**）：翻上去还是硬向下再位移 */
  await collapse('S9前置0');
  await scenario('mixed');
  await preset('0.10,0.90');
  const a9 = await measure(); const b9 = await expand('S9');
  out.S9_左下最高面板 = {
    胶囊顶离屏: r1(a9.cap.y - a9.screen.y),
    下方余: r1(a9.screen.y + a9.screen.h - 8 - (a9.cap.y + a9.cap.h)),
    面板高: b9.panel.h, up: b9.up,
    窗口顶离屏: r1(b9.puck.y - b9.screen.y),
    窗口底离屏: r1(b9.screen.y + b9.screen.h - (b9.puck.y + b9.puck.h)),
    近边位移: b9.up
      ? r1((b9.puck.y + b9.puck.h) - (a9.cap.y + a9.cap.h))     // 向上：窗口底 − 胶囊底
      : r1(b9.puck.y - a9.cap.y),                               // 向下：窗口顶 − 胶囊顶
  };

  console.log(JSON.stringify(out, null, 2));
  ws.close(); child.kill(); await sleep(300);
  try { rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
};

main().catch((e) => { console.error('PROBE FAILED:', e.message); try { child.kill(); } catch {} process.exit(1); });
